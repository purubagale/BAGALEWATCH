"""
API Key management + authentication for the external data-exchange API
(2026-08-12, "add feature to create api to share certain data of system
to other and to receive certain data from other system"). Two distinct
concerns share this module because they're two sides of the same coin:

1. `ApiKeyAuthentication` / `require_scope()` / `ApiKeyRateThrottle` —
   used by core/external_api.py's views (mounted at `/api/external/v1/`)
   to authenticate and authorize EXTERNAL systems calling into
   DT-WATCH. Deliberately separate from the JWTAuthentication the rest
   of `/api/v2/` uses — external systems are not DT-WATCH users, have
   no role, and should never be able to log in through the normal
   `/auth/login/` flow at all.

2. `ApiKeyViewSet` — the INTERNAL admin CRUD (superadmin-only, JWT-
   authenticated like every other `/api/v2/` endpoint) for creating,
   listing, and revoking the API keys that #1 checks against. This is
   how a superadmin manages who has external access, from the new
   "API Access" admin page (ApiAccessPage.tsx).

**Auth model, per explicit user decision (AskUserQuestion, 2026-08-12):**
header-based API keys, superadmin-only management, each key scoped to a
specific subset of `ApiKey.SCOPE_CHOICES`. Chosen over OAuth2 client-
credentials (more setup, more standard, but overkill for what's currently
a small/internal NTC integration surface) and over reusing JWT login
(weaker isolation — an external system would need a real staff user
account with a role).

**Key storage** follows the same pattern GitHub/Stripe/most API-key
systems use: only a SHA-256 hash of the full key is ever persisted, plus
a short non-secret prefix for lookup/display. The full key is generated
once, returned in the create response, and NEVER retrievable again —
losing it means generating a new key, not "resetting" the old one. This
is deliberately the same one-way-hash posture already used for user
passwords in this app (see `User.password`'s docstring) rather than
something weaker just because it's "only" an API key.
"""
import hashlib
import secrets

from django.utils import timezone
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

from .models import ApiKey
from .views import IsSuperadminOnly

API_KEY_HEADER = 'HTTP_X_API_KEY'  # i.e. the `X-API-Key` request header
ALL_SCOPES = [c[0] for c in ApiKey.SCOPE_CHOICES]


def generate_api_key():
    """Returns (full_key, prefix, key_hash). Called once at creation —
    `full_key` is the only time the caller ever sees the real secret;
    only `prefix` (for lookup) and `key_hash` (for verification) are
    persisted to ApiKey. `bw_` prefix identifies this as one of our keys
    at a glance (same convention as e.g. Stripe's `sk_`/`pk_` prefixes)
    and lets `ApiKeyAuthentication` reject an obviously-wrong header
    cheaply, before ever touching the database. The `bw_` spelling
    predates the DT-WATCH rename and is deliberately kept: it is baked
    into every key already issued to an external system and into the
    `key_prefix` column, so changing it would invalidate live keys for
    nothing but cosmetics."""
    prefix = secrets.token_hex(4)  # 8 hex chars — short enough to display, long enough to not collide
    secret = secrets.token_urlsafe(32)
    full_key = f'bw_{prefix}_{secret}'
    return full_key, prefix, hash_key(full_key)


def hash_key(full_key):
    return hashlib.sha256(full_key.encode()).hexdigest()


class ApiKeyAuthentication(BaseAuthentication):
    """Reads `X-API-Key: bw_<prefix>_<secret>` and resolves it to an
    active, non-expired ApiKey row. On success, returns `(None, api_key)`
    — deliberately NOT a real Django User, so `request.user` stays
    anonymous-looking (no role, no username, `is_authenticated` is False)
    while `request.auth` carries the ApiKey instance every external view/
    permission check below actually reads. This mirrors DRF's own
    documented pattern for non-user API-key auth (a token that belongs to
    a system, not a person) — see `require_scope()` below for how
    permissions are actually enforced from `request.auth`."""

    def authenticate(self, request):
        raw = request.META.get(API_KEY_HEADER, '')
        if not raw:
            return None  # no credentials attempted — let DRF fall through to a clean 401 on the permission check
        parts = raw.split('_')
        if len(parts) < 3 or parts[0] != 'bw':
            raise AuthenticationFailed('Malformed API key.')
        prefix = parts[1]
        try:
            key = ApiKey.objects.get(key_prefix=prefix)
        except ApiKey.DoesNotExist:
            raise AuthenticationFailed('Invalid API key.')
        if hash_key(raw) != key.key_hash:
            raise AuthenticationFailed('Invalid API key.')
        if not key.is_active:
            raise AuthenticationFailed('This API key has been revoked.')
        if key.expires_at and key.expires_at <= timezone.now():
            raise AuthenticationFailed('This API key has expired.')
        # Best-effort freshness tracking for the admin page's "last used"
        # column — a single targeted UPDATE, not a full save(), so this
        # never risks clobbering a concurrent scopes/is_active edit made
        # from the admin page at the same moment.
        ApiKey.objects.filter(pk=key.pk).update(last_used_at=timezone.now())
        return (None, key)

    def authenticate_header(self, request):
        # Returning a value here is what makes DRF raise 401 (not 403)
        # when no key was supplied at all and a permission check fails —
        # see APIView.permission_denied()'s own logic.
        return 'X-API-Key'


