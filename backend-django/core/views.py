import shutil

import redis
from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.core.cache import cache
from django.db import connection, transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.utils import timezone

from django.core.files.base import ContentFile
from rest_framework import pagination, permissions, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from . import sso
from . import sso_config
from .imageutils import DataUrlImageError, decode_data_url_image
from .sector_expansion import sector_matches_mode, site_matches_sector_expansion
from .models import (
    AuthEventLog,
    BrandingSettings,
    DriveTestSession,
    DtBand,
    KpiThreshold,
    MenuItem,
    MenuItemRoleVisibility,
    MenuPermission,
    Role,
    SecuritySettings,
    Sector,
    Site,
    SiteAssignment,
    TelemetryRollState,
    TreeFolder,
    TreeSettings,
)
from .serializers import (
    CRUD_MENUS,
    BrandingSettingsSerializer,
    MenuItemSerializer,
    MenuPermissionSerializer,
    MeSerializer,
    SectorSerializer,
    SiteDetailSerializer,
    SiteDtSessionSerializer,
    SiteListSerializer,
    SiteWriteSerializer,
    TreeFolderSerializer,
    UserSerializer,
    UserWriteSerializer,
)

User = get_user_model()


# ── Phase 2: role-based write gates ─────────────────────────────────────
# v1's server-side write authorization (bagalewatch_api.py's _require_auth
# calls) is a coarse role-tier check, NOT a dynamic lookup against
# role_permissions for the specific menu — that table only drives which
# menus the client *shows*. Mirrored here exactly rather than building a
# more "correct" dynamic permission system v1 doesn't actually have —
# Phase 2's job is parity, not a redesign.

class IsAdminOrSuperadmin(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.role in ('superadmin', 'admin'))


class IsSuperadminOnly(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.role == 'superadmin')


class IsRescueOperator(permissions.BasePermission):
    """Gate for core/rescue.py's RescueLookupView — deliberately its own
    tier, not folded into IsAdminOrSuperadmin. An ordinary O&M 'admin' has
    no business looking up a subscriber's phone number by default; that
    access has to be a conscious grant (setting a user's role to
    'rescue_operator'), per the flood-beacon proposal's "access restricted
    to verified rescue authorities under a defined legal process."
    Superadmin is included so there is always at least one role that can
    administer this without a separate bootstrapping step, matching how
    IsSuperadminOnly-gated resources already work."""

    def has_permission(self, request, view):
        return bool(
            request.user and request.user.is_authenticated
            and request.user.role in ('rescue_operator', 'superadmin')
        )


@api_view(['GET'])
@permission_classes([AllowAny])
def health(request):
    """
    Unauthenticated health check for docker-compose healthchecks / uptime
    monitoring. Confirms the Django process is up AND can reach its own
    (v2-only) Postgres database — never touches the v1 SQLite file.
    """
    # Version fields (2026-08-23) so the About page can compare the running
    # backend against the frontend bundle. This endpoint is already public and
    # already names the service, so a build version adds no new exposure.
    db_ok = True
    db_error = None
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            cursor.fetchone()
    except Exception as exc:  # pragma: no cover - defensive, reported not raised
        db_ok = False
        db_error = str(exc)

    payload = {
        'service': 'dt-watch-django',
        'status': 'ok' if db_ok else 'degraded',
        'database': 'ok' if db_ok else 'unreachable',
        'database_error': db_error,
    }

    # Build stamp only for AUTHENTICATED callers (2026-08-23 security review).
    # This endpoint is AllowAny because docker-compose's healthcheck and uptime
    # monitoring hit it without credentials, and it must stay that way. But an
    # exact build tag plus git SHA tells an unauthenticated visitor precisely
    # which commit is deployed, which is a free head start for anyone matching
    # it against known issues — and this app is now served through a
    # public-facing proxy. That is the same reasoning that put AboutPage behind
    # ProtectedRoute, so leaving it public here would have contradicted it.
    #
    # `request.user` is populated for a bearer token even on an AllowAny view,
    # because DRF still runs DEFAULT_AUTHENTICATION_CLASSES — so AboutPage's
    # normal authenticated fetch gets the full payload with no second endpoint.
    if request.user and request.user.is_authenticated:
        payload.update({
            'version': settings.APP_VERSION,
            'build_tag': settings.BUILD_TAG,
            'git_sha': settings.GIT_SHA,
        })

    return Response(payload, status=200 if db_ok else 503)


