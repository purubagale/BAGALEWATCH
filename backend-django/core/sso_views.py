"""Keycloak SSO endpoints (OIDC Authorization Code + PKCE, brokered server-side).

Keycloak performs authentication; DT-WATCH keeps authorization. After
validating Keycloak's ID token these views mint the app's own SimpleJWT and
return it in EXACTLY the shape `LoginView` already returns, so `AuthContext`,
`client.ts`'s refresh interceptor, the permissions matrix and every existing
permission class keep working with no changes at all. That response-shape
match is the single thing that keeps this feature small.

Routes (mounted under /api/v2/auth/sso/ in core/urls.py):
    GET  login/     -> 302 to Keycloak authorize
    GET  callback/  -> validate, mint app JWT, 302 to the SPA with a one-time code
    POST token/     -> exchange the one-time code for {..., access, refresh}
"""
import logging
from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from . import sso
from . import sso_config as cfg
from .models import User
from .serializers import MeSerializer

logger = logging.getLogger(__name__)


def _redirect_to_spa(reason: str) -> HttpResponseRedirect:
    """Send the browser back to the SPA with a coarse reason code.

    Deliberately non-specific: the reason distinguishes "you are not in the
    dtwatch group" from "SSO is misconfigured" for the user's benefit, but
    never reveals whether an account exists. Specifics go to the log.
    """
    base = cfg.frontend_unauthorized_url()
    if not base:
        # Nothing configured to redirect to — say so plainly rather than
        # emitting a 302 to an empty URL, which surfaces as a blank page.
        return Response(
            {'detail': 'SSO is not configured on this server.'},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    sep = '&' if '?' in base else '?'
    return HttpResponseRedirect(f'{base}{sep}{urlencode({"sso_error": reason})}')


def _mint_tokens(user):
    """Mint the app's own SimpleJWT for an SSO-authenticated user.

    The refresh lifetime is overridden to SSO_REFRESH_TOKEN_LIFETIME (1h by
    default) rather than the 12h SIMPLE_JWT default. Because DT-WATCH issues
    its own tokens, a user disabled in Keycloak keeps working DT-WATCH tokens
    until their refresh expires; shortening it for SSO sessions bounds that
    window without storing a Keycloak credential at rest. `set_exp` must run
    before `.access_token` is read, since that property derives a new token
    from the refresh token's current claims.
    """
    refresh = RefreshToken.for_user(user)
    refresh.set_exp(lifetime=timedelta(seconds=cfg.sso_refresh_lifetime()))
    return str(refresh.access_token), str(refresh)


class SSOLoginView(APIView):
    """Begin the OIDC flow: redirect the browser to Keycloak."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        if not cfg.is_configured():
            logger.error('SSO login requested but SSO is not configured/enabled')
            return Response(
                {'detail': 'Single sign-on is not configured on this server.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        authorize_url, state = sso.build_authorize_url()
        resp = HttpResponseRedirect(authorize_url)
        # Bind `state` to this browser. secure=False under DEBUG so the cookie
        # survives plain http://dtwatch.ntc.net.np:5180 during local testing;
        # HTTPS-only otherwise.
        resp.set_cookie(
            sso.STATE_COOKIE, state,
            max_age=cfg.state_ttl(),
            httponly=True,
            secure=not settings.DEBUG,
            samesite='Lax',
            path='/',
        )
        return resp


class SSOCallbackView(APIView):
    """Keycloak redirects here with ?code&state. Validate, resolve the user,
    mint the app JWT, and hand the SPA a one-time code — never the tokens
    themselves, which would otherwise sit in a URL and in browser history."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        def _done(response):
            # Always clear the state cookie on the way out, success or not.
            if hasattr(response, 'delete_cookie'):
                response.delete_cookie(sso.STATE_COOKIE, path='/')
            return response

        if not cfg.is_configured():
            return _done(_redirect_to_spa('sso_unavailable'))

        # Keycloak-reported errors (user cancelled, consent denied, ...).
        if request.GET.get('error'):
            logger.info('SSO callback error from Keycloak: %s', request.GET.get('error'))
            return _done(_redirect_to_spa('idp_error'))

        code = request.GET.get('code')
        state = request.GET.get('state')
        if not code or not state:
            return _done(_redirect_to_spa('bad_request'))

        # Login-CSRF protection: `state` must match the cookie set at login.
        cookie_state = request.COOKIES.get(sso.STATE_COOKIE)
        if not cookie_state or cookie_state != state:
            logger.warning('SSO callback state/cookie mismatch (possible login CSRF)')
            return _done(_redirect_to_spa('bad_state'))

        try:
            txn = sso.pop_transaction(state)
            tokens = sso.exchange_code(code, txn['verifier'])
            claims = sso.verify_id_token(tokens.get('id_token'), nonce=txn.get('nonce'))
        except sso.SSOError as exc:
            logger.warning('SSO callback rejected: %s (%s)', exc, exc.code)
            return _done(_redirect_to_spa(exc.code))

        # Access gate. Logged with enough context to diagnose a realm
        # misconfiguration (wrong claim path, mapper emitting full paths)
        # without having to reproduce the login.
        if not sso.has_required_group(claims):
            logger.warning(
                'SSO user lacks required group %r. groups_claim=%r groups_found=%r claim_keys=%r',
                cfg.required_group(), cfg.groups_claim(),
                sso.get_groups(claims), sorted(claims.keys()),
            )
            return _done(_redirect_to_spa('no_app_access'))

        try:
            user, created = sso.resolve_user(claims)
        except sso.SSOError as exc:
            logger.warning('SSO user resolution failed: %s (%s)', exc, exc.code)
            return _done(_redirect_to_spa(exc.code))

        if not user.is_active:
            logger.info('SSO login for disabled DT-WATCH account %s', user.username)
            return _done(_redirect_to_spa('inactive_user'))

        user.last_login = timezone.now()
        user.save(update_fields=['last_login'])

        logger.info(
            'SSO login: user=%s role=%s created=%s', user.username, user.role, created
        )

        # Retained server-side only, so a later logout can also end the
        # Keycloak session. The SPA never sees this token.
        sso.store_id_token(user.pk, tokens.get('id_token'))

        access, refresh = _mint_tokens(user)
        login_code = sso.create_login_code(access=access, refresh=refresh, user_id=user.pk)

        base = cfg.frontend_callback_url()
        sep = '&' if '?' in base else '?'
        return _done(HttpResponseRedirect(f'{base}{sep}{urlencode({"code": login_code})}'))


class SSOTokenExchangeView(APIView):
    """SPA posts the one-time code; return the same payload `/auth/login/`
    returns, so the frontend's existing login path handles it unchanged."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        try:
            bundle = sso.consume_login_code(request.data.get('code'))
        except sso.SSOError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        user = User.objects.filter(pk=bundle.get('user_id')).first()
        if user is None or not user.is_active:
            # The account changed between callback and exchange.
            return Response(
                {'detail': 'This account is no longer active.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        data = MeSerializer(user).data
        data['access'] = bundle['access']
        data['refresh'] = bundle['refresh']
        return Response(data)
