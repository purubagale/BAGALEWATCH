"""Self-service password reset (email) + change password (2026-10-02,
"Add forget password feature in login page and change password feature
after logged-in").

Two independent flows, same file (one-file-per-feature convention,
matching api_auth.py/rescue.py/issues.py):

1. `PasswordResetRequestView` / `PasswordResetConfirmView` — the
   forgot-password flow. Uses Django's own `PasswordResetTokenGenerator`
   (HMAC-based, incorporates the user's CURRENT password hash and
   `last_login` into the token, so it's automatically invalidated the
   moment the password actually changes or another successful login
   happens) -- no token storage needed anywhere, unlike the MFA-pending
   ticket in core/mfa.py, which genuinely needs a store since it isn't
   derived from anything that changes on its own.

   Deliberately returns the SAME generic response whether or not the
   submitted email matched a real account (anti-enumeration) -- the
   difference is only ever visible in the Audit Log (superadmin-only),
   via `detail`, never in the API response body.

2. `ChangePasswordView` — the logged-in self-service flow. Verifies the
   CURRENT password (`request.user.check_password()`) before allowing a
   new one; no token/email involved at all.

Both run every new password through the same `validate_password()` call
`UserWriteSerializer` already uses (2026-08-07 audit fix) -- AUTH_PASSWORD_
VALIDATORS does not run automatically just because `set_password()` was
called.
"""
from django.contrib.auth import password_validation
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.cache import cache
from django.core.mail import send_mail
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_log import log_auth_event
from .models import AuthEventLog, User

# Same shape as LoginView's own lockout counter (core/views.py) -- keyed
# by the submitted email instead of username, so a reset-request flood
# against one address (or a scripted sweep across many) can't spam the
# mail backend or a real inbox indefinitely.
RESET_REQUEST_MAX = 3
RESET_REQUEST_WINDOW_SECONDS = 15 * 60

token_generator = PasswordResetTokenGenerator()


class PasswordResetRequestView(APIView):
    """POST /api/v2/auth/password-reset/ -- body: {"email": "..."}.
    Always responds 200 with the same generic message -- see module
    docstring for why. The real outcome (matched / not / rate-limited)
    is only ever visible in the Audit Log."""
    permission_classes = [AllowAny]
    authentication_classes = []

    GENERIC_RESPONSE = {
        'detail': 'If an account with that email exists, a password reset link has been sent.',
    }

    def post(self, request):
        email = (request.data.get('email') or '').strip()
        if not email:
            return Response({'email': ['This field is required.']}, status=status.HTTP_400_BAD_REQUEST)

        cache_key = f'pwd_reset_req:{email.lower()}'
        if cache.get(cache_key, 0) >= RESET_REQUEST_MAX:
            log_auth_event(request, AuthEventLog.EVENT_PWD_RESET_REQUESTED, username=email, detail='rate_limited')
            return Response(self.GENERIC_RESPONSE)
        cache.set(cache_key, cache.get(cache_key, 0) + 1, RESET_REQUEST_WINDOW_SECONDS)

        user = User.objects.filter(email__iexact=email, is_active=True).first()
        if user is None:
            log_auth_event(request, AuthEventLog.EVENT_PWD_RESET_REQUESTED, username=email, detail='no_match')
            return Response(self.GENERIC_RESPONSE)

        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = token_generator.make_token(user)
        reset_url = f'{_frontend_origin(request)}/reset-password?uid={uid}&token={token}'
        send_mail(
            subject='DT-WATCH BTS — Password Reset',
            message=(
                f'A password reset was requested for your DT-WATCH BTS account.\n\n'
                f'Reset your password: {reset_url}\n\n'
                f'This link expires in 1 hour. If you did not request this, you can ignore this email.'
            ),
            from_email=None,  # DEFAULT_FROM_EMAIL
            recipient_list=[email],
            fail_silently=True,  # never let an SMTP hiccup leak via a 500 or a different response shape
        )
        log_auth_event(request, AuthEventLog.EVENT_PWD_RESET_REQUESTED, user=user, detail='sent')
        return Response(self.GENERIC_RESPONSE)


def _frontend_origin(request):
    # Same-origin-through-nginx convention this whole app already uses
    # (see frontend-react/nginx.conf) -- the browser reaches this API on
    # the same host/scheme it's rendering the SPA from, so that's also the
    # correct base for a link this email asks the user to click.
    return f'{request.scheme}://{request.get_host()}'


class PasswordResetConfirmView(APIView):
    """POST /api/v2/auth/password-reset/confirm/ -- body:
    {"uid": "...", "token": "...", "new_password": "..."}."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        uid = request.data.get('uid') or ''
        token = request.data.get('token') or ''
        new_password = request.data.get('new_password') or ''

        try:
            user_pk = force_str(urlsafe_base64_decode(uid))
            user = User.objects.get(pk=user_pk, is_active=True)
        except (TypeError, ValueError, OverflowError, User.DoesNotExist):
            return Response({'detail': 'This reset link is invalid.'}, status=status.HTTP_400_BAD_REQUEST)

        if not token_generator.check_token(user, token):
            log_auth_event(request, AuthEventLog.EVENT_PWD_RESET_COMPLETED, user=user, detail='invalid_or_expired_token')
            return Response({'detail': 'This reset link is invalid or has expired.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            password_validation.validate_password(new_password, user=user)
        except DjangoValidationError as exc:
            return Response({'new_password': list(exc.messages)}, status=status.HTTP_400_BAD_REQUEST)

        user.set_password(new_password)
        user.save(update_fields=['password'])
        log_auth_event(request, AuthEventLog.EVENT_PWD_RESET_COMPLETED, user=user, detail='success')
        return Response({'detail': 'Password reset successfully. You can now sign in.'})


class ChangePasswordView(APIView):
    """POST /api/v2/auth/change-password/ -- body:
    {"old_password": "...", "new_password": "..."}. Logged-in self-service,
    no email/token involved -- see module docstring."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        old_password = request.data.get('old_password') or ''
        new_password = request.data.get('new_password') or ''
        user = request.user

        if user.auth_source == 'sso':
            # Same reasoning UsersPage.tsx already applies to SSO-managed
            # accounts (core/views.py's UserWriteSerializer docstring) --
            # setting a local password on an SSO account would make it
            # reachable through local login, quietly undoing the point of SSO.
            return Response(
                {'detail': 'Your password is managed by single sign-on, not DT-WATCH.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not user.check_password(old_password):
            return Response({'old_password': ['Current password is incorrect.']}, status=status.HTTP_400_BAD_REQUEST)

        try:
            password_validation.validate_password(new_password, user=user)
        except DjangoValidationError as exc:
            return Response({'new_password': list(exc.messages)}, status=status.HTTP_400_BAD_REQUEST)

        user.set_password(new_password)
        user.save(update_fields=['password'])
        log_auth_event(request, AuthEventLog.EVENT_PWD_CHANGED, user=user, detail='success')
        return Response({'detail': 'Password changed successfully.'})
