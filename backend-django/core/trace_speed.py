"""Speed test bound to an accepted operator trace (2026-10-05).

After the user accepts an operator trace, the app runs a speed test against
these endpoints and posts the result. Every call is device-signed, and every
call checks the trace belongs to the device and is still ACCEPTED and not
expired. So the test can't run without consent, and it can't be used as an
open bandwidth tool.

    GET  device/trace-requests/<id>/speedtest/ping/
    GET  device/trace-requests/<id>/speedtest/download/?bytes=N
    POST device/trace-requests/<id>/speedtest/upload/
    POST device/trace-requests/<id>/speedtest/result/

Upload size is checked after the signature check has read the body. The
nginx limit in front of Django is what bounds a large body, so that limit
needs to stay tight for this path.
"""
import time
from datetime import datetime, timezone as dt_timezone

from django.core.cache import cache
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .device_auth import DeviceSignatureAuthentication, IsDevice
from .device_trace import _refresh
from .models import TraceRequest, TraceSpeedResult
from .speed_test import _BLOCK, CHUNK, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, DEFAULT_DOWNLOAD_BYTES

RATE_PER_MIN = 60
MAX_RESULTS_PER_TRACE = 20
_MAX_MBPS = 10_000.0
_MAX_MS = 10_000.0


def _stream(size):
    remaining = size
    while remaining > 0:
        piece = _BLOCK[:remaining] if remaining < CHUNK else _BLOCK
        remaining -= len(piece)
        yield piece


class _TraceSpeedView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def _accepted_trace(self, request, trace_id):
        """Returns (trace, None) when the test may run, or (None, response)."""
        trace = TraceRequest.objects.filter(pk=trace_id, device=request.user).first()
        if trace is None:
            return None, Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status != TraceRequest.STATUS_ACCEPTED:
            return None, Response({'detail': f'trace is {trace.status}, not ACCEPTED'},
                                  status=status.HTTP_409_CONFLICT)
        return trace, None

    @staticmethod
    def _rate_limited(trace):
        key = f'tspeed:{trace.id}:{int(time.time() // 60)}'
        cache.add(key, 0, timeout=120)
        try:
            return cache.incr(key) > RATE_PER_MIN
        except ValueError:
            return False


class TraceSpeedPingView(_TraceSpeedView):
    def get(self, request, trace_id):
        trace, err = self._accepted_trace(request, trace_id)
        if err:
            return err
        if self._rate_limited(trace):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        response = HttpResponse(status=status.HTTP_204_NO_CONTENT)
        response['Cache-Control'] = 'no-store'
        return response


class TraceSpeedDownloadView(_TraceSpeedView):
    def get(self, request, trace_id):
        trace, err = self._accepted_trace(request, trace_id)
        if err:
            return err
        if self._rate_limited(trace):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            size = int(request.query_params.get('bytes', DEFAULT_DOWNLOAD_BYTES))
        except (TypeError, ValueError):
            size = DEFAULT_DOWNLOAD_BYTES
        size = max(CHUNK, min(size, MAX_DOWNLOAD_BYTES))
        response = StreamingHttpResponse(_stream(size), content_type='application/octet-stream')
        response['Content-Length'] = str(size)
        response['Cache-Control'] = 'no-store'
        return response


class TraceSpeedUploadView(_TraceSpeedView):
    def post(self, request, trace_id):
        trace, err = self._accepted_trace(request, trace_id)
        if err:
            return err
        if self._rate_limited(trace):
            return Response(status=status.HTTP_429_TOO_MANY_REQUESTS)
        received = len(request.body or b'')
        if received > MAX_UPLOAD_BYTES:
            return Response({'detail': 'upload too large'}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        return Response({'received_bytes': received})


def _num(value, limit):
    if value is None:
        return None
    v = float(value)
    if not 0 <= v <= limit:
        raise ValueError('out of range')
    return v


class TraceSpeedResultView(_TraceSpeedView):
    """Body: `{"ran_at": <epoch ms>, "ping_median_ms": .., "jitter_ms": ..,
    "download_mbps": .., "upload_mbps": .., "network_type": "LTE",
    "rsrp_dbm": -90}`. `ran_at` must fall inside the consented window."""

    def post(self, request, trace_id):
        trace, err = self._accepted_trace(request, trace_id)
        if err:
            return err
        if TraceSpeedResult.objects.filter(trace=trace).count() >= MAX_RESULTS_PER_TRACE:
            return Response({'detail': 'result limit reached for this trace'},
                            status=status.HTTP_409_CONFLICT)

        data = request.data if isinstance(request.data, dict) else {}
        try:
            ran_at = datetime.fromtimestamp(int(data['ran_at']) / 1000, tz=dt_timezone.utc)
            if not (trace.consent_at <= ran_at <= trace.expires_at):
                raise ValueError('outside consented window')
            row = TraceSpeedResult(
                trace=trace,
                ran_at=ran_at,
                ping_median_ms=_num(data.get('ping_median_ms'), _MAX_MS),
                jitter_ms=_num(data.get('jitter_ms'), _MAX_MS),
                download_mbps=_num(data.get('download_mbps'), _MAX_MBPS),
                upload_mbps=_num(data.get('upload_mbps'), _MAX_MBPS),
                network_type=str(data.get('network_type') or '').strip().upper()[:8],
                rsrp_dbm=int(data['rsrp_dbm']) if data.get('rsrp_dbm') is not None else None,
            )
            if row.rsrp_dbm is not None and not -160 <= row.rsrp_dbm <= 0:
                raise ValueError('rsrp out of range')
        except (KeyError, TypeError, ValueError, OverflowError):
            return Response({'detail': 'ran_at (inside the window) and numeric fields are required'},
                            status=status.HTTP_400_BAD_REQUEST)

        row.save()
        return Response({'stored': True, 'id': row.id}, status=status.HTTP_201_CREATED)
