"""Keycloak SSO configuration, one accessor per setting.

Every value is read through a function rather than imported as a constant, so
tests can patch a single accessor with `override_settings` and so a missing
value has exactly one place to define its default. Same shape as
`pms/nt-pms`'s `users/sso_config.py` — the two are meant to stay comparable.

The OIDC endpoints are DERIVED from the issuer rather than configured
individually. Keycloak's layout under `{issuer}/protocol/openid-connect/...`
is fixed, and it is what this realm's own discovery document returns, so four
separate env vars would only be four more chances to typo one. Each still has
an override for the unlikely case of a non-standard deployment.
"""
from django.conf import settings


def _s(name: str, default=''):
    return getattr(settings, name, default)


# ── Enablement ───────────────────────────────────────────────────────────

def is_enabled() -> bool:
    return bool(_s('KEYCLOAK_SSO_ENABLED', False))


def is_configured() -> bool:
    """True only when SSO can actually complete a login.

    Deliberately strict: SSO is either fully wired or entirely dark. A
    half-configured client that redirects to Keycloak and then fails at the
    callback is worse than no button at all, because the user has already
    typed their password by then.
    """
    return bool(
        is_enabled()
        and issuer()
        and client_id()
        and client_secret()
        and redirect_uri()
        and frontend_callback_url()
    )


def local_login_enabled() -> bool:
    """Whether `/auth/login/` still accepts a username and password.

    Defaults to True so adding SSO changes nothing about how anyone logs in
    today. Setting LOCAL_LOGIN_ENABLED=0 is the SSO-only cutover, and it is
    reversible by setting it back — no code change, no rebuild.
    """
    return bool(_s('LOCAL_LOGIN_ENABLED', True))


# ── Client / provider ────────────────────────────────────────────────────

def issuer() -> str:
    return (_s('KEYCLOAK_ISSUER') or '').rstrip('/')


def client_id() -> str:
    return _s('KEYCLOAK_CLIENT_ID')


def client_secret() -> str:
    return _s('KEYCLOAK_CLIENT_SECRET')


def redirect_uri() -> str:
    """Where Keycloak sends the browser back to — OUR callback, not the SPA's.

    This must match a Redirect URI registered on the Keycloak client exactly,
    including the trailing slash, or Keycloak refuses the authorize request
    before the user sees anything.
    """
    return _s('KEYCLOAK_REDIRECT_URI')


def scopes() -> str:
    """`groups` is required, not optional — it carries the claim the access
    gate and the role mapping both read. The realm publishes `groups` in its
    `scopes_supported`, so requesting it needs no realm change beyond adding
    the client scope to this client."""
    return _s('KEYCLOAK_SCOPES', 'openid profile email groups')


def signing_algs() -> list:
    algs = _s('KEYCLOAK_SIGNING_ALGS', 'RS256')
    return [a.strip() for a in str(algs).split(',') if a.strip()]


# ── Derived endpoints ────────────────────────────────────────────────────

def _endpoint(override: str, suffix: str) -> str:
    return _s(override) or (f'{issuer()}/protocol/openid-connect/{suffix}' if issuer() else '')


def authorization_endpoint() -> str:
    return _endpoint('KEYCLOAK_AUTHORIZATION_ENDPOINT', 'auth')


def token_endpoint() -> str:
    return _endpoint('KEYCLOAK_TOKEN_ENDPOINT', 'token')


def jwks_uri() -> str:
    return _endpoint('KEYCLOAK_JWKS_URI', 'certs')


def end_session_endpoint() -> str:
    return _endpoint('KEYCLOAK_END_SESSION_ENDPOINT', 'logout')


# ── Access gate + role mapping ───────────────────────────────────────────

def groups_claim() -> str:
    """Dotted path to the claim holding the user's groups.

    `groups` for a group-membership mapper; `realm_access.roles` if this realm
    ever exposes entitlement as realm roles instead. Configurable precisely so
    that switching between the two is an env edit, not a code change.
    """
    return _s('KEYCLOAK_GROUPS_CLAIM', 'groups') or 'groups'


