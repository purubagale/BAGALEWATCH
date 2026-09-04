"""
In-app admin surface for the crowdsourced telemetry pilot (2026-08-31) —
the "a superadmin admin page can come later" from
core/management/commands/telemetry_key.py, now built.

Three JWT-authenticated `/api/v2/` resources (same auth/tier posture as
core/api_auth.py's ApiKeyViewSet — the ingest keys these manage live in
their own table and authenticate a SEPARATE public surface at
`/api/telemetry/v1/`, exactly like ApiKey vs `/api/external/v1/`):

  * /api/v2/telemetry/keys/      — CRUD for TelemetryIngestKey (superadmin)
  * /api/v2/telemetry/stats/     — ingest volume overview (admin+)
  * /api/v2/telemetry/coverage/  — geohash-binned signal for the map (admin+)

The coverage endpoint prefers the already-rolled-up TelemetryCoverageBin
rows (what prune_telemetry.py leaves behind), and falls back to
aggregating recent raw TelemetrySample rows on the fly when no bin
matches the filter — so the map is useful immediately in a fresh
deployment where retention has never run and every point is still raw.
"""
from datetime import timedelta

from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.db.models import Count, Max, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    TelemetryBatch,
    TelemetryCoverageBin,
    TelemetryDriveTestConsent,
    TelemetryDriveTestSession,
    TelemetryIngestKey,
    TelemetryRemoteOptOutRequest,
    TelemetrySample,
)
from .telemetry import _scope_by_operator, generate_ingest_key, geohash_center, geohash_encode
from .views import IsAdminOrSuperadmin, IsSuperadminOnly

# Hard ceiling on how many raw rows the on-the-fly fallback will scan so a
# multi-million-row samples table can't turn one map request into a table
# scan. Same "cap what's processed, don't fabricate" posture as the
# frontend's subsampleForMap().
_MAX_RAW_SCAN = 200_000
_DEFAULT_COVERAGE_LIMIT = 5000
_MAX_COVERAGE_LIMIT = 20_000


# ── Ingest keys ───────────────────────────────────────────────────────

class TelemetryIngestKeySerializer(serializers.ModelSerializer):
    """`key_prefix`/`key_hash` are set server-side in perform_create and
    immutable after (read-only). The full plaintext key is returned ONLY
    from create() — never from any GET — mirroring ApiKeySerializer."""

    class Meta:
        model = TelemetryIngestKey
        fields = [
            'id', 'name', 'key_prefix', 'is_active', 'rate_limit_per_min',
            'created_at', 'last_used_at', 'expires_at',
        ]
        read_only_fields = ['id', 'key_prefix', 'created_at', 'last_used_at']


class TelemetryIngestKeyViewSet(viewsets.ModelViewSet):
    """Superadmin-only CRUD for the telemetry ingest credentials. No PUT
    (same reasoning as ApiKeyViewSet — the secret half is immutable, so a
    whole-object replace never makes sense); PATCH edits name / rate /
    active / expiry."""

    queryset = TelemetryIngestKey.objects.all()
    serializer_class = TelemetryIngestKeySerializer
    permission_classes = [IsAuthenticated, IsSuperadminOnly]
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def perform_create(self, serializer):
        full_key, prefix, key_hash = generate_ingest_key()
        serializer.save(
            key_prefix=prefix, key_hash=key_hash, created_by=self.request.user,
        )
        # In-memory only, never a column — just so create() can echo it once.
        serializer.instance._plaintext_key = full_key

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        data = dict(serializer.data)
        data['key'] = serializer.instance._plaintext_key
        headers = self.get_success_headers(serializer.data)
        return Response(data, status=status.HTTP_201_CREATED, headers=headers)


# ── Ingest volume overview ────────────────────────────────────────────

