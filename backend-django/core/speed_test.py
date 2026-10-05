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

from django.core.cache import cache
from django.http import HttpResponse, StreamingHttpResponse
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_log import _client_ip

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
