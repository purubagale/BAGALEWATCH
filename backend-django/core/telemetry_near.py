"""Telemetry sessions near a point (2026-10-12).

DT Data Manager's Explore page searches uploaded drive-test sessions
around a point. Drives recorded by phones are stored separately, as
telemetry samples, so Explore never showed them. This endpoint finds them
for the same point and radius, so Explore can add them when asked:

  * named Telemetry Drive Test sessions (TelemetryDriveTestSession), and
  * phone drives from Collections (CollectionSession rows that carry a
    drive_session_id: crowd, staff and team drives).

Operator trace sessions are left out on purpose. They are location traces
of one subscriber made for an investigation, not network measurements.

`GET /api/v2/telemetry/sessions-near/?lat=&lng=&radius_km=&tech=4G,3G,2G`

Admin and superadmin only, like the Telemetry Drive Test and Collections
pages these sessions come from. Points carry no device identifier.
"""
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.db.models import Count, Max, Min, Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import radio_band
from .cqi import sample_cqi_fields
from .models import CollectionSession, TelemetryDriveTestConsent, TelemetryDriveTestSession, TelemetrySample
from .telemetry import _scope_by_operator
from .telemetry_admin import ROUTE_MAX_ACCURACY_M
from .views import IsAdminOrSuperadmin

MAX_RADIUS_KM = 50.0
# Named sessions looked at, newest first, and points returned in all.
MAX_NAMED_SESSIONS = 200
MAX_POINTS = 4000
_POINT_FIELDS = (
    'lat', 'lng', 'ts', 'network_type', 'rsrp_dbm', 'rsrq_db', 'sinr_db', 'cqi', 'pci',
    'rscp_dbm', 'ecio_db', 'rssi_dbm', 'rx_qual', 'band', 'band_mhz',
)
# Explore's technology buttons, as the network types a phone reports.
_TECH_NETWORKS = {'4G': ('LTE', 'NR'), '3G': ('UMTS',), '2G': ('GSM',)}


def _float(raw):
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _points(qs, key, room):
    """Up to `room` plot points from `qs`, each tagged with its session key."""
    rows = []
    for s in qs.order_by('-ts').values(*_POINT_FIELDS)[:max(0, room)]:
        rows.append({
            'session': key,
            'lat': s['lat'], 'lng': s['lng'], 'ts': s['ts'], 'network_type': s['network_type'],
            'rsrp': s['rsrp_dbm'], 'rsrq': s['rsrq_db'], 'sinr': s['sinr_db'], 'pci': s['pci'],
            # A phone drive changes technology as it goes: 3G reports RSCP
            # and Ec/Io, 2G reports RSSI (RxLevel) and Rx quality.
            'rscp': s['rscp_dbm'], 'ecio': s['ecio_db'], 'rssi': s['rssi_dbm'], 'rxqual': s['rx_qual'],
            'band_label': radio_band.label(s['network_type'], s['band'], s['band_mhz']),
            'cqi': sample_cqi_fields(s['cqi'], s['sinr_db'], s['rsrq_db'], s['network_type'])['cqi_value'],
        })
    return rows


class TelemetrySessionsNearView(APIView):
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        lat = _float(request.query_params.get('lat'))
        lng = _float(request.query_params.get('lng'))
        radius_km = _float(request.query_params.get('radius_km')) or 1.0
        if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return Response({'detail': 'lat and lng are required.'}, status=400)
        radius_km = max(0.05, min(MAX_RADIUS_KM, radius_km))

        point = Point(lng, lat, srid=4326)
        # Samples in the area this user may see, with the same accuracy gate
        # the route plots use: a loose fix is not placed on a map.
        near = _scope_by_operator(
            TelemetrySample.objects.filter(location__distance_lte=(point, D(km=radius_km))), request.user,
        ).filter(Q(gps_accuracy_m__lte=ROUTE_MAX_ACCURACY_M) | Q(gps_accuracy_m__isnull=True))

        # ?tech=4G,3G keeps only readings taken on those technologies, so a
        # session is listed only if it has such readings in the area. No
        # tech, or all three, means no filter.
        wanted = [t for t in (request.query_params.get('tech') or '').split(',') if t in _TECH_NETWORKS]
        if wanted and len(wanted) < len(_TECH_NETWORKS):
            near = near.filter(network_type__in=[n for t in wanted for n in _TECH_NETWORKS[t]])

        sessions, points = [], []

        # Phone drives from Collections, found by the drive id on their samples.
        drives = {
            row['drive_session_id']: row
            for row in near.exclude(drive_session_id='').values('drive_session_id').annotate(
                n=Count('*'), first=Min('ts'), last=Max('ts'),
            )
        }
        for cs in CollectionSession.objects.filter(drive_session_id__in=drives.keys()).order_by('-started_at'):
            found = drives[cs.drive_session_id]
            key = f'collection:{cs.pk}'
            sessions.append({
                'key': key, 'kind': 'collection', 'id': str(cs.pk),
                'name': cs.get_source_display(),
                'source': cs.source, 'started_at': cs.started_at, 'ended_at': cs.ended_at,
                'samples_in_area': found['n'], 'first_ts': found['first'], 'last_ts': found['last'],
            })
            points += _points(
                near.filter(drive_session_id=cs.drive_session_id), key, MAX_POINTS - len(points),
            )

        # Named Telemetry Drive Test sessions: their devices, inside their
        # time window and area box, with the consent gate their own samples
        # view applies.
        now = timezone.now()
        for session in TelemetryDriveTestSession.objects.order_by('-started_at')[:MAX_NAMED_SESSIONS]:
            device_ids = list(session.device_ids or [])
            if session.require_consent:
                device_ids = list(
                    TelemetryDriveTestConsent.objects
                    .filter(device_id__in=device_ids, consent=True)
                    .values_list('device_id', flat=True)
                )
            if not device_ids:
                continue
            qs = near.filter(
                device_id__in=device_ids, ts__gte=session.started_at, ts__lte=session.ended_at or now,
            )
            if session.area_min_lat is not None:
                qs = qs.filter(
                    lat__gte=session.area_min_lat, lat__lte=session.area_max_lat,
                    lng__gte=session.area_min_lng, lng__lte=session.area_max_lng,
                )
            found = qs.aggregate(n=Count('*'), first=Min('ts'), last=Max('ts'))
            if not found['n']:
                continue
            key = f'telemetry_dt:{session.pk}'
            sessions.append({
                'key': key, 'kind': 'telemetry_dt', 'id': str(session.pk), 'name': session.name,
                'source': 'telemetry_dt', 'started_at': session.started_at, 'ended_at': session.ended_at,
                'samples_in_area': found['n'], 'first_ts': found['first'], 'last_ts': found['last'],
            })
            points += _points(qs, key, MAX_POINTS - len(points))

        sessions.sort(key=lambda s: s['started_at'], reverse=True)
        return Response({
            'sessions': sessions,
            'points': points,
            'truncated': len(points) >= MAX_POINTS,
        })
