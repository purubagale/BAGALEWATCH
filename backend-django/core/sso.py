"""Keycloak OIDC broker helpers (Authorization Code + PKCE, server-side).

DT-WATCH brokers the whole OIDC flow: it drives the authorize redirect,
exchanges the code, validates the ID token against Keycloak's JWKS, and then
`sso_views` mints the app's OWN SimpleJWT. Keycloak authenticates; DT-WATCH
keeps authorization. Nothing downstream — DRF auth classes, the permissions
matrix, `IsAdminOrSuperadmin`, the frontend's refresh interceptor — needs to
know SSO exists.

Redis holds three short-lived artifacts:

* the OIDC *transaction* (state -> {verifier, nonce}) between login and callback
* the one-time *login code* (code -> {access, refresh}) handed to the SPA
* the Keycloak *ID token*, retained only to support RP-initiated logout later

Ported from `pms/nt-pms`'s `users/sso.py`, which already runs this flow against
this same realm. Kept close to the original on purpose so the two stay
comparable; the DT-WATCH-specific parts are the group gate, the role mapping,
and `resolve_user`. All configuration is read through `core.sso_config`.
"""
import base64
import hashlib
import json
import logging
import secrets
from urllib.parse import urlencode

import jwt
import redis
import requests
from django.db import transaction
from jwt import PyJWKClient

from . import sso_config as cfg
from .models import User

logger = logging.getLogger(__name__)

# Namespaced Redis keys.
_TXN_PREFIX = 'sso:txn:'
_CODE_PREFIX = 'sso:code:'
_IDTOKEN_PREFIX = 'sso:idtoken:'

# Cookie that binds the OIDC `state` to the browser that started the flow.
# The callback requires this cookie to match the `state` query param. `state`
# alone only prevents replay; the cookie is what prevents login-CSRF, where an
# attacker completes a login in someone else's browser.
STATE_COOKIE = 'sso_state'

# HTTP timeout (seconds) for server-to-Keycloak calls.
_HTTP_TIMEOUT = 10


class SSOError(Exception):
    """A recoverable failure in the SSO flow (bad token, no group, expired
    transaction). Views translate `code` into a coarse reason on the redirect
    back to the SPA; the detailed message stays in the server log so the
    response cannot be used to enumerate accounts."""

    def __init__(self, message, code='sso_error'):
        super().__init__(message)
        self.code = code


# ── Redis + JWKS singletons (lazy, module-level) ─────────────────────────

_redis_client = None
_jwks_client = None
_jwks_uri_cached = None


def _redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(cfg.redis_url(), decode_responses=True)
    return _redis_client


def _jwks():
    """Cached PyJWKClient — caches signing keys and follows `kid` rotation, so
    a normal login does not fetch the JWKS every time. Rebuilt if the
    configured URI changes (which in practice only happens in tests)."""
    global _jwks_client, _jwks_uri_cached
    uri = cfg.jwks_uri()
    if _jwks_client is None or _jwks_uri_cached != uri:
        _jwks_client = PyJWKClient(uri, cache_keys=True)
        _jwks_uri_cached = uri
    return _jwks_client


def reset_clients():
    """Drop the cached Redis/JWKS clients. For tests, which change config
    between cases and must not inherit a client built from the previous one."""
    global _redis_client, _jwks_client, _jwks_uri_cached
    _redis_client = None
    _jwks_client = None
    _jwks_uri_cached = None


# ── PKCE ─────────────────────────────────────────────────────────────────

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _pkce_pair():
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode('ascii')).digest())
    return verifier, challenge


# ── OIDC transaction store ───────────────────────────────────────────────

def build_authorize_url(next_path: str = ''):
    """Create a fresh OIDC transaction. Returns ``(authorize_url, state)``.

    The caller must put `state` in a browser cookie so the callback can bind
    the response to the browser that started the flow.
    """
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier, challenge = _pkce_pair()

    _redis().setex(
        _TXN_PREFIX + state,
        cfg.state_ttl(),
        json.dumps({'verifier': verifier, 'nonce': nonce, 'next': next_path or ''}),
    )

    params = {
        'client_id': cfg.client_id(),
        'response_type': 'code',
        'scope': cfg.scopes(),
        'redirect_uri': cfg.redirect_uri(),
        'state': state,
        'nonce': nonce,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    }
    return f'{cfg.authorization_endpoint()}?{urlencode(params)}', state


def pop_transaction(state: str) -> dict:
    """Consume the transaction for `state` (single use). Raises on miss."""
    if not state:
        raise SSOError('Missing state parameter', code='bad_state')
    key = _TXN_PREFIX + state
    raw = _redis().getdel(key)
    if raw is None:
        raise SSOError('SSO transaction expired or invalid', code='bad_state')
    return json.loads(raw)


# ── Token exchange + ID-token validation ─────────────────────────────────

