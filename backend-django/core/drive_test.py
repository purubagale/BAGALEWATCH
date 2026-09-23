"""
Drive-Test Data Manager (Phase 4a) — gets its own module for the same
reason kpi_trend.py/rf_audit.py do: real new models
(DriveTestSession/DriveTestSample), not aggregation over Site like
reports.py.

**Scope for this file, specifically**: the storage/CRUD layer only.
Uploaded records arrive here already parsed (TRP/GPX decoding stays
client-side for now — see DriveTestSession's docstring in models.py for
the full scope decision, confirmed via AskUserQuestion 2026-07-28). This
view layer doesn't know or care whether a sample came from a .trp file,
a CSV/XLSX template, or anything else — it just stores what it's given,
matching how v1's own server side (`bagalewatch_api.py`'s `dt-sessions`
resource) has zero parsing logic either; all of v1's parsing happens in
the browser before the already-decoded session ever reaches the server.
"""
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.db.models import Avg, Count, F, IntegerField, OuterRef, Subquery
from django.db.models.functions import Cast, Coalesce, Floor
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .dt_serving_cell import attach_serving_cells
from .models import (
    DriveTestSample,
    DriveTestSession,
    DriveTestSessionAttachment,
    OptimizationActivity,
    OptimizationActivitySession,
    Sector,
    Site,
)
from .serializers import (
    DT_SAMPLES_BATCH_SIZE,
    DriveTestSessionAttachmentSerializer,
    DriveTestSessionDetailSerializer,
    DriveTestSessionListSerializer,
    DriveTestSessionNearSerializer,
    DriveTestSessionWriteSerializer,
    OptimizationActivitySerializer,
    OptimizationActivitySessionSerializer,
    _bulk_insert_dt_samples,
    _coerce_dt_sample,
    _nearby_site_ids,
)
from .views import IsAdminOrSuperadmin


# Tech -> relevant signal-metric field names for the compare() action
# below. MUST mirror frontend-react/src/lib/dtBands.ts's metricsForTech()
# exactly (same tech strings, same field keys, same per-tech subset) --
# that file is the source of truth for which metrics are meaningful per
# tech; if it ever changes, update this dict to match. `rsrp` is reused
# as the generic dBm signal slot for all three techs (see
# DriveTestSample's own docstring in models.py), same convention the
# frontend keys off of.
DT_COMPARE_METRICS = {
    '2G': ['rsrp', 'rx_qual'],
    '3G': ['rsrp', 'ecno'],
    '4G': ['rsrp', 'rsrq', 'sinr', 'cqi'],
}

# Direction each metric improves in: +1 means "higher is better" (every
# metric here except rx_qual), -1 means "lower is better". Matches the
# same higher/lower-is-better distinction dtBands.ts's isPoorBand()
# comment calls out for RXQUAL_BANDS ("low value is GOOD, unlike every
# other metric here").
DT_COMPARE_DIRECTION = {'rx_qual': -1}

# Deadband (in the metric's own unit) below which a delta counts as
# "unchanged" rather than improved/degraded, for compare()'s summary
# percentages -- picked so ordinary measurement noise/drive-to-drive
# variance isn't reported as a real change. 2 (dB or dBm) for the
# dB-scale RF metrics (RSRP/RSCP/RSRQ/SINR/Ec-Io all read in whole-to-
# fractional dB, and are modem-quantized to 1/16-0.5 dB per
# SignalFloatField's own docstring, so 2 is comfortably above quantization
# noise while still catching a real tilt/config change). 1 for rx_qual,
# whose whole scale is only the small integers 0-7 (GSM RxQual), where a
# 2-unit deadband would be too coarse to ever register a change on such a
# short scale.
# `cqi` (LTE CQI, integer 0-15) gets the same 1.0 deadband as rx_qual's
# 0-7 scale, for the same reason: a short integer scale where the 2.0
# default deadband would be too coarse to ever register a real change.
# No DT_COMPARE_DIRECTION entry needed for cqi -- higher is better, same
# as every metric except rx_qual, and directionFor()'s fallback already
# defaults to +1 for anything not in that dict.
DT_COMPARE_DEADBAND = {'rx_qual': 1.0, 'cqi': 1.0}
DT_COMPARE_DEFAULT_DEADBAND = 2.0


