"""Device-bound, consent-gated tracing (2026-10-04).

Only a DT-WATCH operator can create a TraceRequest. The device learns of it
by push (core/fcm.py) or by polling, and sends GPS only after the user
accepts AND the OS grants location permission. Every device call is signed
(core/device_auth.py), so an APK copied off a phone has nothing that can
post trace data.

Lifecycle of a TraceRequest:
    PENDING --accept-------------> ACCEPTED --stop----> REVOKED
    PENDING --reject-------------> REJECTED
    PENDING --phone-consent------> ACCEPTED (consent_method=PHONE_CALL)
    ACCEPTED or PENDING --cancel--> CANCELLED   (operator)
    any open state past expires_at -> EXPIRED   (lazy, on every read/write)
    RescueConsentPolicy optional --> created ACCEPTED (consent_method=POLICY_BYPASS)

Device endpoints  (/api/telemetry/v1/device/, signed):
    GET  challenge/                   unsigned, issues a Play Integrity nonce
    POST register/                    unsigned, Play Integrity + public key + MSISDN
    PUT  fcm-token/
    GET  trace-requests/              open requests (poll fallback for push)
    POST trace-requests/<id>/respond/ accept | reject | stop
    POST trace-requests/<id>/samples/ GPS fixes, only while ACCEPTED

Operator endpoints (/api/v2/, JWT, IsRescueOperator):
    GET/POST trace-requests/
    GET  trace-requests/<id>/
    POST trace-requests/<id>/phone-consent/
    POST trace-requests/<id>/cancel/

Device-facing responses never include the MSISDN or case reference: the
device needs neither, and the response body should not spread them further.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone as dt_timezone

from django.conf import settings
from django.contrib.gis.geos import Point
from django.core.cache import cache
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .auth_log import _client_ip
from .device_auth import (
    DeviceSignatureAuthentication, IsDevice, fingerprint_from_pem, load_ec_p256_public_key,
)
from .fcm import send_trace_push
from .models import DeviceCredential, RescueConsentPolicy, TraceLocationSample, TraceRequest
from .play_integrity import verify_integrity_token
from .rescue import _clean_msisdn
from .telemetry import hash_device_id
from .views import IsRescueOperator

logger = logging.getLogger(__name__)

MAX_SAMPLES_PER_REQUEST = 2000
CHALLENGE_TTL = 300
REGISTER_RATE_PER_MIN = 10
OPEN_STATUSES = (TraceRequest.STATUS_PENDING, TraceRequest.STATUS_ACCEPTED)


# ── Shared helpers ─────────────────────────────────────────────────────

def _refresh(trace):
    """Lazy expiry: an open request past its expires_at becomes EXPIRED the
    first time anything touches it. No scheduled job is needed."""
    if trace.status in OPEN_STATUSES and trace.expires_at and trace.expires_at <= timezone.now():
        trace.status = TraceRequest.STATUS_EXPIRED
        trace.ended_at = timezone.now()
        trace.save(update_fields=['status', 'ended_at'])
    return trace


def _device_view(trace):
    return {
        'id': str(trace.id),
        'status': trace.status,
        'consent_at': trace.consent_at,
        'expires_at': trace.expires_at,
        'created_at': trace.created_at,
    }


def _operator_view(trace):
    return {
        'id': str(trace.id),
        'msisdn': trace.msisdn,
        'case_reference': trace.case_reference,
        'status': trace.status,
        'consent_method': trace.consent_method,
        'consent_at': trace.consent_at,
        'consent_recorded_by': trace.consent_recorded_by.username if trace.consent_recorded_by else None,
        'phone_consent_ref': trace.phone_consent_ref,
        'policy_mode': trace.policy_mode,
        'ttl_minutes': trace.ttl_minutes,
        'expires_at': trace.expires_at,
        'created_at': trace.created_at,
        'ended_at': trace.ended_at,
        'requested_by': trace.requested_by.username if trace.requested_by else None,
    }


def _ttl_minutes(raw):
    try:
        v = int(raw)
    except (TypeError, ValueError):
        v = settings.TRACE_DEFAULT_TTL_MINUTES
    return max(1, min(v, settings.TRACE_MAX_TTL_MINUTES))


# ── Device: challenge and registration ─────────────────────────────────

class DeviceChallengeView(APIView):
    """`GET /api/telemetry/v1/device/challenge/` -- a single-use nonce the
    app must pass to Play Integrity and then echo back on register/."""
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        nonce = secrets.token_urlsafe(24)
        cache.set(f'devchallenge:{nonce}', 1, timeout=CHALLENGE_TTL)
        return Response({'challenge': nonce, 'expires_in': CHALLENGE_TTL})


class DeviceRegisterView(APIView):
    """`POST /api/telemetry/v1/device/register/` -- body:
        public_key (PEM, EC P-256), challenge, play_integrity_token,
        msisdn, fcm_token (optional), app_version (optional)

    Silent and automatic on install and on update: the app calls it with no
    user prompt. Re-registering the same key updates msisdn/fcm/app_version
    and never un-revokes a device a superadmin has revoked."""
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        ip = _client_ip(request) or 'unknown'
        bucket = f'devreg:rl:{ip}:{int(timezone.now().timestamp() // 60)}'
        try:
            n = cache.incr(bucket)
        except ValueError:
            cache.set(bucket, 1, timeout=120)
            n = 1
        if n > REGISTER_RATE_PER_MIN:
            return Response({'detail': 'too many registration attempts'},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)

        pem = str(request.data.get('public_key') or '').strip()
        try:
            device_id = fingerprint_from_pem(pem)
        except (ValueError, TypeError):
            return Response({'detail': 'public_key must be an EC P-256 PEM key'},
                            status=status.HTTP_400_BAD_REQUEST)

        msisdn = _clean_msisdn(request.data.get('msisdn'))
        if not msisdn:
            return Response({'detail': 'a valid msisdn is required'},
                            status=status.HTTP_400_BAD_REQUEST)

        challenge = str(request.data.get('challenge') or '')
        if not challenge or not cache.get(f'devchallenge:{challenge}'):
            return Response({'detail': 'invalid or expired challenge'},
                            status=status.HTTP_400_BAD_REQUEST)
        cache.delete(f'devchallenge:{challenge}')

        ok, reason = verify_integrity_token(
            str(request.data.get('play_integrity_token') or ''), challenge,
        )
        if not ok:
            logger.warning('device registration refused: %s (ip=%s)', reason, ip)
            return Response({'detail': 'device integrity check failed'},
                            status=status.HTTP_403_FORBIDDEN)

        device_hash = hash_device_id(device_id)
        existing = DeviceCredential.objects.filter(device_hash=device_hash).first()
        if existing and existing.revoked_at:
            return Response({'detail': 'this device has been revoked'},
                            status=status.HTTP_403_FORBIDDEN)

        # One MSISDN, one active device. A conflicting claim is refused and
        # logged, never silently rebound -- rebinding is a superadmin act.
        if DeviceCredential.objects.filter(msisdn=msisdn, revoked_at__isnull=True).exclude(
            device_hash=device_hash,
        ).exists():
            logger.warning('device registration refused: msisdn already bound to another device (ip=%s)', ip)
            return Response({'detail': 'this number is already registered on another device'},
                            status=status.HTTP_409_CONFLICT)

        fcm_token = str(request.data.get('fcm_token') or '')[:512]
        app_version = str(request.data.get('app_version') or '')[:40]
        if existing:
            existing.msisdn = msisdn
            existing.fcm_token = fcm_token or existing.fcm_token
            existing.app_version = app_version or existing.app_version
            existing.save(update_fields=['msisdn', 'fcm_token', 'app_version'])
            created = False
        else:
            DeviceCredential.objects.create(
                device_hash=device_hash, public_key_pem=pem, msisdn=msisdn,
                fcm_token=fcm_token, app_version=app_version,
            )
            created = True
        return Response({'device_id': device_id, 'registered': True, 'created': created})


# ── Device: signed endpoints ───────────────────────────────────────────

class DeviceFcmTokenView(APIView):
    """`PUT /api/telemetry/v1/device/fcm-token/` -- body `{"fcm_token": "..."}`."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def put(self, request):
        token = str(request.data.get('fcm_token') or '')[:512]
        if not token:
            return Response({'detail': 'fcm_token is required'}, status=status.HTTP_400_BAD_REQUEST)
        DeviceCredential.objects.filter(pk=request.user.pk).update(fcm_token=token)
        return Response({'updated': True})


