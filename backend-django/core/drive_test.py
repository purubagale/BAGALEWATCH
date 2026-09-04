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
from django.db.models import Avg, Count
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .dt_serving_cell import attach_serving_cells
from .models import DriveTestSample, DriveTestSession, Sector, Site
from .serializers import (
    DT_SAMPLES_BATCH_SIZE,
    DriveTestSessionDetailSerializer,
    DriveTestSessionListSerializer,
    DriveTestSessionNearSerializer,
    DriveTestSessionWriteSerializer,
    _bulk_insert_dt_samples,
    _coerce_dt_sample,
    _nearby_site_ids,
)
from .views import IsAdminOrSuperadmin


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
    queryset = DriveTestSession.objects.all().annotate(sample_count=Count('samples'))

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return DriveTestSessionDetailSerializer
        if self.action == 'create':
            return DriveTestSessionWriteSerializer
        return DriveTestSessionListSerializer

    def get_permissions(self):
        if self.action in ('create', 'destroy', 'samples'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
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
            DriveTestSession.objects.filter(id__in=by_session.keys()).annotate(sample_count=Count('samples'))
        )
        for session in sessions:
            session.filtered_samples = by_session[session.id]
        sessions.sort(key=lambda s: (s.date or '', s.saved_at), reverse=True)

        return Response(DriveTestSessionNearSerializer(sessions, many=True, context={'request': request}).data)
