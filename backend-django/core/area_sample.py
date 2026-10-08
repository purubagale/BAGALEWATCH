"""On-demand area sample (2026-10-08).

An engineer picks an area and asks the devices that are sharing there for
one fresh signal reading each, to compare live coverage against a stored
drive test.

Only devices that are opted in take part. The app sends its push token
when sharing starts and removes it when sharing stops (TelemetryPushToken),
so a device that is not sharing has no token here and is never asked. The
phone also checks its own opt-in before it answers.

The readings come back through the normal sample upload, as TelemetrySample
rows with trigger_reason 'on_demand'. Nothing here stores or returns a
phone number, an IMEI or a device id: the results are signal readings at a
place, plus a count of how many devices answered.
"""
import time
from datetime import timedelta

from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .fcm import send_sample_request_push
from .models import AreaSampleRequest, TelemetryPushToken, TelemetrySample
from .telemetry import _scope_by_operator, hash_device_id, resolve_ingest_caller
from .views import IsAdminOrSuperadmin

PUSH_TOKEN_RATE_PER_MIN = 30
REQUESTS_PER_USER_PER_MIN = 4
MAX_DEVICES_PER_REQUEST = 500
MAX_LOOKBACK_HOURS = 24
# How long after a request its readings are still counted as answers to it.
RESPONSE_WINDOW = timedelta(minutes=15)
MAX_RESULT_ROWS = 2000