def require_scope(scope):
    """Factory: returns a DRF permission class requiring `scope` to be
    present on the authenticating ApiKey (`request.auth`). One class per
    view (`permission_classes = [require_scope('sites:read')]`) rather
    than a single parametrized class, since DRF instantiates
    `permission_classes` entries with no constructor arguments."""
    class _RequireScope(permissions.BasePermission):
        message = f'This API key does not have the "{scope}" scope.'

        def has_permission(self, request, view):
            key = getattr(request, 'auth', None)
            return bool(key is not None and scope in (getattr(key, 'scopes', None) or []))

    _RequireScope.__name__ = f'RequireScope_{scope.replace(":", "_")}'
    return _RequireScope


class ApiKeyRateThrottle(SimpleRateThrottle):
    """Per-key rate limit for the external API — deliberately separate
    from DRF's built-in User/Anon throttles (those key off `request.user`,
    which is always anonymous for API-key auth here, see
    `ApiKeyAuthentication`). Rate is generous but bounded (see settings.py's
    `DEFAULT_THROTTLE_RATES['external_api']`) — this is a small internal-
    NTC integration surface, not a public rate-limited SaaS API, so the
    goal is "stop a misbehaving integration from hammering the DB," not
    fine-grained tiering."""
    scope = 'external_api'

    def get_cache_key(self, request, view):
        key = getattr(request, 'auth', None)
        if key is None:
            # Unauthenticated requests are rejected by the permission
            # check (401/403), not throttled — nothing to key a shared
            # "anonymous" bucket off that wouldn't just let one bad actor
            # exhaust it for every other not-yet-authenticated caller.
            return None
        return self.cache_format % {'scope': self.scope, 'ident': key.key_prefix}


# ── Internal admin CRUD (superadmin-only, JWT-authenticated) ────────────

class ApiKeySerializer(serializers.ModelSerializer):
    """Read shape — NEVER includes `key_hash`, and can't include the full
    key at all (it was never stored — see `generate_api_key`'s
    docstring). Used for the list/retrieve/update responses on the admin
    page; `ApiKeyViewSet.create()` below is the one exception that adds
    the plaintext key into this same shape, exactly once."""
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = ApiKey
        fields = [
            'id', 'name', 'key_prefix', 'scopes', 'is_active',
            'created_at', 'last_used_at', 'expires_at', 'created_by_name',
        ]
        read_only_fields = ['id', 'key_prefix', 'created_at', 'last_used_at']

    def get_created_by_name(self, obj):
        if not obj.created_by_id:
            return None
        return obj.created_by.name or obj.created_by.username

    def validate_scopes(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError('Select at least one scope.')
        bad = [s for s in value if s not in ALL_SCOPES]
        if bad:
            raise serializers.ValidationError(f'Unknown scope(s): {", ".join(bad)}.')
        return value


class ApiKeyViewSet(viewsets.ModelViewSet):
    """`/api/v2/api-keys/` — superadmin-only management of external API
    credentials (2026-08-12), matching this app's usual superadmin-gated-
    admin-page convention (Users, Menu Admin, Permissions, Branding).

    No PUT, only PATCH (`http_method_names` below) — `scopes`/`name`/
    `is_active`/`expires_at` can be edited after creation (none of those
    are secret), but `key_prefix`/`key_hash` are immutable once set
    (enforced by `read_only_fields` above), so there's never a sensible
    "replace the whole object" PUT to support.

    The full plaintext key is returned ONLY from `create()` — see
    `perform_create`/`create` below — and never again from any GET.
    Losing it means creating a new key and updating the external system's
    config, not "viewing it again" or "resetting" it.
    """
    queryset = ApiKey.objects.all()
    serializer_class = ApiKeySerializer
    permission_classes = [IsAuthenticated, IsSuperadminOnly]
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def perform_create(self, serializer):
        full_key, prefix, key_hash = generate_api_key()
        serializer.save(key_prefix=prefix, key_hash=key_hash, created_by=self.request.user)
        # Stashed on the in-memory instance only (never a model field,
        # never saved) purely so create() below can include it in this
        # one response.
        serializer.instance._plaintext_key = full_key

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        data = dict(serializer.data)
        data['key'] = serializer.instance._plaintext_key
        headers = self.get_success_headers(serializer.data)
        return Response(data, status=status.HTTP_201_CREATED, headers=headers)
