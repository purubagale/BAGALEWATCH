"""Live readings for one complaint (2026-10-24), from the Problem Dashboard.

Two ways to measure now instead of reading what is stored:

  Around the spot ("Site related analysis"): an area request at the
  complaint's position (core/area_sample.py). Only phones sharing there
  answer, and the answers come back with no device id.

  From the customer's phone ("Subscriber related analysis"): a trace
  request to the phone registered to the complaint's number
  (core/device_trace.py). Anyone who may use the Problem Dashboard can send
  it, for this complaint only. The customer is asked on the phone and
  nothing is sent until they accept. The one exception, decided by the
  user on 2026-10-24: a superadmin's request while an emergency is
  declared starts without the Accept (the phone's own location permission
  still applies).

    GET  /api/v2/problem-reports/<id>/live/                       what has been asked
    POST /api/v2/problem-reports/<id>/live/area/                  {"radius_km": 1}
    GET  /api/v2/problem-reports/<id>/live/area/<request>/        its answers
    POST /api/v2/problem-reports/<id>/live/phone/                 {"ttl_minutes": 60}
    GET  /api/v2/problem-reports/<id>/live/phone/<trace>/         the readings it sent
    POST /api/v2/problem-reports/<id>/live/phone/<trace>/cancel/

The number is never in these answers; the server reads it from the report.
"""
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .area_sample import MAX_LOOKBACK_HOURS, _describe, area_results, create_area_request, user_rate_limited
from .audit import log_audit_event
from .collection import close_trace_session
from .device_trace import OPEN_STATUSES, _refresh, create_trace, registered_device
from .emergency import active_emergency
from .models import AreaSampleRequest, ProblemReport, TraceLocationSample, TraceRequest
from .problem_report import CanUseProblemDashboard, complaint_labels, complaint_reference

AREA_RADII_KM = (0.5, 1, 2, 5)
PHONE_TTL_MINUTES = (30, 60, 120)
MAX_FIXES = 1000


def _reference(report):
    return complaint_reference(report)


def _label(report):
    # Area requests and traces are found again by this label.
    return complaint_labels(report)[0]


def _labels(report):
    # Also the earlier "Complaint PR-28" form, so older requests still show.
    return complaint_labels(report)[1]


def _msisdn(report):
    return (report.device.msisdn if report.device_id and report.device else '') or report.msisdn or ''


def _device(report, msisdn):
    """The phone to ask: the one that sent the report when it is still
    registered to the number, else the newest registration of the number."""
    d = report.device if report.device_id else None
    if d is not None and d.revoked_at is None and d.msisdn == msisdn:
        return d
    return registered_device(msisdn) if msisdn else None


def _skips_accept(user):
    return user.role == 'superadmin' and active_emergency() is not None


def _trace_row(t):
    return {
        'id': str(t.id), 'status': t.status, 'consent_method': t.consent_method,
        'consent_at': t.consent_at, 'created_at': t.created_at, 'expires_at': t.expires_at,
        'ended_at': t.ended_at, 'ttl_minutes': t.ttl_minutes,
        'requested_by': t.requested_by.username if t.requested_by else None,
        'sample_count': t.samples.count(),
    }


def _traces(report):
    msisdn = _msisdn(report)
    if not msisdn:
        return TraceRequest.objects.none()
    return TraceRequest.objects.filter(msisdn=msisdn, case_reference__in=_labels(report))


def _live(report, user):
    msisdn = _msisdn(report)
    device = _device(report, msisdn) if msisdn else None
    return {
        'reference': _reference(report),
        'area': {
            'radii_km': AREA_RADII_KM,
            'requests': [_describe(r) for r in
                         AreaSampleRequest.objects.filter(label__in=_labels(report)).select_related('requested_by')[:20]],
        },
        'phone': {
            'has_number': bool(msisdn),
            'registered': device is not None,
            # Whether the phone has sent its push address (2026-10-27): without
            # it no notification can reach it, and it sees the request only
            # when the app is opened.
            'push_ready': bool(device is not None and device.fcm_token),
            'can_request': True,
            'skips_accept': _skips_accept(user),
            'ttl_minutes': PHONE_TTL_MINUTES,
            'traces': [_trace_row(_refresh(t)) for t in
                       _traces(report).select_related('requested_by').order_by('-created_at')[:20]],
        },
    }


class ProblemLiveView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport.objects.select_related('device'), pk=pk)
        return Response(_live(report, request.user))