class TelemetryPushTokenView(APIView):
    """`POST /api/telemetry/v1/push-token/` -- body
    `{"device_id": "<raw sdk id>", "fcm_token": "..."}`. Called by the app
    when sharing starts. An empty `fcm_token` removes the row, which the app
    sends when sharing stops. Same ingest auth as a sample upload."""
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own ingest-key check, like TelemetryIngestView

    def post(self, request):
        device, key, err = resolve_ingest_caller(request)
        if err:
            return Response({'detail': err}, status=status.HTTP_401_UNAUTHORIZED)

        scope = key.key_prefix if key else device.device_hash[:12]
        bucket = f'telpush:rl:{scope}:{int(time.time() // 60)}'
        cache.add(bucket, 0, timeout=120)
        try:
            if cache.incr(bucket) > PUSH_TOKEN_RATE_PER_MIN:
                return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        except ValueError:
            pass

        data = request.data if isinstance(request.data, dict) else {}
        raw_device_id = str(data.get('device_id') or '').strip()
        if device is None and not raw_device_id:
            return Response({'detail': 'device_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        device_id = device.device_hash if device else hash_device_id(raw_device_id)

        token = str(data.get('fcm_token') or '').strip()[:512]
        if not token:
            TelemetryPushToken.objects.filter(device_id=device_id).delete()
            return Response({'registered': False})
        TelemetryPushToken.objects.update_or_create(device_id=device_id, defaults={'fcm_token': token})
        return Response({'registered': True})


def _describe(req):
    return {
        'id': req.id,
        'label': req.label,
        'lat': req.lat,
        'lng': req.lng,
        'radius_km': req.radius_km,
        'lookback_hours': req.lookback_hours,
        'devices_in_area': req.devices_in_area,
        'pushes_sent': req.pushes_sent,
        'created_at': req.created_at,
        'requested_by': (req.requested_by.name or req.requested_by.username) if req.requested_by else None,
    }


class AreaSampleRequestListCreateView(APIView):
    """`GET/POST /api/v2/telemetry/area-samples/`.

    POST body `{"lat": .., "lng": .., "radius_km": 2, "lookback_hours": 24,
    "label": ".."}`. Finds the devices that uploaded a sample inside the
    circle during the lookback, keeps the ones that are sharing right now
    (they have a push token), and asks each for one reading. A device that
    has since left the circle still answers, but its reading falls outside
    the area and is not shown."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        qs = AreaSampleRequest.objects.select_related('requested_by')[:100]
        return Response({'results': [_describe(r) for r in qs]})

    def post(self, request):
        bucket = f'areasample:rl:{request.user.pk}:{int(time.time() // 60)}'
        cache.add(bucket, 0, timeout=120)
        try:
            if cache.incr(bucket) > REQUESTS_PER_USER_PER_MIN:
                return Response({'detail': 'Too many requests. Wait a minute and try again.'},
                                status=status.HTTP_429_TOO_MANY_REQUESTS)
        except ValueError:
            pass

        try:
            lat = float(request.data.get('lat'))
            lng = float(request.data.get('lng'))
        except (TypeError, ValueError):
            return Response({'detail': 'lat and lng are required'}, status=status.HTTP_400_BAD_REQUEST)
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return Response({'detail': 'lat or lng is out of range'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            radius_km = float(request.data.get('radius_km', 2))
        except (TypeError, ValueError):
            radius_km = 2.0
        radius_km = max(0.1, min(radius_km, 50))
        try:
            lookback_hours = int(request.data.get('lookback_hours', MAX_LOOKBACK_HOURS))
        except (TypeError, ValueError):
            lookback_hours = MAX_LOOKBACK_HOURS
        lookback_hours = max(1, min(lookback_hours, MAX_LOOKBACK_HOURS))
        label = str(request.data.get('label') or '').strip()[:120]

        since = timezone.now() - timedelta(hours=lookback_hours)
        point = Point(lng, lat, srid=4326)
        device_ids = list(
            _scope_by_operator(
                TelemetrySample.objects.filter(
                    received_at__gte=since, location__distance_lte=(point, D(km=radius_km)),
                ),
                request.user,
            ).order_by().values_list('device_id', flat=True).distinct()[:MAX_DEVICES_PER_REQUEST]
        )
        tokens = list(TelemetryPushToken.objects.filter(device_id__in=device_ids))

        req = AreaSampleRequest.objects.create(
            requested_by=request.user, label=label, lat=lat, lng=lng, radius_km=radius_km,
            lookback_hours=lookback_hours, devices_in_area=len(device_ids),
        )
        sent = sum(1 for t in tokens if send_sample_request_push(t.fcm_token, req.id))
        req.pushes_sent = sent
        req.save(update_fields=['pushes_sent'])

        log_audit_event(
            request, 'AREA_SAMPLE.REQUESTED', resource='area_sample_request', resource_id=str(req.id),
            detail=f'radius_km={radius_km} devices_in_area={len(device_ids)} sharing={len(tokens)} sent={sent}',
        )
        payload = _describe(req)
        payload['devices_sharing'] = len(tokens)
        return Response(payload, status=status.HTTP_201_CREATED)


class AreaSampleRequestSamplesView(APIView):
    """`GET /api/v2/telemetry/area-samples/<id>/samples/` -- the on-demand
    readings that arrived from inside the request's circle within
    RESPONSE_WINDOW of the request. No device id is returned; `devices`
    is the number of distinct devices that answered."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, pk):
        req = get_object_or_404(AreaSampleRequest, pk=pk)
        point = Point(req.lng, req.lat, srid=4326)
        qs = _scope_by_operator(
            TelemetrySample.objects.filter(
                trigger_reason='on_demand',
                received_at__gte=req.created_at,
                received_at__lte=req.created_at + RESPONSE_WINDOW,
                location__distance_lte=(point, D(km=req.radius_km)),
            ),
            request.user,
        )
        devices = qs.order_by().values('device_id').distinct().count()
        samples = [
            {
                'ts': s.ts,
                'lat': s.lat,
                'lng': s.lng,
                'gps_accuracy_m': s.gps_accuracy_m,
                'network_type': s.network_type,
                'pci': s.pci,
                'rsrp_dbm': s.rsrp_dbm,
                'rsrq_db': s.rsrq_db,
                'sinr_db': s.sinr_db,
                'rssi_dbm': s.rssi_dbm,
                'rscp_dbm': s.rscp_dbm,
                'ecio_db': s.ecio_db,
                'rx_qual': s.rx_qual,
                'cqi_derived': s.cqi_derived,
                'serving_site_id': s.serving_site_id,
                'serving_sector': s.serving_sector,
            }
            for s in qs.order_by('-received_at')[:MAX_RESULT_ROWS]
        ]
        open_until = req.created_at + RESPONSE_WINDOW
        return Response({
            'request': _describe(req),
            'devices': devices,
            'samples': samples,
            'open': timezone.now() < open_until,
            'open_until': open_until,
        })