class TelemetryStatsView(APIView):
    """`GET /api/v2/telemetry/stats/` — headline numbers for the admin
    page: key counts, batch/sample totals, recent activity, coverage-bin
    rollup size, and a per-network breakdown of the last 7 days.

    Sample/bin numbers are scoped by the requesting user's operator_mncs
    (see telemetry.py's _scope_by_operator) — an operator-restricted admin
    only sees their own subscribers' counts. `keys`/`batches` are NOT
    scoped: ingest keys and upload batches aren't tied 1:1 to a single
    operator (one key can carry samples from any SIM), so there's no
    correct per-operator split of those two numbers to show — they stay
    global infrastructure counts for every admin tier that can see this
    page at all.
    """

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        now = timezone.now()
        day_ago = now - timedelta(days=1)
        week_ago = now - timedelta(days=7)

        batches = TelemetryBatch.objects.aggregate(
            batch_count=Count('id'),
            sample_total=Sum('sample_count'),
            last_received=Max('received_at'),
        )
        by_network = list(
            _scope_by_operator(TelemetrySample.objects.filter(received_at__gte=week_ago), request.user)
            .values('network_type')
            .annotate(samples=Count('id'))
            .order_by('-samples')
        )
        return Response({
            'keys': {
                'total': TelemetryIngestKey.objects.count(),
                'active': TelemetryIngestKey.objects.filter(is_active=True).count(),
            },
            'batches': {
                'count': batches['batch_count'] or 0,
                'sample_total': batches['sample_total'] or 0,
                'last_received_at': batches['last_received'],
            },
            'samples': {
                'last_24h': _scope_by_operator(
                    TelemetrySample.objects.filter(received_at__gte=day_ago), request.user
                ).count(),
                'last_7d': _scope_by_operator(
                    TelemetrySample.objects.filter(received_at__gte=week_ago), request.user
                ).count(),
            },
            'coverage_bins': _scope_by_operator(TelemetryCoverageBin.objects.all(), request.user).count(),
            'by_network_7d': by_network,
        })


# ── Coverage map data ─────────────────────────────────────────────────

def _bin_row(b):
    return {
        'lat': b.center_lat,
        'lng': b.center_lng,
        'geohash': b.geohash,
        'network_type': b.network_type,
        'region': b.region,
        'sample_count': b.sample_count,
        'device_count': b.device_count,
        'rsrp_mean': b.rsrp_mean,
        'rsrp_p10': b.rsrp_p10,
        'rsrp_min': b.rsrp_min,
        'rsrq_mean': b.rsrq_mean,
        'sinr_mean': b.sinr_mean,
        'last_ts': b.last_ts,
    }


def _aggregate_raw(qs, limit):
    """Roll recent raw TelemetrySample rows up into geohash-7 buckets in
    Python — the fallback when TelemetryCoverageBin has nothing for this
    filter yet (fresh deploy, retention not run). Bucketed the same way
    prune_telemetry.py does it, so the map looks identical either way."""
    acc = {}
    scanned = 0
    for lat, lng, nt, region, rsrp, rsrq, sinr, ts in qs.values_list(
        'lat', 'lng', 'network_type', 'region', 'rsrp_dbm', 'rsrq_db', 'sinr_db', 'ts',
    ).iterator(chunk_size=5000):
        scanned += 1
        if scanned > _MAX_RAW_SCAN:
            break
        if lat is None or lng is None:
            continue
        gh = geohash_encode(lat, lng, 7)
        key = (gh, nt)
        a = acc.get(key)
        if a is None:
            clat, clng = geohash_center(gh)
            a = acc[key] = {
                'geohash': gh, 'network_type': nt, 'region': region or '',
                'center_lat': clat, 'center_lng': clng, 'n': 0,
                'rsrp_sum': 0.0, 'rsrp_n': 0, 'rsrp_min': None,
                'rsrq_sum': 0.0, 'rsrq_n': 0, 'sinr_sum': 0.0, 'sinr_n': 0,
                'last_ts': ts,
            }
        a['n'] += 1
        if ts and (a['last_ts'] is None or ts > a['last_ts']):
            a['last_ts'] = ts
        if rsrp is not None:
            a['rsrp_sum'] += rsrp
            a['rsrp_n'] += 1
            a['rsrp_min'] = rsrp if a['rsrp_min'] is None else min(a['rsrp_min'], rsrp)
        if rsrq is not None:
            a['rsrq_sum'] += rsrq
            a['rsrq_n'] += 1
        if sinr is not None:
            a['sinr_sum'] += sinr
            a['sinr_n'] += 1

    rows = []
    for a in acc.values():
        rows.append({
            'lat': a['center_lat'],
            'lng': a['center_lng'],
            'geohash': a['geohash'],
            'network_type': a['network_type'],
            'region': a['region'],
            'sample_count': a['n'],
            'device_count': None,
            'rsrp_mean': round(a['rsrp_sum'] / a['rsrp_n'], 1) if a['rsrp_n'] else None,
            'rsrp_p10': None,
            'rsrp_min': a['rsrp_min'],
            'rsrq_mean': round(a['rsrq_sum'] / a['rsrq_n'], 1) if a['rsrq_n'] else None,
            'sinr_mean': round(a['sinr_sum'] / a['sinr_n'], 1) if a['sinr_n'] else None,
            'last_ts': a['last_ts'],
        })
    rows.sort(key=lambda r: r['sample_count'], reverse=True)
    return rows[:limit], scanned


