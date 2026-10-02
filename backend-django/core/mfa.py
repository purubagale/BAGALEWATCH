"""TOTP-based multi-factor authentication (2026-10-02, Phase C of the auth
security hardening pass -- "Add MFA feature... controlled by superadmin
only such that they can change the option to mandatory or optional").

Three independent pieces:

1. Enrollment (`MFAEnrollStartView`/`MFAEnrollConfirmView`/`MFADisableView`,
   all `IsAuthenticated`) -- any logged-in user can turn TOTP on or off for
   their own account at any time, regardless of whether it's currently
   mandatory server-wide (`SecuritySettings.mfa_required`, core/views.py's
   `SecuritySettingsView`). A freshly generated secret is held in Redis,
   NOT written to the user row, until `MFAEnrollConfirmView` proves the
   user actually loaded it into a real authenticator app by generating a
   valid code from it -- persisting an unconfirmed secret would risk
   locking an account out the moment MFA becomes mandatory, if the QR scan
   never actually worked.

2. Login-time verification (`create_pending_ticket`/`MFAVerifyView`) --
   `core.views.LoginView.post()` mints a short-lived, single-use ticket
   (Redis `SETEX` + `GETDEL`, same shape as `core/sso.py`'s one-time login
   code) instead of calling `_finish_login()` directly whenever the
   authenticating user has `totp_enabled=True`. `MFAVerifyView` is the
   second request: ticket + code in, and only on a correct code does it
   call the SAME `_finish_login()` LoginView would have called directly
   with MFA off. The ticket is consumed (deleted) on first use regardless
   of whether the code was right, so a guessed/replayed ticket gets at
   most one code attempt -- same "can't be retried past one failure"
   posture LoginView's own lockout counter already has for passwords. A
   wrong code means starting over from `/auth/login/`, not a second try
   on the same ticket.

3. Secret encryption (`encrypt_secret`/`decrypt_secret`) -- Fernet, with
   the key derived from `settings.SECRET_KEY` by hashing it down to
   exactly 32 bytes. Deliberately not a separate `TOTP_ENCRYPTION_KEY` env
   var: this app already has exactly one long-lived secret every
   deployment must keep safe (`SECRET_KEY`), and introducing a second one
   that also must never leak or rotate unexpectedly (rotating it would
   silently invalidate every enrolled user's stored secret, logging them
   all out of MFA with no warning) is a bigger operational footgun than
   deriving from the one that already exists.

Entirely outside this module's reach: SSO/Keycloak-authenticated users.
`sso_views.py`'s token-exchange path never calls into here at all --
Keycloak owns that authentication independently, and if it enforces its
own MFA, that's already outside what DT-WATCH can see or control.
"""
import base64
import hashlib
import io
import json
import secrets

import pyotp
import qrcode
import redis
from django.conf import settings
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_log import log_auth_event
from .models import AuthEventLog, SecuritySettings, User
from .views import _finish_login

# Namespaced Redis keys, same convention as core/sso.py's _TXN_PREFIX/_CODE_PREFIX.
_PENDING_PREFIX = 'mfa:pending:'  # enrollment-in-progress secret, keyed by user id
_TICKET_PREFIX = 'mfa:ticket:'    # post-password, pre-token login ticket

# 10 minutes to scan a QR code into an authenticator app and type back one
# code -- long enough for a real human, short enough that an abandoned
# enrollment attempt doesn't leave an unconfirmed secret sitting around.
_PENDING_TTL = 10 * 60
# 5 minutes to complete the second login step -- mirrors sso_config's own
# short-lived transaction/login-code TTLs for the same class of "half of a
# two-step flow" state.
_TICKET_TTL = 5 * 60

_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def _fernet():
    from cryptography.fernet import Fernet
    digest = hashlib.sha256(settings.SECRET_KEY.encode('utf-8')).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode('ascii')).decode('ascii')


def decrypt_secret(token: str) -> str:
    return _fernet().decrypt(token.encode('ascii')).decode('ascii')


def _qr_data_url(uri: str) -> str:
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


# ── Enrollment (voluntary, any already-authenticated user) ────────────────

class MFAStatusView(APIView):
    """GET /api/v2/auth/mfa/status/ -- lets the Security page know whether
    to show "Enable MFA" or "Disable MFA" for this account, and whether
    enrollment is currently mandatory server-wide (so it can say so, even
    though it can't force a GET to do anything by itself)."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        security, _ = SecuritySettings.objects.get_or_create(pk=1)
        return Response({
            'totp_enabled': request.user.totp_enabled,
            'mfa_required': security.mfa_required,
        })


class MFAEnrollStartView(APIView):
    """POST /api/v2/auth/mfa/enroll/start/ -- generates a NEW TOTP secret
    and returns it (QR code + manual-entry string) WITHOUT touching the
    user row -- see module docstring for why confirmation is a separate,
    required second step."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        secret = pyotp.random_base32()
        _redis().setex(_PENDING_PREFIX + str(request.user.id), _PENDING_TTL, secret)
        uri = pyotp.totp.TOTP(secret).provisioning_uri(
            name=request.user.username, issuer_name='DT-WATCH BTS',
        )
        return Response({'secret': secret, 'qr_data_url': _qr_data_url(uri)})