def required_group() -> str:
    """Group a user must hold to enter DT-WATCH. Empty disables the gate.

    Empty is NOT the default: without a gate, every authenticated realm user
    could log in, which is the opposite of the requirement.
    """
    return (_s('KEYCLOAK_REQUIRED_GROUP', 'dtwatch') or '').strip()


def role_group_map() -> dict:
    """Keycloak group -> DT-WATCH role, parsed from `group:role,group:role`.

    Configuration rather than code so the realm's exact group strings
    (`platform-admin` vs `platform-admins`) do not have to be guessed
    correctly at build time. Later entries win on duplicate keys.
    """
    raw = _s('KEYCLOAK_ROLE_GROUP_MAP', 'superadmin:superadmin,platform-admins:admin,viewers:viewer')
    mapping = {}
    for pair in str(raw).split(','):
        pair = pair.strip()
        if not pair or ':' not in pair:
            continue
        group, _, role = pair.partition(':')
        group, role = group.strip(), role.strip()
        if group and role:
            mapping[group] = role
    return mapping


def default_role() -> str:
    """Role for someone in the gate group but in no mapped role group.

    `viewer` — the least privileged role. Failing closed matters here: a
    typo in KEYCLOAK_ROLE_GROUP_MAP should under-privilege people, never
    hand out `superadmin`.
    """
    return _s('KEYCLOAK_DEFAULT_ROLE', 'viewer') or 'viewer'


# ── Frontend redirect targets ────────────────────────────────────────────

def frontend_callback_url() -> str:
    return _s('SSO_FRONTEND_CALLBACK_URL')


def frontend_unauthorized_url() -> str:
    return _s('SSO_FRONTEND_UNAUTHORIZED_URL') or frontend_callback_url()


def frontend_login_url() -> str:
    """Where Keycloak sends the browser after ending the SSO session.

    Keycloak validates this against the client's "Valid post logout redirect
    URIs" and answers 400 `Invalid redirect uri` on a mismatch — a dead end
    the user reaches only at logout, which is a bad place to discover a
    config error. The live `dtwatch` client accepts
    `https://dtwatch.ntc.net.np/login` exactly (verified 2026-08-23); the
    bare origin `https://dtwatch.ntc.net.np/` is REJECTED. So this must stay
    a full URL ending in the login path, and any new deployment hostname has
    to be registered on the client before its logout will work."""
    return _s('SSO_FRONTEND_LOGIN_URL') or frontend_unauthorized_url()


# ── Redis-backed short-lived state ───────────────────────────────────────

def redis_url() -> str:
    """Reuses the same REDIS_URL the Django cache already uses (shared-redis
    DB 1 on this machine) rather than introducing a second variable that
    could drift from it."""
    return _s('REDIS_URL') or 'redis://redis:6379/1'


def state_ttl() -> int:
    """How long a started login may take to come back. Long enough to type a
    password and complete an SMS/TOTP second factor; short enough that an
    abandoned attempt does not linger."""
    return int(_s('SSO_STATE_TTL', 600))


def login_code_ttl() -> int:
    """The one-time code lives only long enough for the SPA's immediate
    exchange call — it is handed over in a redirect the browser follows at
    once, so this is deliberately very short."""
    return int(_s('SSO_LOGIN_CODE_TTL', 60))


def id_token_ttl() -> int:
    return int(_s('SSO_ID_TOKEN_TTL', 12 * 3600))


def sso_refresh_lifetime() -> int:
    """Refresh-token lifetime, in seconds, for SSO-originated sessions only.

    Shorter than the 12h local-login refresh (see SIMPLE_JWT) because the app
    mints its own tokens: a user disabled in Keycloak keeps working DT-WATCH
    tokens until their refresh expires. One hour bounds that exposure without
    storing a Keycloak credential at rest for every active user. See the
    design spec's "Session lifetime and revocation" section for the stronger
    alternative and why it was not built yet.
    """
    return int(_s('SSO_REFRESH_TOKEN_LIFETIME', 3600))