class SystemHealthView(APIView):
    """GET /api/v2/system-health/ -- superadmin-only diagnostic dashboard
    (2026-10-01, "idea and plan" follow-up to the UTS screenshots). Unlike
    the public health() above, this is authenticated and deliberately
    reveals infra internals (Redis reachability, disk headroom), so it's
    gated the same as every other infra-ish superadmin page (ApiAccessPage,
    AccessLogPage, LiveSiteSyncPage), not AllowAny.

    dtwatch is a monolith, not a microservice mesh -- there's no API to ask
    Docker "is sibling container X up," so this only reports on things
    Django can itself observe: its own DB connection, the Redis instance it
    already talks to (cache + SSO transaction state), disk headroom under
    MEDIA_ROOT, and the one other background loop with DB-backed state
    (TelemetryRollState's bin-roller watermark). Live Site Sync's own
    per-source health is deliberately NOT duplicated here -- see
    useLiveSiteSources() on the frontend, which SystemHealthPage.tsx calls
    directly instead of this endpoint aggregating it a second time.

    telemetry-maintenance (the OTHER always-on loop, monthly partition
    rollover/retention) has no status model at all and is not represented
    here -- inventing one would be a bigger feature than "report what
    already exists," not a gap in this endpoint.

    Each check is independently try/excepted so one failure (e.g. Redis
    down) doesn't blank out the others.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        db_ok = True
        db_error = None
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1')
                cursor.fetchone()
        except Exception as exc:  # pragma: no cover - defensive, reported not raised
            db_ok = False
            db_error = str(exc)

        redis_ok = True
        redis_error = None
        try:
            redis.from_url(sso_config.redis_url(), socket_connect_timeout=2, socket_timeout=2).ping()
        except Exception as exc:  # pragma: no cover - defensive, reported not raised
            redis_ok = False
            redis_error = str(exc)

        disk = None
        disk_error = None
        try:
            usage = shutil.disk_usage(settings.MEDIA_ROOT)
            disk = {'total_bytes': usage.total, 'used_bytes': usage.used, 'free_bytes': usage.free}
        except Exception as exc:  # pragma: no cover - defensive, reported not raised
            disk_error = str(exc)

        roll_state = TelemetryRollState.objects.filter(pk=1).first()

        return Response({
            'database': {'status': 'ok' if db_ok else 'down', 'error': db_error},
            'redis': {'status': 'ok' if redis_ok else 'down', 'error': redis_error},
            'disk': disk,
            'disk_error': disk_error,
            'telemetry_bin_roller': {
                'last_rolled_at': roll_state.last_rolled_at if roll_state else None,
            },
            'version': settings.APP_VERSION,
            'build_tag': settings.BUILD_TAG,
            'git_sha': settings.GIT_SHA,
            'checked_at': timezone.now(),
        })


# ── Auth ─────────────────────────────────────────────────────────────
# JWT, not session cookies — see settings.py's REST_FRAMEWORK comment for
# why. `authenticate()` below still goes through User.check_password()
# internally regardless of transport, which is what makes the legacy
# password hasher's upgrade-on-login behavior (core/hashers.py) work
# identically here.

class LoginView(APIView):
    """POST /api/v2/auth/login/ — matches v1's own brute-force protection
    (bagalewatch_api.py's SESSION_LIFETIME_SECS-adjacent 5-attempt / 15-
    minute lockout, see the v1 project brief's Auth/RBAC line) via
    Django's cache framework rather than a DB table — a failed-login
    counter doesn't need to survive a server restart or be queryable, so
    the cache is the right tool (LocMemCache by default, upgradable to
    Redis via CACHES with zero code changes here).

    Keyed by username (case-insensitive), not IP — matches v1's own
    per-account lockout semantics and avoids one shared office IP/NAT
    locking out every real user behind it after a few mistyped passwords
    from ONE person. The counter is checked BEFORE calling authenticate()
    so a locked-out account can't be brute-forced further while blocked,
    and is cleared on a successful login so a legitimate late-correct
    attempt isn't penalized by earlier typos once it succeeds."""

    permission_classes = [AllowAny]
    # Never session-authenticate this endpoint (2026-09-01 fix). Without
    # this, a client carrying a valid Django-admin sessionid cookie on
    # this same origin gets session-authenticated here even though the
    # view is AllowAny, which then triggers CSRF enforcement on the POST.
    # The JWT-based SPA never sends a CSRF token, so that fails with its
    # own 403 -- indistinguishable, from the frontend's point of view,
    # from the real "local login disabled" 403 below, since it maps any
    # 403 here to the same "try single sign-on" message regardless of
    # cause. Symptom: login works in a fresh/incognito browser (no admin
    # session cookie) but fails in a normal browser that's also logged
    # into /admin/ -- until its cookies are cleared.
    authentication_classes = []

    MAX_ATTEMPTS = 5
    LOCKOUT_SECONDS = 15 * 60

    def post(self, request):
        # Local imports -- see core/auth_log.py's module docstring for why
        # this can't be a top-level import here: auth_log.py itself
        # imports IsSuperadminOnly FROM this module, and this module is
        # usually the first of the two actually loaded (core/urls.py's
        # `from . import (..., sso_views, ..., views)` would otherwise
        # try to fully load views.py again, mid-load, through auth_log --
        # a real circular import. Deferring this one import to call time
        # breaks the cycle without restructuring either module. core.ip_block
        # needs the same treatment (2026-10-02, Phase E2) for the identical
        # reason -- it imports IsSuperadminOnly from this module too.
        from .auth_log import _client_ip, log_auth_event
        from .ip_block import is_ip_blocked, maybe_auto_block

        # SSO-only cutover switch (2026-08-23). Checked before anything else,
        # including the lockout counter, so a disabled password endpoint does
        # no work and cannot be used to probe which usernames exist.
        if not sso_config.local_login_enabled():
            return Response(
                {'detail': 'Password sign-in is disabled on this server. Please use single sign-on.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Active IP block (2026-10-02, Phase E2) -- checked before the
        # per-username lockout counter and before authenticate() is ever
        # called, so a blocked source spends no password-hash-verify cycle
        # and gets no enumeration signal either way.
        ip = _client_ip(request)
        if is_ip_blocked(ip):
            log_auth_event(request, AuthEventLog.EVENT_LOGIN_IP_BLOCKED, detail='blocked IP retried')
            return Response(
                {'detail': 'Too many failed attempts from this network. Contact an administrator.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        username = request.data.get('username', '')
        password = request.data.get('password', '')
        cache_key = f'login_fail:{username.strip().lower()}'

        if username and cache.get(cache_key, 0) >= self.MAX_ATTEMPTS:
            log_auth_event(request, 'login_locked', username=username)
            maybe_auto_block(request, ip)
            return Response(
                {'detail': 'Too many failed login attempts. Try again in 15 minutes.'},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        user = authenticate(request, username=username, password=password)
        if user is None:
            if username:
                cache.set(cache_key, cache.get(cache_key, 0) + 1, self.LOCKOUT_SECONDS)
            log_auth_event(request, 'login_failed', username=username)
            maybe_auto_block(request, ip)
            return Response({'detail': 'Invalid username or password.'}, status=status.HTTP_401_UNAUTHORIZED)
        if not user.is_active:
            log_auth_event(request, 'login_disabled', username=username, user=user)
            return Response({'detail': 'This account is disabled.'}, status=status.HTTP_403_FORBIDDEN)

        cache.delete(cache_key)

        # MFA (2026-10-02, Phase C) -- a user who has ALREADY enrolled TOTP
        # is challenged for a code on EVERY login, regardless of the
        # superadmin-controlled SecuritySettings.mfa_required toggle below:
        # once an individual has opted in, that's part of their own
        # account's security now, independent of org-wide policy. Local
        # import for the same circular-import reason log_auth_event is
        # imported locally above -- core/mfa.py imports _finish_login FROM
        # this module.
        if user.totp_enabled:
            from . import mfa
            ticket = mfa.create_pending_ticket(user.id)
            log_auth_event(request, AuthEventLog.EVENT_MFA_CHALLENGE_SENT, user=user)
            return Response({'mfa_required': True, 'mfa_ticket': ticket})

        response = _finish_login(request, user)
        # Org-wide mandatory-MFA policy, for a user who has NOT enrolled
        # yet (the branch above already handled "has enrolled"). Still lets
        # them log in normally -- flipping this on must not lock out every
        # existing account that hasn't set up TOTP -- but flags the
        # response so the frontend can force an immediate enrollment
        # prompt before showing the rest of the app. See SecuritySettings'
        # own docstring for the full reasoning.
        if SecuritySettings.objects.filter(pk=1, mfa_required=True).exists():
            response.data['mfa_setup_required'] = True
        return response


def _finish_login(request, user):
    """The actual "log a successful sign-in and hand back tokens" tail,
    shared by LoginView (when MFA is off or not required for this user)
    and MFAVerifyView (core/mfa.py, once a pending ticket's code has been
    confirmed) -- extracted 2026-10-02 so both paths end in exactly the
    same place rather than maintaining two copies of token minting."""
    from .auth_log import log_auth_event
    # Last Login fix (2026-10-01, "last login is displayed only in sso
    # login, not in application direct login... make it for
    # application user also") -- this is a custom User model, not
    # Django's AbstractUser/ModelBackend flow that normally updates
    # last_login via the user_logged_in signal, so nothing was ever
    # writing it for a local sign-in -- sso_views.py's SSOCallbackView
    # was the only place that did. Mirrors that exact update.
    user.last_login = timezone.now()
    user.save(update_fields=['last_login'])
    log_auth_event(request, 'login_success', user=user)
    refresh = RefreshToken.for_user(user)
    data = MeSerializer(user).data
    data['access'] = str(refresh.access_token)
    data['refresh'] = str(refresh)
    return Response(data)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        # DT-WATCH's own session stays stateless — the client discards its
        # in-memory tokens and the short (15 min) access-token lifetime
        # naturally limits exposure. Server-side refresh-token revocation
        # (the `rest_framework_simplejwt.token_blacklist` app) is a Phase 2
        # hardening item to add if/when it's actually needed, not before.
        #
        # For an SSO login that is not enough on its own: ending only the
        # DT-WATCH session leaves the Keycloak browser session alive, so
        # "Sign in with NT SSO" walks straight back in with no prompt — on a
        # shared workstation the next person lands in the previous user's
        # account. Hand the SPA a Keycloak end-session URL to visit instead
        # (RP-Initiated Logout), which is the only way to end that session
        # from here. '' means there is nothing to end (local account, SSO
        # off, or the retained ID token is gone) and the SPA just clears its
        # own tokens, exactly as before.
        from .auth_log import log_auth_event
        log_auth_event(request, 'logout', user=request.user)

        logout_url = sso.end_session_url_for(request.user)
        if logout_url:
            return Response({'keycloak_logout_url': logout_url})
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(MeSerializer(request.user).data)


# ── Sites (Phase 2: full CRUD) ──────────────────────────────────────────

class SitePagination(pagination.PageNumberPagination):
    """Opt-in only — see SiteViewSet.paginate_queryset() below. The Sites
    page's new Table view (2026-09-07 rebuild) needs real server-side
    paging over ~4,900 rows; the existing Map view/sidebar (useSites())
    needs the full flat array it's always gotten (MapView's clustering,
    CSV/xlsx export, and anything else already built against "one request,
    every site" would silently see only page_size rows if this applied
    unconditionally)."""
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 500


class SiteViewSet(viewsets.ModelViewSet):
    """Read: any authenticated role (list/map/detail). Write (create/
    update/delete): superadmin or admin, matching v1's
    `_require_auth(roles=('superadmin', 'admin'))` on POST/PUT/DELETE
    /api/v1/sites. Update always fully replaces the site's sector list
    from the payload (see SiteWriteSerializer) — same "send your complete
    current state" contract v1 uses, not a partial patch."""
    queryset = Site.objects.all().order_by('region', 'district', 'name')
    pagination_class = SitePagination

    def paginate_queryset(self, queryset):
        # Only paginate when the caller actually asks for a page — see
        # SitePagination's docstring. Without this, setting
        # pagination_class at all makes DRF paginate every list() call
        # unconditionally, which would truncate every existing flat-array
        # caller to page_size rows the moment this shipped.
        params = self.request.query_params
        if 'page' not in params and self.pagination_class.page_size_query_param not in params:
            return None
        return super().paginate_queryset(queryset)

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return SiteDetailSerializer
        if self.action in ('create', 'update', 'partial_update'):
            return SiteWriteSerializer
        return SiteListSerializer

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        region = params.get('region')
        district = params.get('district')
        search = params.get('q')
        if region:
            qs = qs.filter(region=region)
        if district:
            qs = qs.filter(district=district)
        if search:
            qs = qs.filter(
                Q(id__icontains=search) | Q(name__icontains=search) | Q(district__icontains=search)
            )
        # Deployment/on-air status (2026-09-07, Sites page Table/Map
        # rebuild) — exact match against Site.deployment_status, the live
        # Site Directory sync's own field (see live_sites.py), NOT this
        # app's separate KPI-health `status` (ok/warn/crit/nodata). Kept
        # exact rather than icontains: the frontend derives its dropdown
        # options from the real distinct values already loaded via
        # useSites() (same "never drift from what's actually in the
        # database" convention SiteSearchView's own docstring documents),
        # so whatever a caller sends here is a value that's already known
        # to appear verbatim on some site.
        deployment_status = params.get('status')
        if deployment_status:
            qs = qs.filter(deployment_status=deployment_status)
        # Technology (2026-09-07, AND-ed 2026-09-10) — one or more
        # `technology=` params, now ALL required at once rather than
        # OR'd ("if i select 2g and 3g, display as 2g and 3g not 2g or
        # 3g... if i searched 2g,3g,4g all, then display sites having
        # all 2g, 3g and 4g"), plus one or more `technology_only=` values
        # for the "2G only"/"3G only"/"4G only" pills -- originally a
        # single exact value, extended same day to a repeatable param
        # ("allow multiple selection for 2g only, 3g only and 4g only.
        # if selected 2g only and 4g only, then displays the site that
        # have 2g and 4g only"): a site's tech set must equal EXACTLY the
        # set of `technology_only` values sent, no more and no fewer --
        # {'2G'} matches only a 2G-only site, {'2G','4G'} matches only a
        # site with 2G+4G and nothing else (not 2G alone, not 2G+3G+4G).
        # The two params are mutually exclusive on the frontend (picking
        # any "only" pill clears the regular multi-select and vice versa,
        # SitesPage.tsx); if a client somehow sends both, `technology_only`
        # wins and `technology` is ignored, same "the more specific one
        # wins" rule as picking any single option would imply.
        #
        # Neither can be a single SQL WHERE the way the old OR filter
        # was: a site's real tech set is the union of THREE separate
        # sources with no combined column to index — Site.tech,
        # Site.operational_technologies (a JSON array), and any distinct
        # Sector.tech row — exactly what SiteListSerializer.get_techs()
        # already computes for display (see that method's own docstring
        # for why all three exist). So this fetches those three raw
        # sources for every row `qs` already matches on
        # region/district/status/search (cheap — same query shape
        # `_techs_by_site()` already runs for the whole-database Map
        # view), builds each site's full tech set in Python exactly like
        # get_techs() does, and narrows `qs` to just the matching ids
        # before pagination ever sees it.
        technologies = [t.strip().upper() for t in params.getlist('technology') if t.strip()]
        technology_only = {t.strip().upper() for t in params.getlist('technology_only') if t.strip()}
        if technology_only or technologies:
            sector_techs_by_site = self._techs_by_site(qs)
            matching_ids = []
            for site_id, site_tech, operational_technologies in qs.values_list(
                'id', 'tech', 'operational_technologies',
            ):
                techs = set()
                if site_tech:
                    techs.add(site_tech.strip().upper())
                for t in (operational_technologies or []):
                    if t:
                        techs.add(str(t).strip().upper())
                techs |= sector_techs_by_site.get(site_id, set())

                if technology_only:
                    if techs == technology_only:
                        matching_ids.append(site_id)
                elif set(technologies).issubset(techs):
                    matching_ids.append(site_id)
            qs = qs.filter(id__in=matching_ids)
        return qs

    @staticmethod
    def _techs_by_site(sites):
        """One lightweight `(site_id, tech)` query covering every site
        about to be serialized — feeds SiteListSerializer.get_techs()
        without a per-site N+1 or a full Sector prefetch. `sites` may be
        a QuerySet (the normal, unpaginated case — this ViewSet has no
        pagination_class configured, matching useSites()'s expectation
        of a flat array) or a plain list (if pagination is ever added
        later)."""
        site_ids = sites.values('id') if hasattr(sites, 'values') else [s.id for s in sites]
        pairs = (
            Sector.objects.filter(site_id__in=site_ids)
            .exclude(tech='')
            .values_list('site_id', 'tech')
            .distinct()
        )
        result: dict = {}
        for site_id, tech in pairs:
            result.setdefault(site_id, set()).add((tech or '').strip().upper())
        return result

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        target = page if page is not None else queryset
        context = self.get_serializer_context()
        context['techs_by_site'] = self._techs_by_site(target)
        serializer = self.get_serializer(target, many=True, context=context)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def create(self, request, *args, **kwargs):
        # v1's POST /sites accepts either a single site object or a list
        # (bulk upsert) — mirrored here rather than only supporting DRF's
        # default single-object create, so a future bulk-import UI doesn't
        # need a second endpoint.
        from .audit import log_audit_event

        many = isinstance(request.data, list)
        serializer = self.get_serializer(data=request.data, many=many)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            serializer.save(updated_by=request.user)
        headers = self.get_success_headers(serializer.data)
        ids = [s.id for s in serializer.instance] if many else [serializer.instance.id]
        log_audit_event(request, 'SITE.CREATED', resource='site', resource_id=','.join(map(str, ids)))
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    def update(self, request, *args, **kwargs):
        from .audit import log_audit_event

        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        # The URL's site ID is authoritative, matching v1's PUT /sites/<id>
        # (which does `site['id'] = sub_id` before upserting) — the client
        # doesn't need to repeat it in the body, and if it does, the URL
        # wins rather than 400ing on a mismatch or silently touching the
        # wrong row (see SiteWriteSerializer.update()'s comment on why 'id'
        # is dropped from validated_data regardless).
        data = request.data.copy() if hasattr(request.data, 'copy') else dict(request.data)
        data['id'] = instance.pk
        serializer = self.get_serializer(instance, data=data, partial=partial)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            serializer.save(updated_by=request.user)
        log_audit_event(request, 'SITE.UPDATED', resource='site', resource_id=instance.pk)
        return Response(serializer.data)

    def perform_destroy(self, instance):
        from .audit import log_audit_event
        log_audit_event(self.request, 'SITE.DELETED', resource='site', resource_id=instance.pk, detail=instance.name)
        instance.delete()

    # Max sessions returned by dt_sessions() below -- this is a Site Detail
    # summary panel ("which drive tests were driven near this site"), not
    # a full history browser (that's DT Session History, which already
    # exists and this panel deep-links into) -- so it caps rather than
    # paginates.
    DT_SESSIONS_LIMIT = 20

    @action(detail=True, methods=['get'], url_path='dt-sessions')
    def dt_sessions(self, request, pk=None):
        """GET /api/v2/sites/<id>/dt-sessions/ -- every DriveTestSession
        whose meta.nearby_site_ids (see _nearby_site_ids() in
        serializers.py -- every Site within ~1km of that session's route,
        computed server-side at upload time) includes THIS site's id,
        most-recent first, capped to DT_SESSIONS_LIMIT. Feeds the Site
        Detail page's "Drive Tests Near This Site" panel so an RF
        engineer can see (and jump straight to) relevant drive tests
        without separately searching DT Session History by site name.

        `meta` is a JSONField and `nearby_site_ids` is a key WITHIN it
        (not a top-level field), so this uses a key-transform `contains`
        lookup -- meta__nearby_site_ids__contains=[pk] -- which on
        Postgres compiles to a `jsonb @>` containment check on the
        extracted meta -> 'nearby_site_ids' array, exactly like
        Site.operational_technologies__contains=[...] elsewhere in this
        module (get_queryset() above) except one level deeper. This is
        NOT the same case SiteSearchView.get()'s _sites_with_dt_coverage()
        docstring warns off -- that one needed `contains` with an OuterRef
        (a per-row correlated value) on its right-hand side, which
        Postgres's jsonb @> operator can't take since it needs a literal
        to serialize to jsonb; here the right-hand side is `pk`, the URL's
        literal site id, so the literal-serialization path applies fine.
        `pk` is used AS-IS (a plain string, e.g. "CDR0123") rather than
        int()-cast -- confirmed against the model that Site.id is a
        CharField, not an autoincrement int (see Site's own docstring in
        models.py), and _nearby_site_ids() stores exactly that string via
        `.values_list('id', flat=True)` with no casting, so the array
        this filters against is an array of site-id strings.

        Read-only, IsAuthenticated only (list-tier, not the admin/
        superadmin write tier get_permissions() reserves for create/
        update/destroy above) -- viewing this panel needs no more
        privilege than viewing the site itself.
        """
        site = self.get_object()
        qs = (
            DriveTestSession.objects.filter(meta__nearby_site_ids__contains=[site.pk])
            .annotate(sample_count=Count('samples'))
            .order_by('-date', '-saved_at')[: self.DT_SESSIONS_LIMIT]
        )
        return Response(SiteDtSessionSerializer(qs, many=True).data)


class SiteSectorListView(APIView):
    """GET /api/v2/sites/<site_id>/sectors/ — kept as a plain view rather
    than a nested router nesting, matching how simply the v1 client already
    consumes this ('give me the sectors for one site'), without pulling in
    a nested-router dependency for a single Phase 1 endpoint."""
    permission_classes = [IsAuthenticated]

    def get(self, request, site_id):
        sectors = Sector.objects.filter(site_id=site_id)
        return Response(SectorSerializer(sectors, many=True).data)


class SiteSearchView(APIView):
    """GET /api/v2/sites/search/ — ported from v1's "Advanced Site
    Search" modal (bts_monitor.html ~1810-1904 for the UI, runSearch()
    ~8530-8621 for the filter logic). Per explicit user request ("add
    feature of advance site search with the only parameters that are
    available in the system"), this uses v2's REAL field names/values
    rather than assuming v1's — most notably v1's Type dropdown hardcodes
    Macro/Micro/Indoor/Outdoor, but this app's actual seeded data only
    ever has `type='Macro-BTS'` (confirmed against the dev DB, not
    assumed); the frontend derives its Region/Tech/Type dropdown options
    from the real distinct values in `useSites()` instead of a fixed
    list, so this never silently drifts from what's actually in the
    database the way a hardcoded option list could.

    **2026-08-06 rework — KPI filters replaced with site/sector/drive-test
    filters.** v1's modal had 5 KPI-threshold fields (RRC/Drop/Avail/PRB/
    Thru). Per explicit follow-up request ("since this system mainly
    focus on site info, sectors info and drive test data, so make search
    option related to them not kpi data"), those 5 fields are gone —
    KPI-based lookups already live in SLA/NTA/RF Audit/Scatter/KPI Trend,
    this search's job is finding a site/sector/DT-session record, not
    re-implementing KPI reporting. Replaced with: `cell_name` (substring,
    matches if ANY of the site's sectors has a matching `Sector.cell_name`)
    and `has_dt` (`1`/`0` — whether any DriveTestSession's
    `meta.nearby_site_ids` list includes this site, i.e. whether Drive
    Test coverage exists near this site at all).

    **2026-08-10 rework — `status`/`status_2g`/`status_3g`/`local_cell_id`/
    `pci`/`lat`/`lng`/`radius_km` removed, `cell_active_status` and
    `has_location` added, `tech` widened.** Per explicit request ("in
    advanced search option add parameter 'cell actual status' with
    on-air, planned, dismantle and for 'lat/long' with available and not
    available. in tech add 2g and 3g. remove status, status 2g and
    status 3g, local cell id, pci, latitude, longitude"):
    - `status`/`status_2g`/`status_3g`/`local_cell_id`/`pci` and the
      coordinate-proximity `lat`/`lng`/`radius_km` trio (2026-08-09,
      see below — now removed) are gone entirely, both here and on the
      frontend modal.
    - `cell_active_status` (substring, any sector — same `Exists()`
      pattern as `cell_name`) replaces them for the real field the user
      actually cares about here: `Sector.cell_active_status`, populated
      by the 4G/3G/2G Sector Data imports (see site_import.py). Frontend
      offers it as a dropdown: On-Air / Planned / Dismantle.
    - `has_location` (`1`/`0`) replaces the old proximity search with a
      simpler presence check — `1` = site has both `lat` and `lng` set,
      `0` = either is missing. The old `lat`/`lng`/`radius_km` distance
      search is gone (it was a different feature — "search near this
      coordinate" — not what this request is asking for).
    - `tech` now ALSO matches via any sector's own `Sector.tech` (not
      just `Site.tech`), since 2G/3G sectors are what actually carry a
      "2G"/"3G" tech value on this real dataset — `Site.tech` alone
      would never match those for most sites.

    Done server-side (v1 filters an in-memory array of ~4,700 fully-
    loaded site objects; v2 deliberately keeps the site LIST endpoint
    lightweight — no sectors, no DT linkage, see SiteListSerializer's own
    docstring — so a search touching sector fields or DT-session linkage
    has to query the database directly rather than filtering whatever's
    already cached client-side).

    Query params (all optional, combined with AND): `q` (site ID/name
    substring), `region` (exact), `city` (substring, matches city OR
    district — v2 splits what v1 calls one "City / District" field into
    two real columns), `deployment_status` (exact, the Live Site
    Directory's own on-air/planned/etc state), `palika` (substring),
    `ward_no` (exact integer), `tech` (substring, Site.tech OR any
    sector's tech), `tower_type` (substring, Site.tower_type — see its own
    2026-09-30 comment below for why this isn't `type`), `cell_name`
    (substring, any sector), `cell_active_status` (substring, any sector),
    `has_location` (`1` or `0`), `has_dt` (`1` or `0`).

    **2026-09-30 rework — `deployment_status`/`palika`/`ward_no` added.**
    Per "update search parameters also as our application also updated":
    these three are real Site fields from the Live Site Directory sync
    (2026-08-26) that had no search filter at all until now, despite
    `deployment_status` already driving the Dashboard's Active/Planned/
    Decommissioning tiles and `palika`/`ward_no` already being shown on
    the Sites page's Table view. Same conventions as their siblings above:
    `deployment_status` exact (frontend dropdown, real distinct values,
    same as SiteViewSet.get_queryset()'s own `status` filter), `palika`
    substring (same as `city`), `ward_no` exact integer (silently ignored
    if not a valid int, since it's a plain number input with no
    client-side validation).

    **`sector_expansion`, 2026-08-09 follow-up: "my major concern is to
    find expanded sector list... add search parameter with all sector
    expansion, sector expansion with same latlong and sector expansion
    with different latlong."** One of `all` / `same_latlong` /
    `different_latlong` — see `core/sector_expansion.py`'s module
    docstring for the full classification rule (a real Nepal Telecom
    sector-letter naming convention, confirmed with the user via
    AskUserQuestion, not guessed). `all` matches a site with at least one
    sector flagged expansion by ANY signal (letter/cell-name/GPS);
    `same_latlong` narrows to sectors flagged expansion whose GPS still
    equals the site's (naming says expansion, coordinates haven't caught
    up yet); `different_latlong` narrows to sectors whose GPS itself
    proves the divergence.

    `has_dt` is computed by loading every DriveTestSession's `meta` blob
    once and building a Python set of every site ID any session's
    `_nearby_site_ids()` (see serializers.py) ever tagged, rather than a
    database-level JSON-contains lookup — `meta` is a JSONField storing
    v1's free-form blob (see DriveTestSession's own docstring for why it
    isn't normalized), and Postgres's `__contains` lookup can't take an
    `OuterRef` as its right-hand side (it needs a literal to serialize to
    jsonb), so a subquery-based Exists() isn't viable here. Session counts
    are small (tens to low hundreds, not thousands — distinct from the
    121,000+ *sample* rows a single upload batch can contain), so loading
    every session's `meta` once per request is cheap and correct on both
    SQLite (dev) and Postgres (prod) without lookup-syntax differences.

    Read-only, no permission gate beyond being logged in — matches v1
    exactly (search has no `userCan()` check, unlike the write-side
    Backup/Restore actions elsewhere in this app)."""

    permission_classes = [IsAuthenticated]

    @staticmethod
    def _sites_with_dt_coverage():
        ids = set()
        for meta in DriveTestSession.objects.exclude(meta__isnull=True).values_list('meta', flat=True):
            for site_id in (meta or {}).get('nearby_site_ids') or []:
                ids.add(site_id)
        return ids

    def get(self, request):
        qs = Site.objects.all()

        q = (request.query_params.get('q') or '').strip()
        if q:
            qs = qs.filter(Q(id__icontains=q) | Q(name__icontains=q))

        region = (request.query_params.get('region') or '').strip()
        if region:
            qs = qs.filter(region=region)

        city = (request.query_params.get('city') or '').strip()
        if city:
            qs = qs.filter(Q(city__icontains=city) | Q(district__icontains=city))

        # Deployment Status / Palika / Ward No. (2026-09-30, "update search
        # parameters also as our application also updated") — all three
        # are real Live Site Directory sync fields (2026-08-26) that
        # postdate this modal's last rework and had no search filter at
        # all until now. `deployment_status` is exact match, same
        # convention as SiteViewSet.get_queryset()'s own `status` filter
        # (frontend derives its dropdown from real distinct values, so
        # whatever it sends is already a value known to appear verbatim on
        # some site — no need to tolerate casing/spacing drift the way a
        # free-typed field would). `palika` is substring, same convention
        # as `city` above (free-text, high-cardinality, no fixed list).
        # `ward_no` is an exact integer match; a non-numeric value is
        # ignored rather than erroring, since it's a plain number input
        # with no client-side validation stopping a stray non-digit paste.
        deployment_status = (request.query_params.get('deployment_status') or '').strip()
        if deployment_status:
            qs = qs.filter(deployment_status=deployment_status)

        palika = (request.query_params.get('palika') or '').strip()
        if palika:
            qs = qs.filter(palika__icontains=palika)

        ward_no = (request.query_params.get('ward_no') or '').strip()
        if ward_no:
            try:
                qs = qs.filter(ward_no=int(ward_no))
            except ValueError:
                pass

        # `tech` matches either the site's own Site.tech OR any of its
        # sectors' Sector.tech — 2G/3G values on this real dataset live
        # almost entirely on the sector rows (from the per-tech Sector
        # Data imports), so Site.tech alone would never surface them.
        tech = (request.query_params.get('tech') or '').strip()
        if tech:
            # See SiteViewSet.get_queryset()'s technology filter (2026-09-08
            # fix) for why operational_technologies has to be checked here
            # too -- same three-source union SiteListSerializer.get_techs()
            # uses to populate the tech data this filter is meant to match.
            qs = qs.filter(
                Q(tech__icontains=tech)
                | Q(operational_technologies__contains=[tech.upper()])
                | Exists(Sector.objects.filter(site_id=OuterRef('pk'), tech__icontains=tech))
            )

        # Tower Type (2026-09-30, "there is only 2g and 3g in tech, what is
        # type here?... fix it") — confirmed directly against the live
        # data that `Site.type` is blank for EVERY site (0 of 5,327); no
        # import path has ever written to it, so this filter could never
        # match anything. `Site.tower_type` is the real, populated
        # equivalent (4,183 of 5,327, from the LTE Engineering Parameter
        # import) — renamed the param to match so it doesn't silently
        # claim to filter a field it doesn't.
        tower_type = (request.query_params.get('tower_type') or '').strip()
        if tower_type:
            qs = qs.filter(tower_type__icontains=tower_type)

        cell_name = (request.query_params.get('cell_name') or '').strip()
        if cell_name:
            qs = qs.filter(Exists(Sector.objects.filter(site_id=OuterRef('pk'), cell_name__icontains=cell_name)))

        # Cell Active Status (2026-08-10, replaces status/status_2g/
        # status_3g/local_cell_id/pci per explicit request) — substring
        # match against any sector's Sector.cell_active_status. Frontend
        # offers it as a dropdown (On-Air / Planned / Dismantle) but this
        # stays a substring filter server-side, same as cell_name, so it
        # tolerates whatever exact casing/spacing real import data has.
        cell_active_status = (request.query_params.get('cell_active_status') or '').strip()
        if cell_active_status:
            qs = qs.filter(Exists(Sector.objects.filter(
                site_id=OuterRef('pk'), cell_active_status__icontains=cell_active_status,
            )))

        # Lat/Long Available (2026-08-10, replaces the old lat/lng/
        # radius_km proximity search) — a presence check, not a distance
        # search: `1` = site has both lat and lng recorded, `0` = either
        # is missing (this is exactly what feeds the "Unassigned"/
        # district-backfill gap — see districtBackfill.ts).
        has_location = (request.query_params.get('has_location') or '').strip()
        if has_location == '1':
            qs = qs.filter(lat__isnull=False, lng__isnull=False)
        elif has_location == '0':
            qs = qs.filter(Q(lat__isnull=True) | Q(lng__isnull=True))

        has_dt = (request.query_params.get('has_dt') or '').strip()
        dt_site_ids = None
        if has_dt in ('1', '0'):
            dt_site_ids = self._sites_with_dt_coverage()
            qs = qs.filter(id__in=dt_site_ids) if has_dt == '1' else qs.exclude(id__in=dt_site_ids)

        sector_expansion = (request.query_params.get('sector_expansion') or '').strip()
        if sector_expansion and sector_expansion not in ('all', 'same_latlong', 'different_latlong'):
            return Response({'detail': 'sector_expansion must be "all", "same_latlong", or "different_latlong".'}, status=400)

        qs = qs.annotate(sector_count=Count('sectors', distinct=True)).order_by('id')
        # Sectors only need to be prefetched (avoiding an N+1 query in
        # site_matches_sector_expansion's per-site loop below) when a
        # sector-expansion search is actually active — every other filter
        # above stays a pure Exists()/Q() subquery that never loads full
        # Sector rows into Python at all.
        needs_sectors = bool(sector_expansion)
        sites_list = list(qs.prefetch_related('sectors')) if needs_sectors else list(qs)
        if sector_expansion:
            sites_list = [s for s in sites_list if site_matches_sector_expansion(s, sector_expansion)]

        # Only compute the full DT-coverage set for the `has_dt` column
        # if it wasn't already computed above for filtering — no reason
        # to walk every DriveTestSession's meta blob twice per request.
        if dt_site_ids is None:
            dt_site_ids = self._sites_with_dt_coverage()

        # TECH column fix (2026-09-30, "why tech is empty here" — a
        # tech=2G search returned real matching sites with a blank TECH
        # column for every single row). Root cause confirmed directly
        # against the live data: `Site.tech` is blank for EVERY site in
        # the database (0 of 5,327) — nothing in any current import or
        # Live Site Directory sync path has ever written to it; the real
        # tech info lives on Sector.tech and Site.operational_technologies
        # instead (same reasoning the `tech` FILTER above already applies
        # via Exists()/operational_technologies__contains, and the exact
        # union SiteListSerializer.get_techs() computes for the Sites
        # page). The old `'tech': s.tech` below always echoed that
        # permanently-empty field back. Reuses SiteViewSet._techs_by_site's
        # one bulk (site_id, tech) query rather than an N+1 per result row.
        techs_by_site = SiteViewSet._techs_by_site(sites_list)

        def display_tech(s):
            techs = set(techs_by_site.get(s.id, ()))
            if s.tech:
                techs.add(s.tech.strip().upper())
            for t in (s.operational_technologies or []):
                if t:
                    techs.add(str(t).strip().upper())
            return ', '.join(sorted(techs))

        if sector_expansion:
            # Sector-wise rows (2026-08-09 follow-up: "it is giving
            # summary result with sitename, need sector wise result with
            # cell name") — one row PER MATCHING SECTOR, not one row per
            # site. A site with 3 expansion sectors produces 3 rows here,
            # each carrying its own Cell Name/Sector/lat/lng, instead of
            # a single site-level summary row that hides which specific
            # sectors triggered the match.
            #
            # **2026-08-11 bug fix: "tech as 2g and sector expansion...
            # giving wrong result"** — `tech`/`cell_name`/`cell_active_status`
            # above are all SITE-level filters (Q()/Exists() — a site
            # matches if ANY of its sectors satisfies them). That's correct
            # for the normal one-row-per-site result set, but this sector-
            # wise branch was reusing the exact same `sites_list` and then
            # emitting EVERY expansion sector on each matching site,
            # including sectors that don't themselves match tech/cell_name/
            # cell_active_status — e.g. filtering tech=2G surfaced a site's
            # 3G/4G expansion sectors too, as long as that site ALSO had an
            # unrelated 2G sector somewhere satisfying the site-level
            # filter. Re-checked per-sector below so each individual row
            # actually satisfies every active filter, not just the site as
            # a whole.
            results = []
            for s in sites_list:
                for sec in s.sectors.all():
                    if not sector_matches_mode(sec, s, sector_expansion):
                        continue
                    if tech and tech.lower() not in (sec.tech or s.tech or '').lower():
                        continue
                    if cell_name and cell_name.lower() not in (sec.cell_name or '').lower():
                        continue
                    if cell_active_status and cell_active_status.lower() not in (sec.cell_active_status or '').lower():
                        continue
                    results.append({
                        'id': s.id,
                        'name': s.name,
                        'region': s.region,
                        'city': s.city,
                        'district': s.district,
                        'tech': sec.tech or s.tech,
                        'status': '',
                        'status_2g': '',
                        'status_3g': '',
                        'sector_count': s.sector_count,
                        'has_dt': s.id in dt_site_ids,
                        # The sector's OWN effective location — its own
                        # override if it has one, else it inherits the
                        # site's (same fallback rule as everywhere else
                        # this app reads a sector's location).
                        'lat': sec.lat if sec.lat is not None else s.lat,
                        'lng': sec.lng if sec.lng is not None else s.lng,
                        'cell_name': sec.cell_name,
                        'sector': sec.sector,
                        'local_cell_id': sec.local_cell_id,
                    })
            return Response({'count': len(results), 'total': Site.objects.count(), 'results': results})

        results = [
            {
                'id': s.id,
                'name': s.name,
                'region': s.region,
                'city': s.city,
                'district': s.district,
                'tech': display_tech(s),
                'status': s.status,
                'status_2g': s.status_2g,
                'status_3g': s.status_3g,
                'sector_count': s.sector_count,
                'has_dt': s.id in dt_site_ids,
                'lat': s.lat,
                'lng': s.lng,
            }
            for s in sites_list
        ]
        return Response({'count': len(results), 'total': Site.objects.count(), 'results': results})


# ── KPI thresholds (Phase 2) ────────────────────────────────────────────

class ThresholdsView(APIView):
    """Matches v1's /api/v1/thresholds contract exactly (not a generic
    ModelViewSet — there's no per-row REST resource here, just one flat
    key->threshold dict):
    GET  -> {kpi_key: {warn, crit, hi, max, unit}, ...} for every row.
    PUT  -> upserts only the kpi_key entries present in the body (an
            UPDATE-or-INSERT per key, matching v1's SQL ON CONFLICT —
            NOT a full delete-and-replace like /tree or /permissions).
    Read: any authenticated role. Write: superadmin or admin, matching
    v1's `_require_auth(roles=('superadmin', 'admin'))`."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def get(self, request):
        rows = KpiThreshold.objects.all()
        return Response({
            r.kpi_key: {'warn': r.warn, 'crit': r.crit, 'hi': r.hi, 'max': r.max, 'unit': r.unit}
            for r in rows
        })

    def put(self, request):
        from .audit import log_audit_event

        body = request.data or {}
        with transaction.atomic():
            for kpi_key, t in body.items():
                t = t or {}
                KpiThreshold.objects.update_or_create(
                    kpi_key=kpi_key,
                    defaults=dict(
                        warn=t.get('warn'), crit=t.get('crit'),
                        hi=bool(t.get('hi')), max=t.get('max'), unit=t.get('unit') or '',
                    ),
                )
        log_audit_event(request, 'THRESHOLD.UPDATED', resource='threshold', payload=body)
        return Response({'ok': True})


class ThresholdDetailView(APIView):
    """DELETE /thresholds/<kpi_key>/ — v1 has no way to remove a threshold
    key at all (its PUT is upsert-only, matching ThresholdsView.put()
    above); this is a deliberate v2 addition beyond v1 parity, confirmed
    with the user 2026-07-27 during Phase 2 live testing rather than
    added silently. Gated the same as ThresholdsView's PUT (superadmin or
    admin) — no separate role-permissions distinction for delete vs write
    exists for this menu in v1's model, so there's nothing finer to
    mirror here."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def delete(self, request, kpi_key):
        from .audit import log_audit_event

        deleted, _ = KpiThreshold.objects.filter(kpi_key=kpi_key).delete()
        if not deleted:
            return Response({'detail': 'No threshold with that key.'}, status=404)
        log_audit_event(request, 'THRESHOLD.DELETED', resource='threshold', resource_id=kpi_key)
        return Response(status=204)


# ── DT coverage-band colors (2026-08-05, v2-only — no v1 equivalent) ────

class DtBandsView(APIView):
    """GET/PUT /api/v2/dt-bands/ — editable coverage-band color/range
    definitions for the Drive-Test maps (Explore/Compare/single-session
    Coverage). Confirmed with the user via AskUserQuestion: shared/
    server-saved (not per-browser), a dedicated admin page, superadmin-or-
    admin editable — see DtBand's own docstring in models.py for why this
    has no v1 parity concern to worry about (v1 has no equivalent at all).

    Contract shape: GET returns `{tag: [{label,min,max,color}, ...], ...}`
    for every metric tag that has rows. PUT is a FULL REPLACE per tag —
    same "send your complete current state, we delete-and-recreate"
    contract as Site's sector list and Tree's folder structure elsewhere
    in this app, not a partial upsert like ThresholdsView.put() above.
    Chosen because the frontend's editor UI is a per-tag table where a
    user can add/reorder/delete rows freely — the natural save action is
    "here's the tag's whole list now," not a merge. A tag omitted from
    the PUT body is left untouched (not cleared) — the frontend always
    sends every tag's full state together, so this only matters for a
    hand-crafted partial request, and "untouched" is the safer default
    for that case.

    Read: any authenticated role (every DT map needs these to render its
    legend/dots at all). Write: superadmin or admin, matching
    ThresholdsView/ThresholdDetailView's gating exactly — same tier as
    every other config-editing screen in this app."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def get(self, request):
        rows = DtBand.objects.all().order_by('metric_tag', 'sort_order')
        out: dict[str, list] = {}
        for r in rows:
            out.setdefault(r.metric_tag, []).append(
                {'label': r.label, 'min': r.min_value, 'max': r.max_value, 'color': r.color}
            )
        return Response(out)

    def put(self, request):
        body = request.data or {}
        if not isinstance(body, dict):
            return Response({'detail': 'Expected an object of {tag: [bands...]}.'}, status=400)
        with transaction.atomic():
            for tag, bands in body.items():
                if not isinstance(bands, list):
                    return Response({'detail': f'"{tag}" must be a list of bands.'}, status=400)
                DtBand.objects.filter(metric_tag=tag).delete()
                rows = []
                for order, b in enumerate(bands):
                    b = b or {}
                    label = (b.get('label') or '').strip()
                    color = (b.get('color') or '').strip()
                    if not label or not color:
                        return Response({'detail': f'"{tag}" band {order + 1}: label and color are required.'}, status=400)
                    try:
                        min_v = float(b.get('min'))
                        max_v = float(b.get('max'))
                    except (TypeError, ValueError):
                        return Response({'detail': f'"{tag}" band {order + 1}: min/max must be numbers.'}, status=400)
                    rows.append(DtBand(metric_tag=tag, label=label, min_value=min_v, max_value=max_v, color=color, sort_order=order))
                DtBand.objects.bulk_create(rows)
        return Response({'ok': True})


# ── Tree structure (Phase 2) ────────────────────────────────────────────

class TreeView(APIView):
    """Originally matched v1's /api/v1/tree contract exactly (2-level
    folder/subfolder). Redesigned 2026-07-27 (user-confirmed, beyond v1
    parity) so folders can nest to any depth via TreeFolder.parent — see
    that model's docstring. New contract:
    GET  -> {folders: [{id,name,icon,lat,lng,children:[...]}, ...]
            (top-level folders only; each folder's own `children` list
            recurses to whatever depth exists), assignments:
            {site_id: folder_id | null}, active: bool}
    PUT  -> full delete-and-rebuild from the payload (the client always
            sends its complete current tree state, same as v1's
            _set_tree_state — never a diff/patch). Nodes are created
            depth-first so a child's `parent` is always already saved.
            Assignments for a site ID or folder ID the server doesn't
            recognize are silently skipped rather than rejecting the
            whole request, matching v1's original defensive behavior for
            the same reason (tree data can arrive slightly ahead of site
            data in some sync orderings).
    Read: any authenticated role. Write: superadmin or admin."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def get(self, request):
        top_level = TreeFolder.objects.filter(parent__isnull=True).order_by('name')
        assignments = {a.site_id: a.folder_id for a in SiteAssignment.objects.all()}
        settings_row = TreeSettings.objects.filter(pk=1).first()
        return Response({
            'folders': TreeFolderSerializer(top_level, many=True).data,
            'assignments': assignments,
            'active': bool(settings_row.custom_active) if settings_row else False,
        })

    def put(self, request):
        body = request.data or {}

        def create_folder(node, parent):
            if not node or not node.get('id'):
                return
            folder = TreeFolder.objects.create(
                id=node['id'], parent=parent, name=node.get('name') or '', icon=node.get('icon') or '',
                lat=node.get('lat'), lng=node.get('lng'),
            )
            for child in (node.get('children') or []):
                create_folder(child, folder)

        with transaction.atomic():
            TreeFolder.objects.all().delete()
            SiteAssignment.objects.all().delete()

            for node in (body.get('folders') or []):
                create_folder(node, None)

            known_site_ids = set(Site.objects.values_list('id', flat=True))
            known_folder_ids = set(TreeFolder.objects.values_list('id', flat=True))
            assignments = body.get('assignments') or {}
            to_create = [
                SiteAssignment(site_id=site_id, folder_id=folder_id)
                for site_id, folder_id in assignments.items()
                if site_id in known_site_ids and folder_id in known_folder_ids
            ]
            SiteAssignment.objects.bulk_create(to_create)

            TreeSettings.objects.update_or_create(pk=1, defaults={'custom_active': bool(body.get('active'))})

        from .audit import log_audit_event
        # Summary counts, not the raw body -- a full tree payload can cover
        # thousands of site assignments, too large to usefully store as one
        # AuditEvent.payload blob.
        log_audit_event(
            request, 'TREE.UPDATED', resource='tree',
            detail=f"{len(body.get('folders') or [])} top-level folder(s), {len(body.get('assignments') or {})} assignment(s)",
        )
        return Response({'ok': True})


class MenuPermissionViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only, flat (role, menu_key, action) row listing — kept as-is
    from Phase 1 for inspection/debugging. The React permission editor
    should use PermissionsMatrixView below instead, which matches v1's
    actual /api/v1/permissions contract shape (nested per-role dict)."""
    queryset = MenuPermission.objects.all()
    serializer_class = MenuPermissionSerializer
    permission_classes = [IsAuthenticated]


def get_visible_menu_items(user):
    """Shared visibility filter (2026-08-08, extended the same day for
    arbitrary-depth submenus) — the exact same per-item gating
    MenuTreeView uses, reusable so the Dashboard's shortcut cards (which
    link to the same MenuItem entries) apply IDENTICAL visibility rules
    instead of a second hand-maintained copy that could silently drift
    out of sync with the sidebar.

    Returns `(visible_top, visible_children)`: `visible_top` is the
    ordered list of top-level MenuItem objects `user` may see;
    `visible_children` is a FUNCTION — `visible_children(item_id)` —
    rather than a precomputed dict, since submenus can now be arbitrarily
    deep and there's no fixed "one level" set of ids to precompute ahead
    of time. An item is only ever visible if its own access check passes
    AND its parent (recursively, all the way up) is also visible — an
    item behind a hidden ancestor at ANY depth can't leak through as an
    orphaned entry. A cycle guard (`visiting`) makes this safe even
    against malformed data with an actual parent loop in it (e.g. from a
    direct Django-admin edit, which bypasses MenuItemSerializer's own
    cycle check) — such a loop just resolves to "not visible" for every
    item in it, rather than recursing forever."""
    items = list(MenuItem.objects.filter(is_active=True).order_by('order', 'id'))
    by_id = {item.id: item for item in items}

    # Superadmin bypasses every gate (matches isAllowed()'s own
    # superadmin special-case in api/types.ts) — no need to even query
    # MenuPermission for that role.
    read_perms = {}
    if user.role != 'superadmin':
        read_perms = {
            r.menu_key: r.allowed
            for r in MenuPermission.objects.filter(role=user.role, action='read')
        }

    # Menu Visibility overrides (2026-10-01, "full parity" RBAC feature) —
    # a SPARSE, additive layer on top of the coarse access-tier checks
    # below, not a replacement for them. `user.roles` may hold multiple
    # roles (a builtin tier plus any number of custom ones); `user.role`
    # alone would miss an override granted specifically to a custom role
    # the user also holds, so this reads the FULL set. Falls back to just
    # `{user.role}` so a user who (incorrectly) has no `roles` rows yet
    # still gets exactly today's behavior instead of silently losing every
    # override lookup.
    user_role_names = set(user.roles.values_list('name', flat=True)) or {user.role}
    overrides_by_item: dict = {}
    if user.role != 'superadmin':
        for row in MenuItemRoleVisibility.objects.filter(role__name__in=user_role_names):
            overrides_by_item.setdefault(row.menu_item_id, set()).add(row.visible)

    def visibility_override(item_id):
        """True/False if any of the user's roles has an explicit
        MenuItemRoleVisibility row for this item, else None (= inherit
        the coarse default below). Explicit ALLOW on ANY held role wins
        over explicit DENY on ALL of them — a user should see something
        if even one of their roles was granted it, matching how
        MenuPermission's own read_perms above already works (any
        permission source granting access is enough)."""
        values = overrides_by_item.get(item_id)
        if not values:
            return None
        return True if True in values else False

    def own_access_ok(item):
        if user.role == 'superadmin':
            return True
        override = visibility_override(item.id)
        if override is not None:
            return override
        if item.access == MenuItem.ACCESS_ALL:
            return True
        if item.access == MenuItem.ACCESS_ADMIN:
            return user.role == 'admin'
        if item.access == MenuItem.ACCESS_SUPERADMIN:
            return False  # superadmin already returned True above
        if item.access == MenuItem.ACCESS_RESCUE:
            # Mirrors core/rescue.py's IsRescueOperator exactly (superadmin
            # already returned True above, so only rescue_operator is left
            # to check here).
            return user.role == 'rescue_operator'
        if item.access == MenuItem.ACCESS_PERMISSION:
            return bool(read_perms.get(item.permission_key))
        return False

    visible_cache: dict = {}
    visiting: set = set()

    def is_visible(item):
        if item.id in visible_cache:
            return visible_cache[item.id]
        if item.id in visiting:
            return False  # cycle guard — see docstring
        visiting.add(item.id)
        ok = own_access_ok(item)
        if ok and item.parent_id is not None:
            parent = by_id.get(item.parent_id)
            ok = ok and parent is not None and is_visible(parent)
        visiting.discard(item.id)
        visible_cache[item.id] = ok
        return ok

    by_parent: dict = {}
    for item in items:
        by_parent.setdefault(item.parent_id, []).append(item)

    visible_top = [item for item in by_parent.get(None, []) if is_visible(item)]

    def visible_children(item_id):
        return [c for c in by_parent.get(item_id, []) if is_visible(c)]

    return visible_top, visible_children


class MenuItemViewSet(viewsets.ModelViewSet):
    """Superadmin-only management of top-nav entries (2026-08-08, "add
    feature to add, update, delete top menu with submenu feature also")
    — the raw, unfiltered list + write endpoints for MenuAdminPage.tsx.
    Regular nav rendering uses MenuTreeView below instead, which is
    read-only, open to any authenticated user, and pre-filtered to what
    their own role/permissions actually allow.

    Delete cascades to children at the DB level (MenuItem.parent has
    on_delete=CASCADE) — the admin UI warns about this before deleting a
    parent with submenu items, matching the CRUD confirm-dialog
    convention used elsewhere in this app (Users, Tree Admin)."""
    queryset = MenuItem.objects.all().order_by('order', 'id')
    serializer_class = MenuItemSerializer
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def perform_create(self, serializer):
        from .audit import log_audit_event
        serializer.save()
        log_audit_event(self.request, 'MENU_ITEM.CREATED', resource='menu_item',
                         resource_id=serializer.instance.pk, detail=serializer.instance.label)

    def perform_update(self, serializer):
        from .audit import log_audit_event
        serializer.save()
        log_audit_event(self.request, 'MENU_ITEM.UPDATED', resource='menu_item',
                         resource_id=serializer.instance.pk, detail=serializer.instance.label)

    def perform_destroy(self, instance):
        from .audit import log_audit_event
        log_audit_event(self.request, 'MENU_ITEM.DELETED', resource='menu_item',
                         resource_id=instance.pk, detail=instance.label)
        instance.delete()


class MenuTreeView(APIView):
    """GET /api/v2/menu-tree/ — the actual data the sidebar renders.
    Unlike MenuItemViewSet above (raw admin CRUD), this returns only
    ACTIVE items the requesting user's role/permissions allow, already
    nested into a parent->children tree AT ANY DEPTH (2026-08-08 follow-
    up — submenus are no longer capped at one level), so the frontend
    doesn't need to duplicate any gating logic — same "server resolves
    visibility, client just renders" split as MeSerializer.permissions /
    isAllowed() elsewhere in this app.

    `serialize()` recurses through `visible_children(item.id)` at every
    level — a child is only ever considered if its parent already passed
    the visibility check (see get_visible_menu_items' docstring), so an
    item whose ancestor is hidden at ANY depth can't leak through as an
    orphaned entry."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        visible_top, visible_children = get_visible_menu_items(request.user)

        def serialize(item):
            return {
                'id': item.id,
                'label': item.label,
                'link_type': item.link_type,
                'path': item.path,
                'icon': item.icon,
                # Uploaded icon image (2026-08-08 follow-up) takes
                # precedence over the emoji everywhere it's rendered —
                # the frontend just checks this first and falls back to
                # `icon` when null, same precedence MenuItemSerializer's
                # docstring describes for the admin-CRUD side.
                'icon_image_url': (
                    request.build_absolute_uri(item.icon_image.url) if item.icon_image else None
                ),
                'description': item.description,
                'children': [serialize(c) for c in visible_children(item.id)],
            }

        return Response([serialize(item) for item in visible_top])


MAX_LOGO_BYTES = 5 * 1024 * 1024  # 5MB — generous for a logo, cheap to enforce before decoding

# Ceiling for the idle-logout override (2026-08-25) — matches AuthContext.tsx's
# own MAX_IDLE_TIMEOUT_MINUTES exactly. A week-long idle session isn't an idle
# session; kept as a named constant so the two sides can't silently drift.
MAX_IDLE_TIMEOUT_MINUTES = 8 * 60


class BrandingSettingsView(APIView):
    """GET/PUT /api/v2/branding/ — the org-wide app name + logo shown in
    the sidebar brand block, the login page, and the browser tab icon
    (2026-08-08: "also add feature to customize logo and name").

    GET is public (AllowAny), NOT IsAuthenticated — unlike MenuTreeView,
    this one is read by LoginPage.tsx too, which by definition renders
    before the user has a token. There's nothing sensitive in the
    response (just a display name + a public image URL), so this is a
    deliberate exception rather than an oversight. PUT is
    superadmin-only, matching every other app-wide-setting write in this
    app (Permissions, Menu Admin, DT Bands).

    The logo is sent as a base64 data URL in a plain JSON body
    (`logo_data_url`), NOT multipart/form-data — deliberately matching
    this app's existing file-upload convention (BackupPage.tsx's site/
    sector import reads a file client-side and posts its parsed content
    as JSON) rather than introducing multipart handling + a FormData
    change to the shared apiFetch() client just for this one endpoint.

    Singleton — always operates on pk=1, `get_or_create`d on first
    access rather than requiring a migration to pre-seed a blank row
    (same lazy-singleton convention TreeView already uses for
    TreeSettings). Replacing the logo deletes the previous file first
    (`obj.logo.delete(save=False)`) so this doesn't slowly accumulate
    orphaned uploads — there is only ever one logo in use at a time."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsSuperadminOnly()]
        return [AllowAny()]

    def get_object(self):
        obj, _ = BrandingSettings.objects.get_or_create(pk=1)
        return obj

    def get(self, request):
        obj = self.get_object()
        data = BrandingSettingsSerializer(obj, context={'request': request}).data
        # Which sign-in methods to render (2026-08-23). This endpoint is
        # already the one public, pre-token payload LoginPage.tsx fetches, so
        # the flags ride along here rather than needing a second AllowAny
        # endpoint. Neither is sensitive: both are plainly visible from the
        # login form itself.
        data['sso_enabled'] = sso_config.is_configured()
        data['local_login_enabled'] = sso_config.local_login_enabled()
        # Inactivity auto-logout, in minutes (2026-08-23, "autologout time
        # should be configurable"; 2026-08-25 follow-up, "session time for
        # logout is very low, add a feature to customize session time for
        # logout" — added the DB override below so this is actually
        # changeable in-app, not just via env var + restart). Rides the same
        # public payload for the same reason as the flags above, and because
        # AuthProvider — which owns the idle timer — needs it before any
        # authenticated request has happened. The DB value (superadmin-set,
        # via PUT below) wins when present; NULL falls back to the env var,
        # so an install that never touches this setting is unaffected. 0
        # means auto-logout is off, at either layer.
        data['idle_timeout_minutes'] = (
            obj.idle_timeout_minutes
            if obj.idle_timeout_minutes is not None
            else getattr(settings, 'IDLE_TIMEOUT_MINUTES', 5)
        )
        return Response(data)

    # Plain-text fields (2026-08-08 follow-up: "let superadmin to
    # customize the login interface texts also") — simple attribute
    # copies, no upload/validation involved, unlike the logo. Listed once
    # here so put() doesn't repeat the same "if present, set it" line 5
    # times.
    TEXT_FIELDS = [
        'app_name', 'login_subtitle', 'login_username_label', 'login_password_label', 'login_button_text',
        'login_disclaimer', 'footer_text', 'footer_developed_by',
    ]

    def put(self, request):
        obj = self.get_object()
        body = request.data or {}

        for field in self.TEXT_FIELDS:
            value = body.get(field)
            if value is not None:
                setattr(obj, field, value)

        # Idle-logout override (2026-08-25, "add a feature to customize
        # session time for logout"). Distinct from the TEXT_FIELDS loop
        # above because unlike blank text (which just means "unset"), 0 is
        # a meaningful value here (auto-logout disabled) and must not be
        # treated as falsy/absent. `in body` (not `body.get(...) is not
        # None`) is what lets a client explicitly send null to reset back
        # to the env-var default, same as leaving the field out entirely —
        # both mean "no override" — while any integer (including 0) sets
        # one. Only the ceiling (MAX_IDLE_TIMEOUT_MINUTES, mirroring
        # AuthContext.tsx's own constant) is enforced server-side, not the
        # 1-minute floor AuthContext.tsx clamps *non-zero* values to — 0 is
        # a valid, meaningful value here (disables auto-logout, same as
        # IDLE_TIMEOUT_MINUTES=0) and must stay reachable, so the only real
        # invariant to enforce at this layer is "not negative, not absurd".
        if 'idle_timeout_minutes' in body:
            raw = body.get('idle_timeout_minutes')
            if raw is None or raw == '':
                obj.idle_timeout_minutes = None
            else:
                try:
                    minutes = int(raw)
                except (TypeError, ValueError):
                    return Response(
                        {'idle_timeout_minutes': ['Must be a whole number of minutes.']},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if minutes < 0 or minutes > MAX_IDLE_TIMEOUT_MINUTES:
                    return Response(
                        {
                            'idle_timeout_minutes': [
                                f'Must be between 0 and {MAX_IDLE_TIMEOUT_MINUTES} minutes (0 disables auto-logout).'
                            ]
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                obj.idle_timeout_minutes = minutes

        # Explicit reset-to-default, checked BEFORE a new upload so a
        # single request can't sensibly do both — "remove_logo" wins if
        # somehow both are sent, since it's the more explicit signal.
        if body.get('remove_logo'):
            if obj.logo:
                obj.logo.delete(save=False)
            obj.logo = None
        elif body.get('logo_data_url'):
            try:
                raw, ext = decode_data_url_image(body['logo_data_url'], MAX_LOGO_BYTES)
            except DataUrlImageError as exc:
                return Response({'logo_data_url': [str(exc)]}, status=status.HTTP_400_BAD_REQUEST)
            if obj.logo:
                obj.logo.delete(save=False)
            obj.logo.save(f'logo.{ext}', ContentFile(raw), save=False)

        obj.save()
        from .audit import log_audit_event
        changed_fields = [f for f in self.TEXT_FIELDS if body.get(f) is not None]
        if body.get('remove_logo'):
            changed_fields.append('logo (removed)')
        elif body.get('logo_data_url'):
            changed_fields.append('logo')
        log_audit_event(request, 'BRANDING.UPDATED', resource='branding', detail=', '.join(changed_fields))
        return Response(BrandingSettingsSerializer(obj, context={'request': request}).data)


class SecuritySettingsView(APIView):
    """GET/PUT /api/v2/security-settings/ -- the superadmin-controlled
    `mfa_required` toggle (2026-10-02, Phase C). GET is IsAuthenticated
    (not AllowAny like Branding) -- unlike app branding, whether MFA is
    mandatory isn't something a pre-login visitor needs to know, and the
    Security page that reads this (to show the right copy about whether
    enrollment is optional or required) only ever renders for a logged-in
    user. PUT is superadmin-only, same tier as every other app-wide toggle
    in this app, audit-logged the same way BrandingSettingsView.put() is."""
    permission_classes = [IsAuthenticated]

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsSuperadminOnly()]
        return [IsAuthenticated()]

    def get_object(self):
        obj, _ = SecuritySettings.objects.get_or_create(pk=1)
        return obj

    def get(self, request):
        obj = self.get_object()
        return Response({'mfa_required': obj.mfa_required})

    def put(self, request):
        obj = self.get_object()
        if 'mfa_required' in request.data:
            obj.mfa_required = bool(request.data['mfa_required'])
            obj.save()
        from .audit import log_audit_event
        log_audit_event(
            request, 'SECURITY_SETTINGS.UPDATED', resource='security_settings',
            detail=f'mfa_required={obj.mfa_required}',
        )
        return Response({'mfa_required': obj.mfa_required})


class UserViewSet(viewsets.ModelViewSet):
    """Read: superadmin or admin (matches v1's
    `_require_auth(roles=('superadmin', 'admin'))` on GET /users — Phase 1
    was stricter, superadmin-only; loosened here to match v1 exactly).
    Write (create/update/delete): superadmin-only, matching v1's POST/PUT/
    DELETE /users."""
    queryset = User.objects.all().order_by('username')

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return UserWriteSerializer
        return UserSerializer

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsAuthenticated(), IsSuperadminOnly()]
        return [IsAuthenticated(), IsAdminOrSuperadmin()]

    def perform_create(self, serializer):
        from .audit import log_audit_event
        serializer.save()
        log_audit_event(self.request, 'USER.CREATED', resource='user',
                         resource_id=serializer.instance.pk, detail=serializer.instance.username)

    def perform_update(self, serializer):
        from .audit import log_audit_event
        serializer.save()
        log_audit_event(self.request, 'USER.UPDATED', resource='user',
                         resource_id=serializer.instance.pk, detail=serializer.instance.username)

    def perform_destroy(self, instance):
        from .audit import log_audit_event
        log_audit_event(self.request, 'USER.DELETED', resource='user',
                         resource_id=instance.pk, detail=instance.username)
        instance.delete()


class PermissionsMatrixView(APIView):
    """Matches v1's /api/v1/permissions contract exactly (not the flat
    MenuPermissionViewSet above): GET/PUT a nested {role: {menu_key: bool
    | {read,write,update,delete: bool}}} dict, excluding superadmin (v1
    never stores role_permissions rows for superadmin — it's an implicit
    full-access role, not one gated by the table; see MeSerializer's
    permissions field / isAllowed() in the React client for the other
    half of this convention).
    PUT does a per-key upsert (same as ThresholdsView, NOT a full delete-
    and-replace) — matches v1's _write_role_perm exactly: a plain bool
    writes one action='read' row, a {read,write,update,delete} dict
    writes up to 4 rows. Superadmin-only write, matching v1's
    `_require_auth(roles=('superadmin',))` on PUT /permissions.

    2026-10-01 ("full parity" RBAC feature) — GET used to hardcode exactly
    two role keys (admin/viewer); now iterates every real `Role` row
    (excluding superadmin, same reasoning as always) so a custom role
    created via Manage Roles gets its own column here automatically, with
    no code change needed per role. `put()` was already role-agnostic
    (iterates whatever keys the client sends) — unchanged."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsSuperadminOnly()]
        return [IsAuthenticated()]

    def get(self, request):
        role_names = list(Role.objects.exclude(name='superadmin').values_list('name', flat=True))
        rows = MenuPermission.objects.filter(role__in=role_names)
        # Every real role's key always present, even with zero rows for
        # one of them (2026-08-25 live bug: a role with no MenuPermission
        # rows at all — e.g. a fresh/partially-seeded install, or a role
        # simply never having been saved yet — meant this dict silently
        # omitted that key entirely. PermissionsPage.tsx indexes
        # `draft[role][key]` unconditionally, so a missing role key
        # crashed the whole page with "Cannot read properties of
        # undefined (reading 'sites')" the instant it rendered.
        # Pre-seeding every key as {} makes "no rows yet" and "some rows"
        # the same shape, not two different ones the client has to guess
        # between.
        out: dict = {name: {} for name in role_names}
        for r in rows:
            role_out = out.setdefault(r.role, {})
            if r.menu_key in CRUD_MENUS:
                role_out.setdefault(r.menu_key, {})[r.action] = r.allowed
            else:
                role_out[r.menu_key] = r.allowed
        return Response(out)

    def put(self, request):
        from .audit import log_audit_event

        body = request.data or {}
        with transaction.atomic():
            for role, perms in body.items():
                for menu_key, value in (perms or {}).items():
                    if isinstance(value, dict):
                        for action, allowed in value.items():
                            MenuPermission.objects.update_or_create(
                                role=role, menu_key=menu_key, action=action,
                                defaults={'allowed': bool(allowed)},
                            )
                    else:
                        MenuPermission.objects.update_or_create(
                            role=role, menu_key=menu_key, action='read',
                            defaults={'allowed': bool(value)},
                        )
        log_audit_event(request, 'PERMISSIONS.UPDATED', resource='permissions', payload=body)
        return Response({'ok': True})


class MenuItemRoleVisibilityView(APIView):
    """GET/PUT /api/v2/menu-visibility/ (2026-10-01, "full parity" RBAC
    feature) — the admin side of the sparse MenuItemRoleVisibility
    override layered on top of get_visible_menu_items()'s own coarse
    access-tier checks (see that function's docstring for exactly how the
    two combine). Same nested-dict GET/per-key-upsert PUT convention as
    PermissionsMatrixView above, just keyed by (menu_item id, role name)
    instead of (role, menu_key).

    Sparse by design: GET only returns rows that actually exist (an
    omitted (item, role) pair means "inherit the default", which the
    frontend renders distinctly from an explicit True/False — see
    MenuVisibilityPage.tsx). PUT's `null` value DELETES the override row
    (the "reset to inherit" affordance), rather than writing a third
    tri-state value into the boolean column."""

    def get_permissions(self):
        if self.request.method == 'PUT':
            return [IsAuthenticated(), IsSuperadminOnly()]
        return [IsAuthenticated()]

    def get(self, request):
        out: dict = {}
        for row in MenuItemRoleVisibility.objects.select_related('role'):
            out.setdefault(str(row.menu_item_id), {})[row.role.name] = row.visible
        return Response(out)

    def put(self, request):
        from .audit import log_audit_event

        body = request.data or {}
        with transaction.atomic():
            for menu_item_id, role_map in body.items():
                for role_name, value in (role_map or {}).items():
                    role = Role.objects.filter(name=role_name).first()
                    if role is None:
                        continue
                    if value is None:
                        MenuItemRoleVisibility.objects.filter(
                            menu_item_id=menu_item_id, role=role,
                        ).delete()
                    else:
                        MenuItemRoleVisibility.objects.update_or_create(
                            menu_item_id=menu_item_id, role=role,
                            defaults={'visible': bool(value)},
                        )
        log_audit_event(request, 'MENU_VISIBILITY.UPDATED', resource='menu_visibility', payload=body)
        return Response({'ok': True})