class DeviceTraceListView(APIView):
    """`GET /api/telemetry/v1/device/trace-requests/` -- open requests for
    this device. The polling fallback when push is unavailable."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def get(self, request):
        traces = TraceRequest.objects.filter(device=request.user, status__in=OPEN_STATUSES)
        return Response([_device_view(_refresh(t)) for t in traces])


class DeviceTraceRespondView(APIView):
    """`POST /api/telemetry/v1/device/trace-requests/<id>/respond/` --
    body `{"action": "accept" | "reject" | "stop"}`. Each action is only
    valid from one specific state, so a replayed or reordered tap cannot
    move a request somewhere it never went."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request, trace_id):
        trace = TraceRequest.objects.filter(pk=trace_id, device=request.user).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        action = str(request.data.get('action') or '')
        now = timezone.now()

        if action == 'accept':
            if trace.status != TraceRequest.STATUS_PENDING:
                return Response({'detail': f'cannot accept a {trace.status} request'},
                                status=status.HTTP_409_CONFLICT)
            trace.status = TraceRequest.STATUS_ACCEPTED
            trace.consent_method = TraceRequest.CONSENT_APP
            trace.consent_at = now
        elif action == 'reject':
            if trace.status != TraceRequest.STATUS_PENDING:
                return Response({'detail': f'cannot reject a {trace.status} request'},
                                status=status.HTTP_409_CONFLICT)
            trace.status = TraceRequest.STATUS_REJECTED
            trace.ended_at = now
        elif action == 'stop':
            if trace.status != TraceRequest.STATUS_ACCEPTED:
                return Response({'detail': f'cannot stop a {trace.status} request'},
                                status=status.HTTP_409_CONFLICT)
            trace.status = TraceRequest.STATUS_REVOKED
            trace.ended_at = now
        else:
            return Response({'detail': "action must be 'accept', 'reject' or 'stop'"},
                            status=status.HTTP_400_BAD_REQUEST)

        trace.save()
        logger.info('trace %s: device %s -> %s', trace.id, request.user.device_hash[:8], trace.status)
        return Response(_device_view(trace))