class TelemetryCoverageView(APIView):
    """`GET /api/v2/telemetry/coverage/` — geohash-binned signal points
    for the coverage map.

    Query params (all optional):
      network_type=LTE|NR|UMTS|GSM|UNKNOWN
      region=<Site.region string>
      days=<int>      raw-fallback lookback window (default 30)
      limit=<int>     max bins returned (default 5000, hard cap 20000)

    Response:
      { source: "bins"|"samples", bins: [...], networks: [...],
        regions: [...], truncated: bool }

    Both the bin path and the raw fallback are scoped by the requesting
    user's operator_mncs (telemetry.py's _scope_by_operator): an
    operator-restricted admin's map only ever plots their own operator's
    coverage. Bins rolled up before the `mnc` column existed carry a blank
    mnc and so won't match any scoped filter — see TelemetryCoverageBin's
    `mnc` field comment; only an unrestricted (NTA/government/superadmin)
    account sees that pre-existing mixed-operator history.
    """

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        nt = (request.query_params.get('network_type') or '').strip().upper()
        region = (request.query_params.get('region') or '').strip()
        try:
            days = max(1, min(365, int(request.query_params.get('days', 30))))
        except (TypeError, ValueError):
            days = 30
        try:
            limit = int(request.query_params.get('limit', _DEFAULT_COVERAGE_LIMIT))
        except (TypeError, ValueError):
            limit = _DEFAULT_COVERAGE_LIMIT
        limit = max(1, min(_MAX_COVERAGE_LIMIT, limit))

        bin_qs = _scope_by_operator(TelemetryCoverageBin.objects.all(), request.user)
        if nt:
            bin_qs = bin_qs.filter(network_type=nt)
        if region:
            bin_qs = bin_qs.filter(region=region)
        bin_qs = bin_qs.exclude(center_lat__isnull=True).exclude(center_lng__isnull=True)

        total_bins = bin_qs.count()
        if total_bins:
            rows = [_bin_row(b) for b in bin_qs.order_by('-sample_count')[:limit]]
            source = 'bins'
            truncated = total_bins > limit
        else:
            raw_qs = _scope_by_operator(
                TelemetrySample.objects
                .filter(received_at__gte=timezone.now() - timedelta(days=days))
                .exclude(lat__isnull=True).exclude(lng__isnull=True),
                request.user,
            )
            if nt:
                raw_qs = raw_qs.filter(network_type=nt)
            if region:
                raw_qs = raw_qs.filter(region=region)
            rows, scanned = _aggregate_raw(raw_qs, limit)
            source = 'samples'
            truncated = scanned >= _MAX_RAW_SCAN

        scoped_bins = _scope_by_operator(TelemetryCoverageBin.objects.all(), request.user)
        scoped_samples = _scope_by_operator(
            TelemetrySample.objects.filter(received_at__gte=timezone.now() - timedelta(days=days)),
            request.user,
        )
        return Response({
            'source': source,
            'bins': rows,
            'truncated': truncated,
            'networks': sorted(
                scoped_bins.values_list('network_type', flat=True).distinct()
            ) or sorted(
                scoped_samples.values_list('network_type', flat=True).distinct()
            ),
            'regions': sorted(
                r for r in scoped_bins.values_list('region', flat=True).distinct() if r
            ) or sorted(
                r for r in scoped_samples.values_list('region', flat=True).distinct() if r
            ),
        })

