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
import math

from django.db.models import Count
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import DriveTestSample, DriveTestSession
from .serializers import (
    DriveTestSessionDetailSerializer,
    DriveTestSessionListSerializer,
    DriveTestSessionNearSerializer,
    DriveTestSessionWriteSerializer,
)
from .views import IsAdminOrSuperadmin


def _haversine_km(lat1, lng1, lat2, lng2):
    """Plain great-circle distance, no external geo library — matches
    v1's own `_rsrpHaversineKm` (bts_monitor.html) exactly, same formula
    already ported client-side in lib/dtTemplateParser.ts's haversineKm.
    Kept as a free function here (not a queryset annotation/RawSQL) since
    Postgres has no PostGIS in this stack and the candidate set after the
    bounding-box prefilter below is small enough for a Python loop."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


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
        if self.action in ('create', 'destroy'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

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

        # Bounding-box prefilter in the DB (cheap index range scan) before
        # the exact haversine check in Python below — avoids pulling every
        # sample in the whole table just to compute distance on each one.
        lat_delta = radius_km / 111.0
        lng_delta = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.01))
        candidates = DriveTestSample.objects.filter(
            lat__gte=lat - lat_delta, lat__lte=lat + lat_delta,
            lng__gte=lng - lng_delta, lng__lte=lng + lng_delta,
        ).select_related('session')
        if tech_list:
            candidates = candidates.filter(session__tech__in=tech_list)

        by_session = {}
        for sample in candidates:
            if sample.lat is None or sample.lng is None:
                continue
            if _haversine_km(lat, lng, sample.lat, sample.lng) <= radius_km:
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