def exchange_code(code: str, verifier: str) -> dict:
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': cfg.redirect_uri(),
        'client_id': cfg.client_id(),
        'client_secret': cfg.client_secret(),
        'code_verifier': verifier,
    }
    try:
        resp = requests.post(cfg.token_endpoint(), data=data, timeout=_HTTP_TIMEOUT)
    except requests.RequestException as exc:
        logger.error('Keycloak token exchange failed: %s', exc)
        raise SSOError('Could not reach the identity provider', code='idp_unreachable')

    if resp.status_code != 200:
        logger.warning('Keycloak token endpoint returned %s: %s', resp.status_code, resp.text[:500])
        raise SSOError('Token exchange rejected by identity provider', code='token_exchange_failed')
    return resp.json()


def verify_id_token(id_token: str, nonce: str = None) -> dict:
    """Validate the ID token's signature against JWKS plus the standard
    claims, and return them. `aud` and `iss` are both enforced — checking the
    signature alone would accept a validly-signed token minted for a
    different client in the same realm."""
    if not id_token:
        raise SSOError('No id_token returned by identity provider', code='no_id_token')
    try:
        signing_key = _jwks().get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=cfg.signing_algs(),
            audience=cfg.client_id(),
            issuer=cfg.issuer(),
            options={'require': ['exp', 'iat', 'iss', 'aud']},
        )
    except jwt.PyJWTError as exc:
        logger.warning('ID token validation failed: %s', exc)
        raise SSOError('Invalid ID token', code='invalid_id_token')

    if nonce is not None and claims.get('nonce') != nonce:
        raise SSOError('ID token nonce mismatch', code='nonce_mismatch')
    return claims


# ── Claims: groups, the access gate, and the role mapping ────────────────

def _claim_by_path(claims: dict, dotted_path: str):
    node = claims
    for part in dotted_path.split('.'):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _group_aliases(raw: str) -> set:
    """Every spelling one Keycloak group entry could be configured as.

    Keycloak's group-membership mapper emits `dtwatch` or `/dtwatch` depending
    on whether "Full group path" is on, and nested groups arrive as
    `/parent/child`. Matching on the raw string alone means flipping that one
    mapper checkbox silently denies everyone. So a claim entry matches if the
    configured name equals its full path OR its last segment.
    """
    cleaned = (raw or '').strip().strip('/')
    if not cleaned:
        return set()
    return {cleaned, cleaned.rsplit('/', 1)[-1]}


def get_groups(claims: dict) -> list:
    groups = _claim_by_path(claims, cfg.groups_claim())
    if not isinstance(groups, (list, tuple)):
        return []
    return [str(g) for g in groups]


def _normalized_groups(claims: dict) -> set:
    out = set()
    for entry in get_groups(claims):
        out |= _group_aliases(entry)
    return out


def has_required_group(claims: dict) -> bool:
    """True when no group is required, or the required group is present."""
    required = cfg.required_group()
    if not required:
        return True
    return bool(_group_aliases(required) & _normalized_groups(claims))


def map_role(claims: dict) -> str:
    """Highest-privilege role among the user's mapped groups.

    Ranked explicitly rather than by dict order: two mapped groups on one user
    (someone in both `superadmin` and `viewers`) must resolve deterministically
    to the higher role, not to whichever the claim happened to list first.
    """
    precedence = ['superadmin', 'admin', 'viewer']
    mapping = cfg.role_group_map()
    present = _normalized_groups(claims)

    matched = {
        role for group, role in mapping.items()
        if _group_aliases(group) & present
    }
    for role in precedence:
        if role in matched:
            return role
    # A configured role outside the known tiers (should not happen, but do not
    # silently discard it) then the safe default.
    return next(iter(matched), cfg.default_role())


# ── User resolution: link or create ──────────────────────────────────────

def resolve_user(claims: dict):
    """Find or create the DT-WATCH user for these claims. Returns (user, created).

    Order matters:

    1. `sso_subject` — Keycloak's `sub` is the only identifier stable across
       username and email changes, so an already-linked account is found even
       if the person was renamed in the realm.
    2. username + a VERIFIED matching email. Auto-linking on an unverified
       email is a known account-takeover path (anyone able to register that
       username in the realm would inherit the DT-WATCH account and its
       history), so an unverified match is refused rather than linked.
    3. Otherwise create the account. Membership of the gate group IS the
       entitlement here, unlike PMS where accounts are admin-created.

    The role is re-applied from Keycloak on every login, since the user chose
    Keycloak as the source of truth.
    """
    sub = (claims.get('sub') or '').strip()
    if not sub:
        raise SSOError('ID token has no subject claim', code='no_subject')

    username = (claims.get('preferred_username') or '').strip()
    if not username:
        raise SSOError('ID token has no preferred_username claim', code='no_username')

    email = (claims.get('email') or '').strip()
    email_verified = bool(claims.get('email_verified'))
    full_name = (claims.get('name') or '').strip()
    role = map_role(claims)

    with transaction.atomic():
        user = User.objects.filter(sso_subject=sub).first()
        created = False

        if user is None:
            existing = User.objects.filter(username__iexact=username).first()
            if existing is not None:
                same_email = (
                    email
                    and existing.email
                    and email.lower() == existing.email.strip().lower()
                )
                if not (email_verified and same_email):
                    logger.warning(
                        'Refusing to link SSO subject to existing local user %r '
                        '(email_verified=%s, emails_match=%s) — needs a verified '
                        'matching email',
                        existing.username, email_verified, bool(same_email),
                    )
                    raise SSOError(
                        'An account with this username already exists and could '
                        'not be verified as the same person',
                        code='link_conflict',
                    )
                user = existing
            else:
                user = User(username=username)
                # No usable password: a JIT-created SSO account must not be
                # loggable-into through /auth/login/, even while local login
                # is still switched on.
                user.set_unusable_password()
                created = True

        user.sso_subject = sub
        user.auth_source = User.AUTH_SOURCE_SSO
        user.role = role
        if email:
            user.email = email
        if full_name:
            user.name = full_name
        user.save()

    return user, created