# -- Live raw samples (dev/pilot-testing only) ---------------------------
_MAX_LIVE_LIMIT = 500
_DEFAULT_LIVE_LIMIT = 200
_MAX_LIVE_MINUTES = 24 * 60


class TelemetryLiveSamplesView(APIView):
    """`GET /api/v2/telemetry/live-samples/` -- raw, ungrouped, most-recent
    TelemetrySample rows, for verifying a test device's uploads during
    pilot development.

    Deliberately NOT part of the production Coverage page: that view only
    ever shows geohash-aggregated bins (device_count, not device_id), per
    the project brief's "aggregate coverage statistics preferred over
    keeping every raw GPS point" stance. This endpoint exposes individual
    points and device_id, which is exactly the per-subscriber location
    history the brief says never to build -- so it is superadmin-only,
    time-bounded (default 60 minutes, hard cap 24h), and row-capped, and
    it has no MenuItem / nav entry. It exists to answer "did my test
    device's last upload actually land with a real GPS fix", not as a
    general map feature.

    **Optional area filter (`lat`/`lng`/`radius_km`), added 2026-09-02**
    for TelemetryDriveTestSessionsPage's "search an area, enroll only the
    devices found there" flow: when all three are given, results are
    narrowed to samples within `radius_km` of the point, using the same
    `location__distance_lte=(Point(lng, lat), D(km=radius_km))` pattern
    as core/drive_test.py's `near()` action (radius clamped to the same
    [0.1, 50] km sane bounds). `device_id`, `minutes`, and `limit` still
    apply on top of the area filter, not instead of it -- this stays one
    endpoint with composable filters rather than a second one.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        try:
            minutes = int(request.query_params.get('minutes', 60))
        except (TypeError, ValueError):
            minutes = 60
        minutes = max(1, min(_MAX_LIVE_MINUTES, minutes))
        try:
            limit = int(request.query_params.get('limit', _DEFAULT_LIVE_LIMIT))
        except (TypeError, ValueError):
            limit = _DEFAULT_LIVE_LIMIT
        limit = max(1, min(_MAX_LIVE_LIMIT, limit))
        device_id = (request.query_params.get('device_id') or '').strip()

        window_start = timezone.now() - timedelta(minutes=minutes)
        qs = _scope_by_operator(
            TelemetrySample.objects
            .filter(received_at__gte=window_start)
            .exclude(lat__isnull=True)
            .exclude(lng__isnull=True),
            request.user,
        )
        if device_id:
            qs = qs.filter(device_id=device_id)

        lat_param = request.query_params.get('lat')
        lng_param = request.query_params.get('lng')
        if lat_param is not None and lng_param is not None:
            try:
                lat = float(lat_param)
                lng = float(lng_param)
            except (TypeError, ValueError):
                lat = lng = None
            if lat is not None and lng is not None:
                try:
                    radius_km = float(request.query_params.get('radius_km', 2))
                except (TypeError, ValueError):
                    radius_km = 2.0
                radius_km = max(0.1, min(radius_km, 50))
                point = Point(lng, lat, srid=4326)
                qs = qs.filter(location__distance_lte=(point, D(km=radius_km)))

        qs = qs.order_by('-received_at')

        rows = [
            {
                'device_id': s.device_id,
                'ts': s.ts,
                'received_at': s.received_at,
                'lat': s.lat,
                'lng': s.lng,
                'network_type': s.network_type,
                # mcc/mnc (2026-09-02) -- raw operator identifier, same
                # bare-MNC convention as TelemetryDriveTestSessionSamplesView
                # below and UsersPage's operator_mncs column.
                'mcc': s.mcc,
                'mnc': s.mnc,
                'rsrp_dbm': s.rsrp_dbm,
                'rsrq_db': s.rsrq_db,
                'sinr_db': s.sinr_db,
                # rssi_dbm (2026-09-03) -- GSM/UMTS (2G/3G) samples only
                # ever populate this, never rsrp_dbm/rsrq_db/sinr_db (LTE/
                # NR-only fields, see CellSampleCollector.kt's
                # parseCellInfo()). Without it, a real 2G/3G reading had
                # nowhere to show up here even though it was captured.
                'rssi_dbm': s.rssi_dbm,
                # rx_qual/rscp_dbm/ecio_db (2026-09-03) -- proper
                # RAN-standard 2G/3G metrics: GSM RxQual and WCDMA RSCP/
                # Ec-Io (see models.py's TelemetrySample field comment).
                'rx_qual': s.rx_qual,
                'rscp_dbm': s.rscp_dbm,
                'ecio_db': s.ecio_db,
                'trigger_reason': s.trigger_reason,
            }
            for s in qs[:limit]
        ]
        # Devices list mirrors `qs`'s own filters (window + area, when an
        # area was given) rather than re-deriving from a device_id-blind
        # copy of the window-only query -- so a caller searching an area
        # sees exactly "devices seen there," not every device seen anywhere
        # in the window.
        #
        # `.order_by()` here clears `qs`'s own `-received_at` ordering for
        # THIS derived query only (querysets are immutable, so `rows`
        # above still gets the ordered version) -- without it, Django has
        # to add `received_at` into the actual DISTINCT column list to
        # satisfy the ORDER BY (a documented Django/Postgres interaction:
        # "any fields used in an order_by() call are included in the SQL
        # SELECT columns"), which silently turns `SELECT DISTINCT
        # device_id` into `SELECT DISTINCT device_id, received_at` --
        # i.e. one "distinct" row per timestamp, not per device. That's
        # exactly the bug reported 2026-09-02 ("same device in two
        # different locations shows as multiple devices"): a device with
        # samples at 3 different received_at values was listed 3 times.
        devices = sorted(qs.order_by().values_list('device_id', flat=True).distinct())
        return Response({
            'samples': rows,
            'count': len(rows),
            'window_minutes': minutes,
            'devices': devices,
        })


# ── Scoped drive-test sessions over live telemetry (2026-09-01) ────────
# Generalizes TelemetryLiveSamplesView above into a first-class,
# promotable feature: instead of "any recent sample from anyone" gated
# purely by role (superadmin), a session scopes to devices an engineer
# explicitly enrolled for it, plus an optional area box and its own
# start/end window. See TelemetryDriveTestSession's docstring in
# models.py for why this is a new model rather than reusing
# DriveTestSession (the unrelated uploaded-.trp-file manager).
#
# `device_ids` are the SAME hashed values TelemetryLiveSamplesView's
# `devices` list already surfaces (and TelemetryStatsView's per-network
# breakdown draws from) — an engineer picks "the device that's currently
# sending" from that already-anonymized list, so nothing here ever
# handles a raw SDK device_id. Not superadmin-only: it's the consent
# scoping (not the role tier) that makes this safe for an ordinary
# network-planning admin, unlike the raw endpoint above.

_MAX_DT_SESSION_LIMIT = 5000


class TelemetryDriveTestSessionSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = TelemetryDriveTestSession
        fields = [
            'id', 'name', 'device_ids',
            'area_min_lat', 'area_max_lat', 'area_min_lng', 'area_max_lng',
            'require_consent', 'status', 'started_at', 'ended_at', 'created_by_name',
        ]
        read_only_fields = ['id', 'status', 'started_at', 'ended_at']

    def get_created_by_name(self, obj):
        if not obj.created_by_id:
            return None
        return obj.created_by.name or obj.created_by.username

    def validate_device_ids(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError('Select at least one device for this session.')
        device_ids = [str(v) for v in value]

        # Operator-scope check at creation time (2026-09-02), not just at
        # fetch time: an operator-restricted admin picking a device
        # outside their scope should get a clear validation error now,
        # rather than a session that silently returns zero samples later
        # and looks like a data problem instead of the access-control
        # decision it actually is. Unrestricted (NTA/government/
        # superadmin, empty operator_mncs) accounts skip this entirely.
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is not None and getattr(user, 'operator_mncs', None):
            # Most-recent-first per device (a device's reported mnc could
            # in principle vary between rows; keep the latest). A device
            # with no samples yet has no known operator and is allowed
            # through — there's nothing to violate scope on yet, and the
            # session's own samples view will apply the same scope filter
            # once real data arrives.
            seen_mncs = {}
            for d, m in (
                TelemetrySample.objects
                .filter(device_id__in=device_ids)
                .order_by('-received_at')
                .values_list('device_id', 'mnc')
                .iterator()
            ):
                seen_mncs.setdefault(d, m)
            out_of_scope = [
                d for d in device_ids
                if d in seen_mncs and seen_mncs[d] not in user.operator_mncs
            ]
            if out_of_scope:
                raise serializers.ValidationError(
                    f'{len(out_of_scope)} selected device(s) belong to an operator outside your access scope.'
                )
        return device_ids


class TelemetryDriveTestSessionListCreateView(APIView):
    """`GET/POST /api/v2/telemetry/dt-sessions/` — list recent sessions /
    start a new one. Admin+ (same tier as Coverage/Stats), not
    superadmin-only — see this section's header comment on why the
    consent scoping is what makes that safe here."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        qs = TelemetryDriveTestSession.objects.all()[:200]
        return Response(TelemetryDriveTestSessionSerializer(qs, many=True).data)

    def post(self, request):
        serializer = TelemetryDriveTestSessionSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        serializer.save(created_by=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class TelemetryDriveTestSessionDetailView(APIView):
    """`GET/DELETE /api/v2/telemetry/dt-sessions/<id>/` — retrieve or
    permanently remove a session record. Deleting a session only removes
    this scoping record, never any TelemetrySample rows (there is no FK
    to delete through — see the model docstring)."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, pk):
        session = get_object_or_404(TelemetryDriveTestSession, pk=pk)
        return Response(TelemetryDriveTestSessionSerializer(session).data)

    def delete(self, request, pk):
        get_object_or_404(TelemetryDriveTestSession, pk=pk).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TelemetryDriveTestSessionEndView(APIView):
    """`POST /api/v2/telemetry/dt-sessions/<id>/end/` — closes the
    session's time window (idempotent: ending an already-ended session
    just returns it unchanged). Samples uploaded by an enrolled device
    after this point stop appearing in this session's samples view —
    they're still collected normally by the anonymous pipeline, just no
    longer attributed to this drive-test run.

    Optional body: `{"request_opt_out": true}` (2026-09-02) — also leaves
    a TelemetryRemoteOptOutRequest for every device in `device_ids`, e.g.
    for a company/tester phone that should stop uploading once its
    drive-test run is done. NOT automatic on every end — this is a
    company-phone convenience, not something to do by default to a
    session that scoped ordinary crowdsourcing devices, so it's an
    explicit opt-in per call. The backend can only ever REQUEST this (see
    TelemetryRemoteOptOutRequest's docstring) — the device applies it to
    itself on its own next successful upload, it isn't instant.
    """

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def post(self, request, pk):
        session = get_object_or_404(TelemetryDriveTestSession, pk=pk)
        if session.status != 'ended':
            session.status = 'ended'
            session.ended_at = timezone.now()
            session.save(update_fields=['status', 'ended_at'])

        opted_out_count = 0
        if bool(request.data.get('request_opt_out')):
            for device_id in session.device_ids:
                # update_or_create, not get_or_create: a device that
                # already fulfilled a PAST opt-out request (e.g. it opted
                # back in since) must have `fulfilled_at` reset to None
                # here, or this new request would silently never reach the
                # device — get_or_create would just return that old,
                # already-fulfilled row untouched.
                TelemetryRemoteOptOutRequest.objects.update_or_create(
                    device_id=device_id,
                    defaults={
                        'requested_by': request.user,
                        'reason': f'Drive-test session "{session.name}" ended',
                        'fulfilled_at': None,
                    },
                )
                opted_out_count += 1

        data = TelemetryDriveTestSessionSerializer(session).data
        data['opt_out_requested_count'] = opted_out_count
        return Response(data)


class TelemetryDriveTestSessionSamplesView(APIView):
    """`GET /api/v2/telemetry/dt-sessions/<id>/samples/` — raw samples
    from this session's enrolled devices only, from `started_at` to
    `ended_at` (or now, for a still-active session), further bounded by
    the session's area box when one was set. Same raw-point response
    shape as TelemetryLiveSamplesView (individual device_id + lat/lng),
    but every device here is enrolled on purpose for this specific
    session — the scoping that makes this promotable to a real feature
    rather than staying a superadmin-only dev tool.

    Two independent filters on top of the session's own device/time/area
    scope, both added 2026-09-02:
      * operator scope (telemetry.py's _scope_by_operator) — defense in
        depth alongside the creation-time check in
        TelemetryDriveTestSessionSerializer.validate_device_ids, in case a
        device's reported operator changed after the session was created;
      * consent gate — when `session.require_consent` is True, only
        devices with a current TelemetryDriveTestConsent(consent=True) row
        are included. Both filters apply on every fetch, not just at
        session creation, so a live consent withdrawal or an operator-scope
        change takes effect on the very next request.
    """

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, pk):
        session = get_object_or_404(TelemetryDriveTestSession, pk=pk)
        try:
            limit = int(request.query_params.get('limit', _DEFAULT_LIVE_LIMIT))
        except (TypeError, ValueError):
            limit = _DEFAULT_LIVE_LIMIT
        limit = max(1, min(_MAX_DT_SESSION_LIMIT, limit))

        window_end = session.ended_at or timezone.now()
        qs = _scope_by_operator(
            TelemetrySample.objects
            .filter(device_id__in=session.device_ids, ts__gte=session.started_at, ts__lte=window_end)
            .exclude(lat__isnull=True)
            .exclude(lng__isnull=True),
            request.user,
        )
        if session.area_min_lat is not None:
            qs = qs.filter(
                lat__gte=session.area_min_lat, lat__lte=session.area_max_lat,
                lng__gte=session.area_min_lng, lng__lte=session.area_max_lng,
            )

        consent_summary = None
        if session.require_consent:
            consented_ids = set(
                TelemetryDriveTestConsent.objects
                .filter(device_id__in=session.device_ids, consent=True)
                .values_list('device_id', flat=True)
            )
            qs = qs.filter(device_id__in=consented_ids) if consented_ids else qs.none()
            consent_summary = {
                'consented': len(consented_ids),
                'pending': len(set(session.device_ids) - consented_ids),
            }

        qs = qs.order_by('-received_at')

        rows = [
            {
                'device_id': s.device_id,
                'ts': s.ts,
                'received_at': s.received_at,
                'lat': s.lat,
                'lng': s.lng,
                'network_type': s.network_type,
                # mcc/mnc (2026-09-02, "in the result i cant find operator
                # data") -- the raw operator identifier, same convention as
                # UsersPage's operator_mncs column (a bare MNC list, not a
                # fabricated "Nepal Telecom"/"Ncell" name mapping, per
                # User.operator_mncs' own docstring: MNC is the only real
                # per-operator identity this pipeline has).
                'mcc': s.mcc,
                'mnc': s.mnc,
                'rsrp_dbm': s.rsrp_dbm,
                'rsrq_db': s.rsrq_db,
                'sinr_db': s.sinr_db,
                # rssi_dbm (2026-09-03, "need to collect any 2g, 3g or 4g
                # data") -- GSM/UMTS samples only ever populate this, never
                # rsrp_dbm/rsrq_db/sinr_db (LTE/NR-only fields -- see
                # CellSampleCollector.kt's parseCellInfo()). Same fix as
                # TelemetryLiveSamplesView above.
                'rssi_dbm': s.rssi_dbm,
                # rx_qual/rscp_dbm/ecio_db (2026-09-03, "for 2g, rx level and
                # rx qual and for 3g rscp and ec/io") -- proper RAN-standard
                # 2G/3G metrics: GSM RxQual and WCDMA RSCP/Ec-Io (see
                # models.py's TelemetrySample field comment).
                'rx_qual': s.rx_qual,
                'rscp_dbm': s.rscp_dbm,
                'ecio_db': s.ecio_db,
                'trigger_reason': s.trigger_reason,
            }
            for s in qs[:limit]
        ]
        return Response({
            'session': TelemetryDriveTestSessionSerializer(session).data,
            'samples': rows,
            'count': len(rows),
            'require_consent': session.require_consent,
            'consent_summary': consent_summary,
        })
