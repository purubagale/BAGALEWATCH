"""Active speed test endpoints for the mobile app (2026-10-05).

The app runs one test only when the user taps Start: ping for latency, a timed
download, and a timed upload. These endpoints are the far end of that test.

They carry no data and store nothing. Each one is capped in size and rate
limited per client IP, so the endpoints can't be used to move bulk traffic
through the server. The app sends no MSISDN or device id here.

    GET  speedtest/ping/              204, no body
    GET  speedtest/download/?bytes=N  N bytes of incompressible data (capped)
    POST speedtest/upload/            reads the body, returns how many bytes it took (capped)
"""
import os
import time
from datetime import datetime
from datetime import timezone as dt_timezone

from django.core.cache import cache
from django.http import HttpResponse, StreamingHttpResponse
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_log import _client_ip
from .models import TelemetrySpeedResult
from .telemetry import hash_device_id, resolve_ingest_caller

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
DEFAULT_DOWNLOAD_BYTES = 6 * 1024 * 1024
CHUNK = 64 * 1024
# A full test makes about 13 requests. 60 a minute per IP leaves room for
# retries and still stops a loop from saturating the link.
RATE_PER_MIN = 60

# One random block, repeated. It's incompressible, so a proxy can't shrink it
# and make the link look faster than it is.
_BLOCK = os.urandom(CHUNK)


def _rate_limited(request):
    key = f'speedtest:{_client_ip(request)}:{int(time.time() // 60)}'
    cache.add(key, 0, timeout=120)
    try:
        count = cache.incr(key)
    except ValueError:
        return False
    return count > RATE_PER_MIN


class _SpeedTestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]


class SpeedTestPingView(_SpeedTestView):
    def get(self, request):
        if _rate_limited(request):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        response = HttpResponse(status=status.HTTP_204_NO_CONTENT)
        response['Cache-Control'] = 'no-store'
        return response


class SpeedTestDownloadView(_SpeedTestView):
    def get(self, request):
        if _rate_limited(request):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            size = int(request.query_params.get('bytes', DEFAULT_DOWNLOAD_BYTES))
        except (TypeError, ValueError):
            size = DEFAULT_DOWNLOAD_BYTES
        size = max(CHUNK, min(size, MAX_DOWNLOAD_BYTES))

        def chunks():
            remaining = size
            while remaining > 0:
                piece = _BLOCK[:remaining] if remaining < CHUNK else _BLOCK
                remaining -= len(piece)
                yield piece

        response = StreamingHttpResponse(chunks(), content_type='application/octet-stream')
        response['Content-Length'] = str(size)
        response['Cache-Control'] = 'no-store'
        return response


class SpeedTestUploadView(_SpeedTestView):
    def post(self, request):
        if _rate_limited(request):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        declared = request.META.get('CONTENT_LENGTH')
        if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
            return Response({'detail': 'upload too large'}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        received = 0
        while True:
            piece = request.read(CHUNK)
            if not piece:
                break
            received += len(piece)
            if received > MAX_UPLOAD_BYTES:
                return Response({'detail': 'upload too large'}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        return Response({'received_bytes': received})


# ── General speed test results (2026-10-07) ──────────────────────────────
# From the public, user-tapped Speed test card -- separate from the
# device-signed, trace-bound speed test above. Same ingest auth (shared key
# or signed device) as the regular sample batch endpoint.

SPEED_RESULT_RATE_PER_MIN = 20


def _speed_num(data, key, limit):
    value = data.get(key)
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= limit else None


class TelemetrySpeedResultIngestView(APIView):
    """`POST /api/telemetry/v1/speed-samples/` -- one result from the demo
    app's Speed test card. Body:
    `{"device_id": "<raw sdk id>", "ts": <epoch ms>, "ping_median_ms": ..,
      "jitter_ms": .., "download_mbps": .., "upload_mbps": ..,
      "network_type": "LTE", "rsrp_dbm": -90}`.

    Stored with the same hashed device_id a regular sample would carry, so a
    TelemetryDriveTestSession's existing device_id + time-window scope picks
    it up with no extra wiring -- see that model's docstring.
    """
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own ingest-key check, like TelemetryIngestView

    def post(self, request):
        device, key, err = resolve_ingest_caller(request)
        if err:
            return Response({'detail': err}, status=status.HTTP_401_UNAUTHORIZED)

        bucket_scope = key.key_prefix if key else (device.device_hash[:12] if device else 'unknown')
        bucket = f'telspeed:rl:{bucket_scope}:{int(time.time() // 60)}'
        cache.add(bucket, 0, timeout=120)
        try:
            if cache.incr(bucket) > SPEED_RESULT_RATE_PER_MIN:
                return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        except ValueError:
            pass

        data = request.data if isinstance(request.data, dict) else {}
        raw_device_id = str(data.get('device_id') or '').strip()
        if device is None and not raw_device_id:
            return Response({'detail': 'device_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        device_id = device.device_hash if device else hash_device_id(raw_device_id)

        try:
            ts = datetime.fromtimestamp(int(data['ts']) / 1000, tz=dt_timezone.utc)
        except (KeyError, TypeError, ValueError, OverflowError):
            return Response({'detail': 'ts (epoch ms) is required'}, status=status.HTTP_400_BAD_REQUEST)

        rsrp = data.get('rsrp_dbm')
        try:
            rsrp = int(rsrp) if rsrp is not None else None
            if rsrp is not None and not -160 <= rsrp <= 0:
                rsrp = None
        except (TypeError, ValueError):
            rsrp = None

        TelemetrySpeedResult.objects.create(
            device_id=device_id, ts=ts,
            ping_median_ms=_speed_num(data, 'ping_median_ms', 10_000),
            jitter_ms=_speed_num(data, 'jitter_ms', 10_000),
            download_mbps=_speed_num(data, 'download_mbps', 10_000),
            upload_mbps=_speed_num(data, 'upload_mbps', 10_000),
            network_type=str(data.get('network_type') or '').strip().upper()[:8],
            rsrp_dbm=rsrp,
        )
        return Response({'stored': True}, status=status.HTTP_201_CREATED)
