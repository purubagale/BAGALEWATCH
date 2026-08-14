"""
External data-exchange API (2026-08-12, "add feature to create api to
share certain data of system to other and to receive certain data from
other system") — mounted at `/api/external/v1/`, deliberately its own
top-level prefix, NOT under `/api/v2/` (the React app's own JWT-
authenticated contract). See core/api_auth.py's module docstring for the
full auth-design reasoning (header-based API keys, scoped per key,
superadmin-only management).

**Scope, per explicit user decisions (AskUserQuestion, 2026-08-12):**
both directions (share out + receive in), covering Sites & Sectors and
Drive Test sessions/samples only — KPI thresholds/SLA data and an
Alarms category were both offered and NOT selected (Alarms doubly so:
there is no alarm/fault model anywhere in v2 to expose in the first
place, see the research pass that preceded this feature).

**What this deliberately does NOT do:**
- No DELETE anywhere in this module. An external system can create and
  update Sites/Sectors/DT sessions, and append DT samples, but can never
  remove data from BAGALEWATCH — matching the "share/receive," not "full
  remote CRUD," framing of the original request. Deleting a site/session
  a superadmin cares about should always be a deliberate in-app action.
- Sector upserts are ADDITIVE only (matched by `cell_name`, created or
  updated, never deleted) — see ExternalSiteWriteSerializer's docstring
  for why this differs from the internal API's "full replace" sector
  contract.
- No unbounded responses. Every list endpoint is paginated (see
  `ExternalApiPagination`/`ExternalSamplePagination` below) and every
  bulk-write endpoint has a hard per-request cap (`MAX_BULK_SITES`,
  `MAX_SAMPLES_PER_REQUEST`) — same "never render/return an unbounded
  table" rule this app already enforces on its own UI (memory
  `feedback_unbounded_result_tables_crash_browser.md`), extended here to
  an external API response, where an unbounded payload is just as real a
  failure mode for whatever's consuming it.
"""
from django.db.models import Count
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import pagination
from rest_framework.response import Response
from rest_framework.views import APIView

from .api_auth import ApiKeyAuthentication, ApiKeyRateThrottle, require_scope
from .models import DriveTestSample, DriveTestSession, Sector, Site
from .serializers import (
    DriveTestSampleSerializer,
    ExternalDtSessionCreateSerializer,
    ExternalDtSessionListSerializer,
    ExternalSiteDetailSerializer,
    ExternalSiteListSerializer,
    ExternalSiteWriteSerializer,
    _nearby_site_ids,
)

MAX_BULK_SITES = 500
MAX_SAMPLES_PER_REQUEST = 5000


class ExternalApiPagination(pagination.PageNumberPagination):
    """Sites and DT-session lists — a page is a handful of KB even at max
    size, comfortable for any HTTP client to hold in memory."""
    page_size = 100
    page_size_query_param = 'page_size'
    max_page_size = 500


class ExternalSamplePagination(pagination.PageNumberPagination):
    """DT sample lists — a single session can have 100,000+ rows (see
    DriveTestSample's own docstring), so this stays well below that no
    matter what `page_size` a caller requests."""
    page_size = 500
    page_size_query_param = 'page_size'
    max_page_size = 2000


class ExternalApiView(APIView):
    """Shared base for every view in this module: API-key auth ONLY (no
    JWT/session fallback — see ApiKeyAuthentication's docstring on why
    that separation matters) and the per-key rate throttle. Each subclass
    still declares its own `get_permissions()` to require the specific
    scope(s) its action needs."""
    authentication_classes = [ApiKeyAuthentication]
    throttle_classes = [ApiKeyRateThrottle]


# ── Sites & Sectors ──────────────────────────────────────────────────────

def _upsert_site(raw):
    """Creates or updates one Site from an already-shaped dict (one item
    of the request body — see ExternalSiteListCreateView.post). Returns a
    per-item result dict; never raises, so a bulk request can report
    partial success/failure per site rather than the whole batch failing
    on one bad row."""
    if not isinstance(raw, dict):
        return {'id': None, 'status': 'error', 'errors': {'non_field_errors': ['Each item must be a JSON object.']}}
    ser = ExternalSiteWriteSerializer(data=raw)
    if not ser.is_valid():
        return {'id': raw.get('id'), 'status': 'error', 'errors': ser.errors}

    validated = dict(ser.validated_data)
    # Read back the VALIDATED id (CharField-coerced), not the raw request
    # value — a caller that sent a bare JSON number for `id` (e.g.
    # `"id": 123` without quotes) would otherwise upsert against a
    # differently-typed key than what get_or_create below actually uses.
    site_id = validated.pop('id')
    sectors_data = validated.pop('sectors', None)

    site, created = Site.objects.get_or_create(id=site_id)
    for field, value in validated.items():
        setattr(site, field, value)
    site.updated_at = timezone.now()
    site.save()

    if sectors_data:
        for sector_fields in sectors_data:
            sector_fields = dict(sector_fields)
            cell_name = sector_fields.get('cell_name')
            if cell_name:
                sector, _ = Sector.objects.get_or_create(site=site, cell_name=cell_name)
                for field, value in sector_fields.items():
                    setattr(sector, field, value)
                sector.save()
            else:
                # No cell_name to match against — this can only ever be a
                # new row, never an update (see ExternalSiteWriteSerializer's
                # docstring: sectors are matched by cell_name).
                Sector.objects.create(site=site, **sector_fields)

    return {'id': site_id, 'status': 'created' if created else 'updated'}