# ── One-time login code ──────────────────────────────────────────────────

def create_login_code(access: str, refresh: str, user_id: int) -> str:
    code = secrets.token_urlsafe(32)
    _redis().setex(
        _CODE_PREFIX + code,
        cfg.login_code_ttl(),
        json.dumps({'access': access, 'refresh': refresh, 'user_id': user_id}),
    )
    return code


def consume_login_code(code: str) -> dict:
    if not code:
        raise SSOError('Missing login code', code='bad_login_code')
    # GETDEL makes this single-use even under concurrent requests — two
    # parallel exchanges cannot both succeed.
    raw = _redis().getdel(_CODE_PREFIX + code)
    if raw is None:
        raise SSOError('Login code expired or already used', code='bad_login_code')
    return json.loads(raw)


# ── Keycloak ID-token retention (for RP-initiated logout) ────────────────
#
# The SPA only ever holds the app's own JWT, never Keycloak's. To offer a real
# sign-out later — ending the Keycloak browser session rather than just the
# DT-WATCH one — the backend retains the ID token server-side to use as
# `id_token_hint`. Best-effort: if it is missing or expired, logout simply
# stays DT-WATCH-only, exactly as it behaves for a local login today.

def store_id_token(user_id: int, id_token: str) -> None:
    if not id_token:
        return
    _redis().setex(f'{_IDTOKEN_PREFIX}{user_id}', cfg.id_token_ttl(), id_token)


def get_id_token(user_id: int):
    return _redis().get(f'{_IDTOKEN_PREFIX}{user_id}')


def pop_id_token(user_id: int):
    """Read-and-delete: the ID token has exactly one job, and once it has
    been spent on an end-session URL, leaving it in Redis for the rest of its
    12h TTL only widens the window in which a stale copy could be reused."""
    return _redis().getdel(f'{_IDTOKEN_PREFIX}{user_id}')


def end_session_url_for(user) -> str:
    """The Keycloak logout URL for `user`, or '' when there is nothing to end.

    Returns '' — never raises — for a local-password account, for an SSO
    account whose retained ID token has expired or was already spent, and
    when SSO is switched off entirely. Sign-out must always succeed locally
    even when the Keycloak leg cannot happen, so every failure here is
    silent by design and the caller simply falls back to a DT-WATCH-only
    logout.

    KNOWN LIMIT: the ID token is stored per USER, not per session, so the
    same account signed in from two browsers keeps only the newer token —
    logging out in the older browser ends the newer browser's Keycloak
    session instead of its own. Fixing that needs the session id (`sid`)
    plumbed through the login code and back from the SPA; both nt-pms and
    dutychart share this wart."""
    if not cfg.is_enabled():
        return ''
    if getattr(user, 'auth_source', '') != 'sso':
        return ''
    id_token = pop_id_token(user.pk)
    if not id_token:
        return ''
    return build_end_session_url(id_token, cfg.frontend_login_url())


def build_end_session_url(id_token: str, post_logout_redirect_uri: str) -> str:
    params = {
        'id_token_hint': id_token,
        'client_id': cfg.client_id(),
    }
    # Keycloak requires an ABSOLUTE post-logout URI and validates it against
    # the client's registered list, answering 400 `Invalid redirect uri` on a
    # mismatch. The app's other redirect targets are happily relative
    # ('/login' is the settings default, and works fine as a same-origin
    # browser redirect), so a deployment that never set an absolute
    # SSO_FRONTEND_LOGIN_URL would send one here and dead-end the user on a
    # Keycloak error page — at sign-out, the worst moment to discover it.
    #
    # Omitting the parameter is the graceful degradation: Keycloak still ends
    # the session and shows its own "You are logged out" page instead of an
    # error. The session — the thing that actually matters — ends either way.
    if post_logout_redirect_uri.startswith(('http://', 'https://')):
        params['post_logout_redirect_uri'] = post_logout_redirect_uri
    return f'{cfg.end_session_endpoint()}?{urlencode(params)}'