class DeviceTraceSamplesView(APIView):
    """`POST /api/telemetry/v1/device/trace-requests/<id>/samples/` -- body
    is a JSON array of `{"ts": <epoch ms>, "lat": .., "lon": .., "accuracy_m": ..}`.

    Only accepted while the request is ACCEPTED. Each fix is kept only if
    its `ts` falls inside [consent_at, expires_at], so a device cannot back-
    date or pre-date samples outside the consented window. Out-of-window
    and malformed items are counted and dropped, never failing the batch."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request, trace_id):
        trace = TraceRequest.objects.filter(pk=trace_id, device=request.user).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status != TraceRequest.STATUS_ACCEPTED:
            return Response({'detail': f'trace is {trace.status}, not ACCEPTED'},
                            status=status.HTTP_409_CONFLICT)

        items = request.data
        if not isinstance(items, list):
            return Response({'detail': 'body must be a JSON array'}, status=status.HTTP_400_BAD_REQUEST)
        if len(items) > MAX_SAMPLES_PER_REQUEST:
            return Response({'detail': f'max {MAX_SAMPLES_PER_REQUEST} samples per request'},
                            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        rows, rejected = [], 0
        for item in items:
            try:
                ts = datetime.fromtimestamp(int(item['ts']) / 1000, tz=dt_timezone.utc)
                lat = float(item['lat'])
                lng = float(item['lon'])
                if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                    raise ValueError('out of range')
                if not (trace.consent_at <= ts <= trace.expires_at):
                    raise ValueError('outside consented window')
                acc = item.get('accuracy_m')
                acc = float(acc) if acc is not None else None
            except (KeyError, TypeError, ValueError, OverflowError):
                rejected += 1
                continue
            rows.append(TraceLocationSample(
                trace=trace, ts=ts, lat=lat, lng=lng,
                location=Point(lng, lat, srid=4326), accuracy_m=acc,
            ))

        if rows:
            TraceLocationSample.objects.bulk_create(rows)
        return Response({'accepted': len(rows), 'rejected': rejected},
                        status=status.HTTP_202_ACCEPTED)


# ── Operator endpoints (JWT) ───────────────────────────────────────────

class TraceRequestListCreateView(APIView):
    """`GET /api/v2/trace-requests/` lists recent requests.
    `POST /api/v2/trace-requests/` creates one -- body:
        msisdn, case_reference (required), ttl_minutes (optional).

    The MSISDN resolves to the one active DeviceCredential bound to it. If
    none exists the request is refused with 404 -- there is no device to
    trace. When RescueConsentPolicy is in its optional (emergency) mode the
    request is created ACCEPTED with consent_method=POLICY_BYPASS; the push
    still goes out, and the OS location permission still applies on-device."""
    permission_classes = [IsRescueOperator]

    def get(self, request):
        traces = TraceRequest.objects.select_related('requested_by', 'consent_recorded_by')[:200]
        return Response([_operator_view(_refresh(t)) for t in traces])

    def post(self, request):
        msisdn = _clean_msisdn(request.data.get('msisdn'))
        if not msisdn:
            return Response({'detail': 'a valid msisdn is required'}, status=status.HTTP_400_BAD_REQUEST)
        case_reference = str(request.data.get('case_reference') or '').strip()[:200]
        if not case_reference:
            return Response({'detail': 'case_reference is required'}, status=status.HTTP_400_BAD_REQUEST)

        device = DeviceCredential.objects.filter(
            msisdn=msisdn, revoked_at__isnull=True,
        ).order_by('-last_seen_at').first()
        if device is None:
            return Response({'detail': 'no registered device for this number'},
                            status=status.HTTP_404_NOT_FOUND)

        now = timezone.now()
        ttl = _ttl_minutes(request.data.get('ttl_minutes'))
        policy = RescueConsentPolicy.objects.filter(pk=1).first()
        bypass = bool(policy and policy.is_optional_active())

        trace = TraceRequest(
            device=device, msisdn=msisdn, requested_by=request.user,
            case_reference=case_reference, ttl_minutes=ttl,
            expires_at=now + timedelta(minutes=ttl),
        )
        if bypass:
            trace.status = TraceRequest.STATUS_ACCEPTED
            trace.consent_method = TraceRequest.CONSENT_POLICY
            trace.consent_at = now
            trace.policy_mode = policy.mode
        trace.save()

        push_sent = send_trace_push(device.fcm_token, trace.id)
        log_audit_event(
            request, 'TRACE.CREATED', resource='trace_request', resource_id=str(trace.id),
            detail=f'case={case_reference} consent={trace.consent_method or "pending"} push={push_sent}',
        )
        return Response({**_operator_view(trace), 'push_sent': push_sent},
                        status=status.HTTP_201_CREATED)


class TraceRequestDetailView(APIView):
    """`GET /api/v2/trace-requests/<id>/`."""
    permission_classes = [IsRescueOperator]

    def get(self, request, trace_id):
        trace = TraceRequest.objects.select_related('requested_by', 'consent_recorded_by').filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response(_operator_view(_refresh(trace)))


class TraceRequestPhoneConsentView(APIView):
    """`POST /api/v2/trace-requests/<id>/phone-consent/` -- body
    `{"phone_consent_ref": "<call or record reference>"}`. Records consent
    the operator obtained by phone. Only valid while PENDING; sets ACCEPTED
    and stamps who recorded it. The device picks the state up on its next
    poll or push, and still needs OS location permission to send anything.
    Consent is never recorded without a stated reference."""
    permission_classes = [IsRescueOperator]

    def post(self, request, trace_id):
        ref = str(request.data.get('phone_consent_ref') or '').strip()[:200]
        if not ref:
            return Response({'detail': 'phone_consent_ref is required'},
                            status=status.HTTP_400_BAD_REQUEST)
        trace = TraceRequest.objects.filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status != TraceRequest.STATUS_PENDING:
            return Response({'detail': f'cannot record phone consent on a {trace.status} request'},
                            status=status.HTTP_409_CONFLICT)

        trace.status = TraceRequest.STATUS_ACCEPTED
        trace.consent_method = TraceRequest.CONSENT_PHONE
        trace.consent_at = timezone.now()
        trace.consent_recorded_by = request.user
        trace.phone_consent_ref = ref
        trace.save()
        log_audit_event(request, 'TRACE.PHONE_CONSENT', resource='trace_request',
                        resource_id=str(trace.id), detail=f'ref={ref}')
        return Response(_operator_view(trace))


class TraceRequestCancelView(APIView):
    """`POST /api/v2/trace-requests/<id>/cancel/` -- ends an open request.
    The device learns on its next poll; a cancel push is not sent in this version."""
    permission_classes = [IsRescueOperator]

    def post(self, request, trace_id):
        trace = TraceRequest.objects.filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status not in OPEN_STATUSES:
            return Response({'detail': f'cannot cancel a {trace.status} request'},
                            status=status.HTTP_409_CONFLICT)
        trace.status = TraceRequest.STATUS_CANCELLED
        trace.ended_at = timezone.now()
        trace.save(update_fields=['status', 'ended_at'])
        log_audit_event(request, 'TRACE.CANCELLED', resource='trace_request', resource_id=str(trace.id))
        return Response(_operator_view(trace))