class ExternalSiteListCreateView(ExternalApiView):
    """`GET/POST /api/external/v1/sites/`

    GET (scope `sites:read`) — paginated list, optionally filtered by
    `?region=`, `?district=`, `?updated_since=<ISO 8601 datetime>`.

    POST (scope `sites:write`) — upserts one site (a single JSON object
    body) or many (a JSON array, capped at `MAX_BULK_SITES`). Matched by
    `id`; creates a new row if that id doesn't exist yet. Response is a
    single result object for a single-object request, or an array of
    per-item results for a bulk request — HTTP status is 200 (all ok),
    207 (mixed — some items in a bulk request failed validation) or 400
    (single-object request failed, or every item in a bulk request
    failed)."""

    def get_permissions(self):
        scope = 'sites:write' if self.request.method == 'POST' else 'sites:read'
        return [require_scope(scope)()]

    def get(self, request):
        qs = Site.objects.all().order_by('id')
        region = request.query_params.get('region')
        district = request.query_params.get('district')
        updated_since = request.query_params.get('updated_since')
        if region:
            qs = qs.filter(region=region)
        if district:
            qs = qs.filter(district=district)
        if updated_since:
            parsed = parse_datetime(updated_since)
            if parsed is None:
                return Response({'updated_since': ['Invalid ISO 8601 datetime.']}, status=400)
            qs = qs.filter(updated_at__gte=parsed)
        paginator = ExternalApiPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(ExternalSiteListSerializer(page, many=True).data)

    def post(self, request):
        payload = request.data
        is_bulk = isinstance(payload, list)
        items = payload if is_bulk else [payload]
        if not items:
            return Response({'detail': 'Request body must be a site object or a non-empty list of site objects.'}, status=400)
        if len(items) > MAX_BULK_SITES:
            return Response({'detail': f'Max {MAX_BULK_SITES} sites per request.'}, status=400)

        results = [_upsert_site(item) for item in items]
        errored = [r for r in results if r['status'] == 'error']
        if not is_bulk:
            r = results[0]
            return Response(r, status=400 if r['status'] == 'error' else 200)
        if not errored:
            return Response(results, status=200)
        return Response(results, status=400 if len(errored) == len(results) else 207)


class ExternalSiteDetailView(ExternalApiView):
    """`GET /api/external/v1/sites/<id>/` (scope `sites:read`) — includes
    the full sector list and 2G/3G KPI JSON blobs the list endpoint
    leaves out."""

    def get_permissions(self):
        return [require_scope('sites:read')()]

    def get(self, request, site_id):
        site = Site.objects.filter(id=site_id).prefetch_related('sectors').first()
        if site is None:
            return Response({'detail': 'Site not found.'}, status=404)
        return Response(ExternalSiteDetailSerializer(site).data)


# ── Drive Test sessions & samples ────────────────────────────────────────