class ProblemLiveAreaView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def post(self, request, pk):
        report = get_object_or_404(ProblemReport, pk=pk)
        if user_rate_limited(request.user):
            return Response({'detail': 'Too many requests. Wait a minute and try again.'},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            radius = float(request.data.get('radius_km', 1))
        except (TypeError, ValueError):
            radius = 1
        radius = min(AREA_RADII_KM, key=lambda r: abs(r - radius))
        # Registered phones that are not sharing are asked too, with Accept/Reject (2026-10-29; admin, superadmin).
        ask_registered = str(request.data.get('ask_registered', 'true')).lower() not in ('0', 'false', 'no', '')
        payload = create_area_request(request, report.lat, report.lng, radius, MAX_LOOKBACK_HOURS, _label(report),
                                      ask_registered)
        return Response(payload, status=status.HTTP_201_CREATED)


class ProblemLivePhoneView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def post(self, request, pk):
        report = get_object_or_404(ProblemReport.objects.select_related('device'), pk=pk)
        msisdn = _msisdn(report)
        if not msisdn:
            return Response({'detail': 'This complaint has no mobile number.'}, status=status.HTTP_400_BAD_REQUEST)
        device = _device(report, msisdn)
        if device is None:
            return Response({'detail': 'No phone with the DT-WATCH app is registered to this number.'},
                            status=status.HTTP_404_NOT_FOUND)
        for t in _traces(report).filter(status__in=OPEN_STATUSES):
            if _refresh(t).status in OPEN_STATUSES:
                return Response({'detail': 'A request for this complaint is still open. Wait for it to end or cancel it.'},
                                status=status.HTTP_409_CONFLICT)
        try:
            ttl = int(request.data.get('ttl_minutes', 60))
        except (TypeError, ValueError):
            ttl = 60
        ttl = min(PHONE_TTL_MINUTES, key=lambda m: abs(m - ttl))
        # A case trace skips the Accept during an emergency (create_trace);
        # only a superadmin's request is made one. Everyone else's waits.
        kind = TraceRequest.KIND_CASE if _skips_accept(request.user) else TraceRequest.KIND_INVESTIGATION
        trace, push_sent = create_trace(request, device, msisdn, kind, _label(report), ttl)
        return Response({**_trace_row(trace), 'push_sent': push_sent}, status=status.HTTP_201_CREATED)


class ProblemLiveAreaResultsView(APIView):
    """The answers to one of this complaint's area requests (no device ids)."""
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk, req_id):
        report = get_object_or_404(ProblemReport, pk=pk)
        req = get_object_or_404(AreaSampleRequest, pk=req_id, label__in=_labels(report))
        return Response(area_results(req, request.user))


def _complaint_trace(report, trace_id):
    return _traces(report).select_related('requested_by').filter(pk=trace_id).first()


class ProblemLivePhoneFixesView(APIView):
    """The readings one of this complaint's requests has received, oldest first."""
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk, trace_id):
        report = get_object_or_404(ProblemReport.objects.select_related('device'), pk=pk)
        trace = _complaint_trace(report, trace_id)
        if trace is None:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        rows = TraceLocationSample.objects.filter(trace=trace).order_by('-ts')[:MAX_FIXES]
        return Response({'results': [
            {
                'ts': r.ts, 'lat': r.lat, 'lng': r.lng, 'accuracy_m': r.accuracy_m,
                'network_type': r.network_type, 'cell_id': r.cell_id, 'pci': r.pci,
                'tac': r.tac, 'mcc': r.mcc, 'mnc': r.mnc, 'rsrp_dbm': r.rsrp_dbm,
                'rsrq_db': r.rsrq_db, 'sinr_db': r.sinr_db, 'rssi_dbm': r.rssi_dbm, 'cqi': r.cqi,
            }
            for r in reversed(list(rows))
        ]})


class ProblemLivePhoneCancelView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def post(self, request, pk, trace_id):
        report = get_object_or_404(ProblemReport.objects.select_related('device'), pk=pk)
        trace = _complaint_trace(report, trace_id)
        if trace is None:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status not in OPEN_STATUSES:
            return Response({'detail': 'This request has already ended.'}, status=status.HTTP_409_CONFLICT)
        trace.status = TraceRequest.STATUS_CANCELLED
        trace.ended_at = timezone.now()
        trace.save(update_fields=['status', 'ended_at'])
        close_trace_session(trace)
        log_audit_event(request, 'TRACE.CANCELLED', resource='trace_request', resource_id=str(trace.id),
                        detail=f'case={trace.case_reference}')
        return Response(_trace_row(trace))