class MFAEnrollConfirmView(APIView):
    """POST /api/v2/auth/mfa/enroll/confirm/ -- body: {"code": "123456"}.
    Verifies the pending secret from MFAEnrollStartView against a real
    generated code; only on success is it encrypted and saved with
    totp_enabled=True."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = (request.data.get('code') or '').strip()
        secret = _redis().get(_PENDING_PREFIX + str(request.user.id))
        if not secret:
            return Response(
                {'detail': 'No enrollment in progress, or it expired. Start again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not pyotp.TOTP(secret).verify(code, valid_window=1):
            log_auth_event(request, AuthEventLog.EVENT_MFA_VERIFY_FAILED, user=request.user, detail='enroll_confirm')
            return Response(
                {'detail': 'Incorrect code. Check your authenticator app and try again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        request.user.totp_secret_encrypted = encrypt_secret(secret)
        request.user.totp_enabled = True
        request.user.save(update_fields=['totp_secret_encrypted', 'totp_enabled'])
        _redis().delete(_PENDING_PREFIX + str(request.user.id))
        log_auth_event(request, AuthEventLog.EVENT_MFA_ENROLLED, user=request.user)
        return Response({'detail': 'MFA enabled.'})


class MFADisableView(APIView):
    """POST /api/v2/auth/mfa/disable/ -- body: {"code": "123456"}. Requires
    a current valid code, not a bare toggle -- disabling MFA is itself a
    security-relevant action and a hijacked-but-not-TOTP-holding session
    shouldn't be able to do it alone. If SecuritySettings.mfa_required is
    on, this still succeeds, but the user is routed straight back through
    the forced-enrollment prompt on their very next login, same as anyone
    who has never enrolled."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user
        if not user.totp_enabled:
            return Response({'detail': 'MFA is not enabled.'}, status=status.HTTP_400_BAD_REQUEST)
        code = (request.data.get('code') or '').strip()
        secret = decrypt_secret(user.totp_secret_encrypted)
        if not pyotp.TOTP(secret).verify(code, valid_window=1):
            log_auth_event(request, AuthEventLog.EVENT_MFA_VERIFY_FAILED, user=user, detail='disable')
            return Response({'detail': 'Incorrect code.'}, status=status.HTTP_400_BAD_REQUEST)
        user.totp_secret_encrypted = ''
        user.totp_enabled = False
        user.save(update_fields=['totp_secret_encrypted', 'totp_enabled'])
        log_auth_event(request, AuthEventLog.EVENT_MFA_DISABLED, user=user)
        return Response({'detail': 'MFA disabled.'})


# ── Login-time verification (after password, before tokens) ───────────────

def create_pending_ticket(user_id: int) -> str:
    ticket = secrets.token_urlsafe(32)
    _redis().setex(_TICKET_PREFIX + ticket, _TICKET_TTL, json.dumps({'user_id': user_id}))
    return ticket


def _consume_ticket(ticket: str):
    # GETDEL, same single-use-under-concurrency guarantee as sso.py's
    # consume_login_code -- two parallel verify attempts for the same
    # ticket cannot both succeed.
    raw = _redis().getdel(_TICKET_PREFIX + ticket)
    if raw is None:
        return None
    return json.loads(raw)['user_id']


class MFAVerifyView(APIView):
    """POST /api/v2/auth/mfa/verify/ -- body: {"mfa_ticket": "...", "code":
    "123456"}. The second step of a login for a user with totp_enabled=True
    (core.views.LoginView.post() mints the ticket instead of calling
    _finish_login() directly). See module docstring for the single-use
    ticket semantics -- a wrong code means going back to /auth/login/ for a
    fresh one, not a second attempt here."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        ticket = request.data.get('mfa_ticket') or ''
        code = (request.data.get('code') or '').strip()
        user_id = _consume_ticket(ticket)
        if user_id is None:
            return Response(
                {'detail': 'This login attempt has expired. Please sign in again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            user = User.objects.get(pk=user_id, is_active=True)
        except User.DoesNotExist:
            return Response(
                {'detail': 'This login attempt has expired. Please sign in again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not user.totp_enabled:
            return Response({'detail': 'MFA is not set up for this account.'}, status=status.HTTP_400_BAD_REQUEST)
        secret = decrypt_secret(user.totp_secret_encrypted)
        if not pyotp.TOTP(secret).verify(code, valid_window=1):
            log_auth_event(request, AuthEventLog.EVENT_MFA_VERIFY_FAILED, user=user, detail='login')
            return Response({'detail': 'Incorrect code.'}, status=status.HTTP_400_BAD_REQUEST)

        return _finish_login(request, user)