class ExternalDtSessionListCreateView(ExternalApiView):
    """`GET/POST /api/external/v1/dt-sessions/`

    GET (scope `dt:read`) — paginated list, optionally filtered by
    `?tech=4G|3G|2G`, `?date_after=`, `?date_before=` (both `YYYY-MM-DD`).

    POST (scope `dt:write`) — creates one new session, with an optional
    inline batch of samples (capped at `MAX_SAMPLES_PER_REQUEST` — send
    the rest via `POST .../<id>/samples/`). `uploaded_by` is always null
    for an externally-created session (there is no BAGALEWATCH user to
    attribute it to); the creating key's name is stamped into
    `meta.created_via_api_key` instead, for traceability."""

    def get_permissions(self):
        scope = 'dt:write' if self.request.method == 'POST' else 'dt:read'
        return [require_scope(scope)()]

    def get(self, request):
        qs = DriveTestSession.objects.all().annotate(sample_count=Count('samples'))
        tech = request.query_params.get('tech')
        date_after = request.query_params.get('date_after')
        date_before = request.query_params.get('date_before')
        if tech:
            qs = qs.filter(tech=tech)
        if date_after:
            qs = qs.filter(date__gte=date_after)
        if date_before:
            qs = qs.filter(date__lte=date_before)
        paginator = ExternalApiPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(ExternalDtSessionListSerializer(page, many=True).data)

    def post(self, request):
        ser = ExternalDtSessionCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        validated = dict(ser.validated_data)
        samples_data = validated.pop('samples', [])
        if len(samples_data) > MAX_SAMPLES_PER_REQUEST:
            return Response(
                {'samples': [f'Max {MAX_SAMPLES_PER_REQUEST} samples per request — use POST .../<id>/samples/ to append the rest.']},
                status=400,
            )
        meta = validated.pop('meta', None) or {}
        meta['created_via_api_key'] = request.auth.name
        # Same nearby-site tagging the internal upload path computes
        # (see DriveTestSessionWriteSerializer.create) — reused here so
        # externally-created sessions work identically with the History
        # tab's search/tagging feature, not a second-class citizen.
        meta['nearby_site_ids'] = _nearby_site_ids((s.get('lat'), s.get('lng')) for s in samples_data)

        session = DriveTestSession.objects.create(uploaded_by=None, meta=meta, **validated)
        DriveTestSample.objects.bulk_create(
            [DriveTestSample(session=session, **s) for s in samples_data], batch_size=1000,
        )
        session.size_bytes = len(str(validated)) + len(str(meta)) + sum(len(str(s)) for s in samples_data)
        session.save(update_fields=['size_bytes'])

        # `sample_count` is normally an annotation on the queryset (see
        # get()/ExternalDtSessionDetailView) — this freshly-created
        # instance has no such attribute, so it's set directly here
        # before serializing, same trick DriveTestSessionNearSerializer's
        # `filtered_samples` uses elsewhere in this file.
        session.sample_count = len(samples_data)
        return Response(ExternalDtSessionListSerializer(session).data, status=201)


class ExternalDtSessionDetailView(ExternalApiView):
    """`GET /api/external/v1/dt-sessions/<id>/` (scope `dt:read`) —
    metadata only, matching the list contract. Deliberately does NOT
    inline the sample list (a session can have 100,000+ rows) — fetch
    those from `ExternalDtSampleListCreateView` below instead."""

    def get_permissions(self):
        return [require_scope('dt:read')()]

    def get(self, request, session_id):
        session = DriveTestSession.objects.filter(pk=session_id).annotate(sample_count=Count('samples')).first()
        if session is None:
            return Response({'detail': 'Session not found.'}, status=404)
        return Response(ExternalDtSessionListSerializer(session).data)


class ExternalDtSampleListCreateView(ExternalApiView):
    """`GET/POST /api/external/v1/dt-sessions/<id>/samples/`

    GET (scope `dt:read`) — paginated raw sample list for one session.

    POST (scope `dt:write`) — appends more samples to an EXISTING
    session (created via this API or the internal upload path — either
    is fine, there's no ownership check tying appends to whichever key
    created the session). Body is either a bare JSON array of samples, or
    `{"samples": [...]}`. Capped at `MAX_SAMPLES_PER_REQUEST` per call —
    call again for a larger batch. Does NOT recompute
    `meta.nearby_site_ids` on append (that's a create-time-only
    computation, same as the internal upload path); a session whose route
    grows substantially via repeated appends may need
    `backfill_nearby_sites` re-run against it, same as any other stale
    session."""

    def get_permissions(self):
        scope = 'dt:write' if self.request.method == 'POST' else 'dt:read'
        return [require_scope(scope)()]

    def _get_session(self, session_id):
        return DriveTestSession.objects.filter(pk=session_id).first()

    def get(self, request, session_id):
        session = self._get_session(session_id)
        if session is None:
            return Response({'detail': 'Session not found.'}, status=404)
        qs = session.samples.all().order_by('id')
        paginator = ExternalSamplePagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(DriveTestSampleSerializer(page, many=True).data)

    def post(self, request, session_id):
        session = self._get_session(session_id)
        if session is None:
            return Response({'detail': 'Session not found.'}, status=404)
        body = request.data
        payload = body if isinstance(body, list) else (body.get('samples') if isinstance(body, dict) else None)
        if not isinstance(payload, list):
            return Response({'detail': 'Request body must be a JSON array of samples, or {"samples": [...]}.'}, status=400)
        if len(payload) > MAX_SAMPLES_PER_REQUEST:
            return Response({'detail': f'Max {MAX_SAMPLES_PER_REQUEST} samples per request.'}, status=400)

        ser = DriveTestSampleSerializer(data=payload, many=True)
        ser.is_valid(raise_exception=True)
        DriveTestSample.objects.bulk_create(
            [DriveTestSample(session=session, **s) for s in ser.validated_data], batch_size=1000,
        )
        added = len(ser.validated_data)
        session.size_bytes = (session.size_bytes or 0) + sum(len(str(s)) for s in ser.validated_data)
        session.save(update_fields=['size_bytes'])
        return Response(
            {'session_id': session.id, 'samples_added': added, 'total_samples': session.samples.count()},
            status=201,
        )