def _dt_grid_aggregate(session_id, metrics):
    """One DB-level GROUP BY query for a single session's samples,
    binned into a coarse spatial grid cell -- used by compare() below to
    make two drive-test sessions' (rarely GPS-identical) routes
    comparable cell-by-cell. Returns
    `{(grid_lat, grid_lng): {'sample_count': N, <metric>: avg_or_None, ...}}`.

    Deliberately a single annotate/values/annotate query (Django's
    standard "GROUP BY these values() fields" idiom), not a Python loop
    over every row -- a single DriveTestSample session can have
    10,000-100,000+ rows (see the model's own docstring: "a single
    upload batch can be 120,000+ rows"), and comparing two sessions
    means this runs twice per request, so pulling every row into Python
    to bucket by hand would be the wrong tradeoff here.

    Grid: `floor(lat * 1000)` / `floor(lng * 1000)` as integer cell
    coordinates -- the same ~0.001-degree-per-cell coarseness
    `_nearby_site_ids()` in serializers.py already uses for its own
    "coarse ~100m grid" dedup (`round(lat, 3)`), just expressed as a
    DB-side `Floor()` instead of Python's `round()` so this can be a
    single server-side GROUP BY instead of an all-rows-into-Python pass.
    floor() vs round() shifts cell boundaries by up to half a cell
    relative to that other grid -- irrelevant here since this grid is
    only ever compared against itself (session A's cells vs session B's
    cells, both computed the exact same way), never against
    _nearby_site_ids's grid.

    Metric annotations are aliased as `avg_<metric>` rather than the bare
    metric name (e.g. `avg_rsrp`, not `rsrp`) -- annotating a queryset
    with a name that collides with one of the model's own field names
    raises `django.core.exceptions.FieldError` in Django, so the `avg_`
    prefix avoids that entirely rather than relying on `.values()`
    happening to mask it.
    """
    grid_lat = Cast(Floor(F('lat') * 1000), IntegerField())
    grid_lng = Cast(Floor(F('lng') * 1000), IntegerField())
    avg_annotations = {f'avg_{m}': Avg(m) for m in metrics}
    rows = (
        DriveTestSample.objects
        .filter(session_id=session_id, lat__isnull=False, lng__isnull=False)
        .annotate(grid_lat=grid_lat, grid_lng=grid_lng)
        .values('grid_lat', 'grid_lng')
        # .order_by() clears the model's default ordering (if any) so it
        # can't accidentally widen the GROUP BY beyond grid_lat/grid_lng.
        .order_by()
        .annotate(sample_count=Count('id'), **avg_annotations)
    )
    out = {}
    for r in rows:
        out[(r['grid_lat'], r['grid_lng'])] = {
            'sample_count': r['sample_count'],
            **{m: r[f'avg_{m}'] for m in metrics},
        }
    return out


def _attachment_count_expr():
    """Returns an annotation expression for how many
    DriveTestSessionAttachment rows a session has, safe to combine with
    a `sample_count=Count('samples')` annotation on the SAME queryset
    (2026-09-07, for the History table's new Attachments column).

    Deliberately a correlated Subquery, NOT a second
    `Count('attachments')` -- two Count()s over two DIFFERENT reverse
    relations in one queryset join both tables onto the session row, and
    the resulting cross-join multiplies both counts by each other's row
    count (a session with 5,000 samples and 2 attachments would report
    sample_count=10,000, not 5,000). A correlated subquery counts each
    relation in its own isolated query per row, so sample_count keeps
    its original single-join behavior completely unaffected. Used by
    both DriveTestSessionViewSet.queryset and near() below, which builds
    its own separate queryset rather than reusing self.queryset.
    """
    counts = (
        DriveTestSessionAttachment.objects.filter(session=OuterRef('pk'))
        .values('session').annotate(c=Count('id')).values('c')
    )
    return Coalesce(Subquery(counts), 0)


class DriveTestSessionViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """`/api/v2/dt-sessions/` — list (metadata only, matches v1's GET
    list contract) / retrieve (includes samples, matches v1's GET
    detail) / create (matches v1's POST) / destroy (matches v1's
    DELETE). No update/partial_update — see
    DriveTestSessionWriteSerializer's docstring on why v2 doesn't need
    v1's upsert-by-client-id PUT contract at all.

    Read: any authenticated role (matches v1: `_require_auth(conn,
    headers)` with no `roles=` restriction on either GET). Write
    (create/destroy): superadmin or admin only, matching v1's
    `_require_auth(roles=('superadmin', 'admin'))` on both POST and
    DELETE of `/dt-sessions`.
    """
    queryset = DriveTestSession.objects.all().annotate(
        sample_count=Count('samples'), attachment_count=_attachment_count_expr()
    ).prefetch_related('activity_links__activity')

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return DriveTestSessionDetailSerializer
        if self.action == 'create':
            return DriveTestSessionWriteSerializer
        return DriveTestSessionListSerializer

    def get_permissions(self):
        if self.action in ('create', 'destroy', 'samples', 'remarks'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        if self.action == 'attachments':
            # GET (list) is read-only, same tier as retrieve/list below;
            # POST (upload) needs the admin/superadmin write tier, same
            # as every other action that changes a session. Checked
            # again per-request in attachments() itself since a single
            # DRF @action can't declare different permissions per HTTP
            # method here.
            return [IsAuthenticated()]
        return [IsAuthenticated()]

    @action(detail=True, methods=['post'])
    def samples(self, request, pk=None):
        """`POST /api/v2/dt-sessions/<id>/samples/` — appends a batch of
        already-parsed samples to an EXISTING session. Companion to
        create() for large sessions: DtUploadPage.tsx's
        saveSessionChunked() now creates the session with an empty/small
        samples list, then calls this repeatedly with
        DT_SAMPLES_BATCH_SIZE-sized batches (2026-08-14 fix for a real
        "Could not save this session (HTTP 413)" a 363,082-sample .trp
        upload hit — see DT_SAMPLES_BATCH_SIZE's own comment in
        serializers.py for the full story).

        Purely additive, same as create() — bulk_create only, nothing
        here ever updates or deletes an existing sample or session.
        `meta.nearby_site_ids` is updated incrementally (this batch's
        site matches unioned into whatever was already there) rather
        than recomputed from scratch each call, so it converges to the
        same correct full-session set by the last batch without needing
        every prior batch's points in memory at once.
        """
        session = self.get_object()
        payload = request.data.get('samples')
        if not isinstance(payload, list) or not payload:
            return Response({'samples': ['This field is required and must be a non-empty list.']}, status=400)
        if len(payload) > DT_SAMPLES_BATCH_SIZE:
            return Response(
                {'samples': [f'Max {DT_SAMPLES_BATCH_SIZE} samples per request — send the rest as further requests.']},
                status=400,
            )
        # Fast fixed-shape coercion instead of a DRF many=True validation
        # pass, then a COPY-based bulk insert instead of a bulk_create of
        # geography rows — together ~420ms+3100ms -> ~50ms+1000ms per
        # 5000-row batch. See _coerce_dt_sample / _bulk_insert_dt_samples
        # in serializers.py.
        rows = [_coerce_dt_sample(r) for r in payload]
        # Serving-cell -> site attribution for this batch's samples (same
        # per-batch shape as _nearby_site_ids below). See
        # core/dt_serving_cell.py.
        attach_serving_cells(rows, session.tech or '4G')
        _bulk_insert_dt_samples(session.id, rows)
        new_site_ids = _nearby_site_ids((row.get('lat'), row.get('lng')) for row in rows)
        meta = session.meta or {}
        if new_site_ids:
            meta['nearby_site_ids'] = sorted(set(meta.get('nearby_site_ids') or []) | set(new_site_ids))
        session.meta = meta
        # O(1) size estimate — see the matching comment in
        # DriveTestSessionWriteSerializer.create(); rows are a fixed shape.
        per_sample = len(str(rows[0])) if rows else 0
        session.size_bytes = (session.size_bytes or 0) + per_sample * len(rows)
        session.save(update_fields=['meta', 'size_bytes'])
        return Response({'appended': len(rows)}, status=201)

    @action(detail=True, methods=['patch'])
    def remarks(self, request, pk=None):
        """`PATCH /api/v2/dt-sessions/<id>/remarks/` — the one field on an
        otherwise-immutable session that's actually meant to be edited
        after the fact (2026-09-07 request: "add... provision to provide
        remarks/comments on the session if needed"). Deliberately its
        own tiny action rather than a general update/partial_update on
        the viewset -- see the viewset's own docstring for why v2 has no
        such general update path; this opens exactly one field, nothing
        else about a saved session becomes editable.
        """
        session = self.get_object()
        remarks = request.data.get('remarks')
        if remarks is None or not isinstance(remarks, str):
            return Response({'remarks': ['This field is required and must be a string.']}, status=400)
        session.remarks = remarks
        session.save(update_fields=['remarks'])
        return Response({'remarks': session.remarks})

    @action(detail=True, methods=['get', 'post'], url_path='attachments')
    def attachments(self, request, pk=None):
        """`GET /api/v2/dt-sessions/<id>/attachments/` — list this
        session's attachments (also included inline in the detail
        serializer; this exists so the frontend can refresh just the
        attachment list after an upload/delete without re-fetching the
        whole session, which can carry tens of thousands of samples).

        `POST /api/v2/dt-sessions/<id>/attachments/` — uploads one or
        more files (multipart form, field name `files`, repeated for
        multiple -- 2026-09-07 request: "attaching multiple files
        related to the saved session"). Admin/superadmin only, checked
        here rather than in get_permissions() since GET on this same
        action is open to any authenticated role (see get_permissions()'s
        own comment). No file-type restriction -- this is generic
        supporting material (see DriveTestSessionAttachment's docstring
        in models.py), not a parsed input format this app validates.
        """
        session = self.get_object()
        if request.method == 'GET':
            qs = session.attachments.all()
            return Response(DriveTestSessionAttachmentSerializer(qs, many=True, context={'request': request}).data)

        if not (request.user.is_authenticated and request.user.role in ('superadmin', 'admin')):
            return Response({'detail': 'Not permitted.'}, status=403)

        files = request.FILES.getlist('files') or request.FILES.getlist('file')
        if not files:
            return Response({'files': ['At least one file is required (field name "files").']}, status=400)

        created = []
        for f in files:
            attachment = DriveTestSessionAttachment.objects.create(
                session=session, file=f, original_filename=f.name,
                size_bytes=f.size, uploaded_by=request.user,
            )
            created.append(attachment)
        return Response(
            DriveTestSessionAttachmentSerializer(created, many=True, context={'request': request}).data,
            status=201,
        )

    @action(detail=True, methods=['get'], url_path='serving-cells')
    def serving_cells(self, request, pk=None):
        """`GET /api/v2/dt-sessions/<id>/serving-cells/` — the distinct
        serving cells this session's samples were attributed to (by
        core/dt_serving_cell.py at upload time), each joined to its
        Site's coordinates and the Sector's azimuth. Small (~8-20 rows);
        the coverage map loads it once and, on hovering/selecting a plot
        point, draws a connector to `site_lat/site_lng` and shows this
        cell's name / sector / azimuth. Empty list when the session
        predates the attribution feature or no site directory was loaded
        when it was uploaded (re-upload or run
        `manage.py backfill_dt_serving_cells` to populate)."""
        session = self.get_object()
        groups = list(
            session.samples.exclude(serving_site_id__isnull=True)
            .values('serving_site_id', 'serving_cell_name', 'serving_sector', 'serving_local_cell_id', 'pci')
            .annotate(sample_count=Count('id'), mean_dist_km=Avg('serving_dist_km'))
        )
        site_ids = {g['serving_site_id'] for g in groups}
        sites = {s.id: s for s in Site.objects.filter(id__in=site_ids)}
        secs = {}
        for sec in Sector.objects.filter(site_id__in=site_ids):
            secs.setdefault((sec.site_id, sec.cell_name or ''), sec)
        out = []
        for g in groups:
            site = sites.get(g['serving_site_id'])
            sec = secs.get((g['serving_site_id'], g['serving_cell_name'] or ''))
            out.append({
                'pci': g['pci'],
                'site_id': g['serving_site_id'],
                'site_name': (site.name if site else None) or g['serving_site_id'],
                'site_lat': site.lat if site else None,
                'site_lng': site.lng if site else None,
                'cell_name': g['serving_cell_name'],
                'sector': g['serving_sector'],
                'local_cell_id': g['serving_local_cell_id'],
                'azimuth': sec.azimuth if sec else None,
                'sample_count': g['sample_count'],
                'mean_dist_km': round(g['mean_dist_km'], 2) if g['mean_dist_km'] is not None else None,
            })
        out.sort(key=lambda r: -r['sample_count'])
        return Response(out)

    @action(detail=False, methods=['get'])
    def near(self, request):
        """`GET /api/v2/dt-sessions/near/?lat=&lng=&radius_km=&tech=4G,3G,2G`
        — Phase 4d Explore-by-coordinate. Returns every session that has
        at least one sample within `radius_km` of the given point, each
        with `samples` trimmed down to just the in-radius readings (see
        DriveTestSessionNearSerializer's docstring).

        **Scope decision, matching the same real-data-only rule already
        applied to the DT auto-naming district resolver (Phase 4c):**
        v1's "By Coordinates" pane also supports searching by district
        name or matched city, which prefers a real district-boundary
        polygon or a site-derived convex hull over the plain radius
        circle (bts_monitor.html's `_coordSearchAreaShape`). That relies
        on `NEPAL_DISTRICT_BOUNDARIES`, a large embedded dataset that
        only has real boundary data for 30 of 77 districts and was never
        ported to v2 (see project_rsrp_2g3g_boundary_features memory —
        "never fabricate the rest"). This endpoint only implements v1's
        plain-coordinate radius-circle mode, which needs no boundary
        data at all and is honest about what it's showing: sites/DT
        points within a real distance of a real point, nothing inferred
        about district shape.
        """
        try:
            lat = float(request.query_params['lat'])
            lng = float(request.query_params['lng'])
        except (KeyError, ValueError, TypeError):
            return Response({'detail': 'lat and lng query params are required numbers'}, status=400)
        try:
            radius_km = float(request.query_params.get('radius_km', 2))
        except ValueError:
            radius_km = 2.0
        radius_km = max(0.1, min(radius_km, 50))  # sane bounds, matches v1's radius input constraints

        tech_param = request.query_params.get('tech')
        tech_list = [t for t in tech_param.split(',') if t] if tech_param else None

        # 2026-08-25, PostGIS adoption: single indexed ST_DWithin query via
        # the GiST index on DriveTestSample.location, replacing the old
        # bounding-box prefilter + exact haversine check in Python. No
        # separate "candidates" pass needed — the DB now does the exact
        # distance check itself.
        point = Point(lng, lat, srid=4326)
        candidates = DriveTestSample.objects.filter(
            location__distance_lte=(point, D(km=radius_km))
        ).select_related('session')
        if tech_list:
            candidates = candidates.filter(session__tech__in=tech_list)

        by_session = {}
        for sample in candidates:
            by_session.setdefault(sample.session_id, []).append(sample)

        if not by_session:
            return Response([])

        sessions = list(
            DriveTestSession.objects.filter(id__in=by_session.keys())
            .annotate(sample_count=Count('samples'), attachment_count=_attachment_count_expr())
            .prefetch_related('activity_links__activity')
        )
        for session in sessions:
            session.filtered_samples = by_session[session.id]
        sessions.sort(key=lambda s: (s.date or '', s.saved_at), reverse=True)

        return Response(DriveTestSessionNearSerializer(sessions, many=True, context={'request': request}).data)

    @action(detail=False, methods=['get'])
    def compare(self, request):
        """`GET /api/v2/dt-sessions/compare/?a=<id>&b=<id>` (2026-09-12)
        — a real numeric before/after comparison between two drive-test
        sessions, e.g. a baseline drive and a re-verify drive after an
        antenna-tilt/config change.

        This is ADDITIVE to, not a replacement for, the existing
        DtCompareMap.tsx frontend component: that one overlays up to
        MAX_COMPARE=4 sessions' raw points on one map (or per-metric
        panels), colored only by each point's own band value -- a
        side-by-side visual, no diff computed, and the two sessions'
        GPS tracks are never reconciled against each other. This
        endpoint actually bins both sessions' samples into a shared
        coarse spatial grid (see `_dt_grid_aggregate()` above) so their
        rarely-identical routes become comparable cell-by-cell, and
        returns per-cell averages/deltas plus summary stats -- something
        no existing endpoint or frontend view computes today.

        Two sessions of DIFFERENT tech are rejected (400) rather than
        silently compared -- comparing e.g. a 4G session to a 2G session
        would mix unrelated metrics and is almost certainly a user
        mistake; two sessions of the SAME tech are always allowed (an
        engineer comparing a 4G baseline to a 4G re-verify is exactly
        the intended use). The compared metric set is whichever tech
        both sessions share, via `DT_COMPARE_METRICS` above -- keep that
        dict in sync with frontend-react/src/lib/dtBands.ts's
        `metricsForTech()`, which is the source of truth for the
        tech -> metrics mapping.

        Read-only, IsAuthenticated only (falls through to
        get_permissions()'s final `return [IsAuthenticated()]` below --
        same tier as list/retrieve, not the admin/superadmin tier
        create/destroy/samples/remarks use).
        """
        a_id = request.query_params.get('a')
        b_id = request.query_params.get('b')
        if not a_id or not b_id:
            return Response({'detail': 'Query params "a" and "b" (session ids) are both required.'}, status=400)

        try:
            session_a = DriveTestSession.objects.get(pk=a_id)
        except (DriveTestSession.DoesNotExist, ValueError, TypeError):
            return Response({'detail': f'Session {a_id!r} (param "a") was not found.'}, status=404)
        try:
            session_b = DriveTestSession.objects.get(pk=b_id)
        except (DriveTestSession.DoesNotExist, ValueError, TypeError):
            return Response({'detail': f'Session {b_id!r} (param "b") was not found.'}, status=404)

        tech_a = session_a.tech or '4G'
        tech_b = session_b.tech or '4G'
        if tech_a != tech_b:
            return Response(
                {'detail': f'Sessions must be the same technology to compare (got {tech_a} and {tech_b}).'},
                status=400,
            )
        metrics = DT_COMPARE_METRICS.get(tech_a, DT_COMPARE_METRICS['4G'])

        cells_a = _dt_grid_aggregate(session_a.id, metrics)
        cells_b = _dt_grid_aggregate(session_b.id, metrics)
        keys_a = set(cells_a)
        keys_b = set(cells_b)
        matched_keys = keys_a & keys_b

        cells = []
        sum_delta = {m: 0.0 for m in metrics}
        n_delta = {m: 0 for m in metrics}
        improved = {m: 0 for m in metrics}
        degraded = {m: 0 for m in metrics}
        unchanged = {m: 0 for m in metrics}

        for key in sorted(matched_keys):
            row_a = cells_a[key]
            row_b = cells_b[key]
            grid_lat, grid_lng = key
            # Cell-center representative point (grid coords are the
            # cell's lower-left corner at 0.001-degree resolution).
            lat = (grid_lat + 0.5) / 1000.0
            lng = (grid_lng + 0.5) / 1000.0

            a_vals, b_vals, delta_vals = {}, {}, {}
            for m in metrics:
                va = row_a.get(m)
                vb = row_b.get(m)
                a_vals[m] = round(va, 2) if va is not None else None
                b_vals[m] = round(vb, 2) if vb is not None else None
                if va is None or vb is None:
                    delta_vals[m] = None
                    continue
                d = vb - va
                delta_vals[m] = round(d, 2)
                sum_delta[m] += d
                n_delta[m] += 1
                direction = DT_COMPARE_DIRECTION.get(m, 1)
                deadband = DT_COMPARE_DEADBAND.get(m, DT_COMPARE_DEFAULT_DEADBAND)
                signed = d * direction
                if signed > deadband:
                    improved[m] += 1
                elif signed < -deadband:
                    degraded[m] += 1
                else:
                    unchanged[m] += 1

            cells.append({
                'lat': round(lat, 4),
                'lng': round(lng, 4),
                'sample_count_a': row_a['sample_count'],
                'sample_count_b': row_b['sample_count'],
                'a': a_vals,
                'b': b_vals,
                'delta': delta_vals,
            })

        def _pct(numer, denom):
            return round(100.0 * numer / denom, 1) if denom else None

        avg_delta = {m: (round(sum_delta[m] / n_delta[m], 2) if n_delta[m] else None) for m in metrics}
        improved_pct = {m: _pct(improved[m], n_delta[m]) for m in metrics}
        degraded_pct = {m: _pct(degraded[m], n_delta[m]) for m in metrics}
        unchanged_pct = {m: _pct(unchanged[m], n_delta[m]) for m in metrics}

        def _session_summary(s):
            return {'id': s.id, 'name': s.name, 'date': s.date.isoformat() if s.date else None, 'tech': s.tech}

        return Response({
            'session_a': _session_summary(session_a),
            'session_b': _session_summary(session_b),
            'metrics': metrics,
            'cells': cells,
            'summary': {
                'matched_cells': len(matched_keys),
                'unmatched_cells_a': len(keys_a - keys_b),
                'unmatched_cells_b': len(keys_b - keys_a),
                'avg_delta': avg_delta,
                'improved_pct': improved_pct,
                'degraded_pct': degraded_pct,
                'unchanged_pct': unchanged_pct,
            },
        })


class DriveTestSessionAttachmentDetailView(APIView):
    """`DELETE /api/v2/dt-sessions/<session_id>/attachments/<attachment_id>/`
    — removes one attachment (and its stored file). A flat URL rather
    than a second nested @action on the viewset (DRF's router doesn't
    cleanly support a detail action with its OWN extra path segment
    beyond the session pk without a manual regex url_path, and an
    attachment id is already globally unique on its own) -- registered
    directly in urls.py alongside this viewset's router registration.

    Admin/superadmin only, matching every other action that changes a
    session (create/destroy/samples/remarks/attachments-upload above).
    """
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def delete(self, request, session_id, attachment_id):
        try:
            attachment = DriveTestSessionAttachment.objects.get(pk=attachment_id, session_id=session_id)
        except DriveTestSessionAttachment.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=404)
        attachment.file.delete(save=False)
        attachment.delete()
        return Response(status=204)


class OptimizationActivityViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """`/api/v2/dt-activities/` (2026-09-12) — groups a set of existing
    DriveTestSession rows into one named RF optimization effort (before
    drive -> change -> after drive, sometimes several rounds of that).
    See OptimizationActivity's docstring in models.py for the full
    workflow this exists for.

    No update/partial_update -- same "small enough to delete and
    recreate" call already made for other simple admin-only records in
    this app (e.g. no PATCH on TelemetryIngestKey beyond its own
    dedicated actions); an activity is just a name + notes + a set of
    session links, and editing name/notes wrong is cheap to fix by
    deleting and recreating, unlike a DriveTestSession's own
    deliberately-immutable samples.

    Read (list/retrieve): any authenticated role, matching
    DriveTestSessionViewSet's own read tier -- any engineer should be
    able to see what optimization efforts exist and which sessions they
    group, not just admins. Write (create/destroy) and the `sessions`
    attach/detach actions: superadmin or admin only, matching
    DriveTestSessionViewSet's write tier -- creating/dissolving an
    optimization record and deciding which drive tests belong to it is
    the same tier of change as uploading/deleting a session itself.
    """
    queryset = OptimizationActivity.objects.all()
    serializer_class = OptimizationActivitySerializer

    def get_permissions(self):
        if self.action in ('create', 'destroy', 'sessions'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def perform_create(self, serializer):
        user = self.request.user
        serializer.save(created_by=user if user and user.is_authenticated else None)

    @action(detail=True, methods=['post'], url_path='sessions')
    def sessions(self, request, pk=None):
        """`POST /api/v2/dt-activities/<id>/sessions/` — attaches an
        existing DriveTestSession to this activity with a role
        (baseline/after_change/re_verify) and an optional per-link note
        (see OptimizationActivitySession's docstring in models.py).
        Rejects a session already linked to THIS activity (400, matching
        this app's existing "clear message, not a raw IntegrityError"
        style elsewhere) rather than relying on the DB's unique_together
        constraint to surface as a 500 -- a session may still be freely
        linked to OTHER activities, or to this one again after being
        detached. Returns the activity's full current serialization
        (including its updated `sessions` list) so the frontend can
        refresh from this one response without a second fetch.
        """
        activity = self.get_object()
        link_serializer = OptimizationActivitySessionSerializer(data=request.data)
        link_serializer.is_valid(raise_exception=True)
        session = link_serializer.validated_data['session']
        if OptimizationActivitySession.objects.filter(activity=activity, session=session).exists():
            return Response(
                {'session': ['This session is already linked to this activity.']}, status=400
            )
        OptimizationActivitySession.objects.create(
            activity=activity,
            session=session,
            role=link_serializer.validated_data['role'],
            note=link_serializer.validated_data.get('note', ''),
        )
        return Response(OptimizationActivitySerializer(activity).data, status=201)


class OptimizationActivitySessionDetailView(APIView):
    """`DELETE /api/v2/dt-activities/<activity_id>/sessions/<link_id>/`
    — detaches one session from an activity. A flat URL rather than a
    second nested @action on the viewset, same reasoning as
    DriveTestSessionAttachmentDetailView above (a link id is already
    globally unique on its own, and DRF's router doesn't cleanly support
    a detail action with its own extra path segment beyond the activity
    pk) -- registered directly in urls.py alongside this viewset's
    router registration. Only removes the join row -- the
    DriveTestSession itself, its samples/meta/attachments, and any of
    its OTHER activity links are untouched.

    Admin/superadmin only, matching every other action that changes an
    activity (create/destroy/sessions-attach above).
    """
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def delete(self, request, activity_id, link_id):
        try:
            link = OptimizationActivitySession.objects.get(pk=link_id, activity_id=activity_id)
        except OptimizationActivitySession.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=404)
        link.delete()
        return Response(status=204)
