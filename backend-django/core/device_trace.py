"""Device-bound, consent-gated tracing (2026-10-04).

Only a DT-WATCH operator can create a TraceRequest. The device learns of it
by push (core/fcm.py) or by polling, and sends GPS only after the user
accepts AND the OS grants location permission. Every device call is signed
(core/device_auth.py), so an APK copied off a phone has nothing that can
post trace data.

Lifecycle of a TraceRequest:
    PENDING --accept-------------> ACCEPTED --stop----> REVOKED
    PENDING --reject-------------> REJECTED
    PENDING --phone-consent------> PENDING, phone_consent_at set (operator attestation)
            (the device's accept after attestation is what ACCEPTs it;
             consent_method=PHONE_CALL, otherwise APP)
    ACCEPTED or PENDING --cancel--> CANCELLED   (operator)
    any open state past expires_at -> EXPIRED   (lazy, on every read/write)
    active emergency + case kind --> created ACCEPTED (consent_method=POLICY_BYPASS)

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
from django.db.models import F
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .auth_log import _client_ip
from .device_auth import (
    DeviceSignatureAuthentication, IsDevice, fingerprint_from_pem, load_ec_p256_public_key,
)
from .fcm import send_trace_push
from .emergency import active_emergency
from .models import (
    CollectionSession, DeviceCredential, DeviceIdentity, SubscriberDevice, TraceLocationSample, TraceRequest,
    TraceSpeedResult,
)
from .play_integrity import verify_integrity_token
from .rescue import _clean_msisdn
from .subscriber_device import link_device, touch_seen
from .telemetry import hash_device_id
from .access import PERM_TRACE_CASE, PERM_TRACE_INVESTIGATE, IsTraceOperator, user_has
from .collection import close_trace_session, ensure_trace_session
from .views import IsSuperadminOnly

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
        close_trace_session(trace)
    return trace


def _device_view(trace):
    return {
        'id': str(trace.id),
        'status': trace.status,
        # Lets the phone say "an operator recorded your agreement by phone,
        # tap Accept to continue" rather than presenting a bare request.
        'operator_attested': trace.phone_consent_at is not None,
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
        'phone_consent_at': trace.phone_consent_at,
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
        link_device(
            msisdn, device_hash, SubscriberDevice.VIA_REGISTRATION,
            manufacturer=str(request.data.get('manufacturer') or ''),
            phone_model=str(request.data.get('phone_model') or request.data.get('model') or ''),
            app_version=app_version,
            hardware_id=request.data.get('hardware_id'),
        )
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
            # An operator's phone-call attestation is recorded, but the device's
            # own Accept is the act that starts the trace. Name both in the record.
            trace.consent_method = (
                TraceRequest.CONSENT_PHONE if trace.phone_consent_at else TraceRequest.CONSENT_APP
            )
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
            close_trace_session(trace)
        else:
            return Response({'detail': "action must be 'accept', 'reject' or 'stop'"},
                            status=status.HTTP_400_BAD_REQUEST)

        trace.save()
        if trace.status == TraceRequest.STATUS_ACCEPTED:
            ensure_trace_session(trace)
        logger.info('trace %s: device %s -> %s', trace.id, request.user.device_hash[:8], trace.status)
        return Response(_device_view(trace))


def _qos_fields(item):
    """Optional signal and QoS values sent with a fix (2026-10-05). A bad value
    becomes None rather than dropping the fix, same posture as crowd samples."""
    def integer(key, lo, hi):
        try:
            v = int(item[key])
        except (KeyError, TypeError, ValueError):
            return None
        return v if lo <= v <= hi else None

    def text(key, limit):
        return str(item.get(key) or '').strip().upper()[:limit]

    return {
        'network_type': text('network_type', 8),
        'cell_id': integer('cell_id', 0, 2**40),
        'pci': integer('pci', 0, 1007),
        'tac': integer('tac', 0, 65535),
        'mcc': text('mcc', 6),
        'mnc': text('mnc', 6),
        'rsrp_dbm': integer('rsrp_dbm', -160, 0),
        'rsrq_db': integer('rsrq_db', -40, 10),
        'sinr_db': integer('sinr_db', -30, 60),
        'rssi_dbm': integer('rssi_dbm', -160, 0),
        'cqi': integer('cqi', 0, 15),
    }


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
                **_qos_fields(item),
            ))

        if rows:
            TraceLocationSample.objects.bulk_create(rows)
            touch_seen([trace.device.device_hash])
            ensure_trace_session(trace)
            CollectionSession.objects.filter(trace=trace).update(
                sample_count=F('sample_count') + len(rows), last_sample_at=timezone.now(),
            )
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
    permission_classes = [IsTraceOperator]

    def get(self, request):
        traces = TraceRequest.objects.select_related('requested_by', 'consent_recorded_by')[:200]
        return Response([_operator_view(_refresh(t)) for t in traces])

    def post(self, request):
        msisdn = _clean_msisdn(request.data.get('msisdn'))
        if not msisdn:
            return Response({'detail': 'a valid msisdn is required'}, status=status.HTTP_400_BAD_REQUEST)
        # 2026-10-05: an investigation starts from the MSISDN alone; a case also
        # needs a case reference. Each kind has its own permission.
        kind = str(request.data.get('kind') or TraceRequest.KIND_INVESTIGATION).strip().lower()
        if kind not in (TraceRequest.KIND_INVESTIGATION, TraceRequest.KIND_CASE):
            return Response({'detail': "kind must be 'investigation' or 'case'"},
                            status=status.HTTP_400_BAD_REQUEST)
        needed = PERM_TRACE_CASE if kind == TraceRequest.KIND_CASE else PERM_TRACE_INVESTIGATE
        if not user_has(request.user, needed):
            return Response({'detail': f'your account lacks the {needed} permission'},
                            status=status.HTTP_403_FORBIDDEN)
        case_reference = str(request.data.get('case_reference') or '').strip()[:200]
        if kind == TraceRequest.KIND_CASE and not case_reference:
            return Response({'detail': 'case_reference is required for a case'},
                            status=status.HTTP_400_BAD_REQUEST)

        device = DeviceCredential.objects.filter(
            msisdn=msisdn, revoked_at__isnull=True,
        ).order_by('-last_seen_at').first()
        if device is None:
            return Response({'detail': 'no registered device for this number'},
                            status=status.HTTP_404_NOT_FOUND)

        now = timezone.now()
        ttl = _ttl_minutes(request.data.get('ttl_minutes'))
        # An active emergency lets a case trace skip the device Accept. The OS
        # location permission still applies. Investigations always need Accept.
        bypass = active_emergency() is not None and kind == TraceRequest.KIND_CASE

        trace = TraceRequest(
            device=device, msisdn=msisdn, requested_by=request.user,
            kind=kind, case_reference=case_reference, ttl_minutes=ttl,
            expires_at=now + timedelta(minutes=ttl),
        )
        if bypass:
            trace.status = TraceRequest.STATUS_ACCEPTED
            trace.consent_method = TraceRequest.CONSENT_POLICY
            trace.consent_at = now
            trace.policy_mode = 'emergency'
        trace.save()
        if trace.status == TraceRequest.STATUS_ACCEPTED:
            ensure_trace_session(trace)

        push_sent = send_trace_push(device.fcm_token, trace.id)
        log_audit_event(
            request, 'TRACE.CREATED', resource='trace_request', resource_id=str(trace.id),
            detail=f'case={case_reference} consent={trace.consent_method or "pending"} push={push_sent}',
        )
        return Response({**_operator_view(trace), 'push_sent': push_sent},
                        status=status.HTTP_201_CREATED)


class TraceSamplesView(APIView):
    """`GET /api/v2/trace-requests/<id>/samples/?limit=500` -- the fixes a trace
    has received, oldest first, with their signal values. Operator only."""
    permission_classes = [IsTraceOperator]

    def get(self, request, trace_id):
        trace = TraceRequest.objects.filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        try:
            limit = max(1, min(int(request.query_params.get('limit', 500)), 2000))
        except (TypeError, ValueError):
            limit = 500
        rows = TraceLocationSample.objects.filter(trace=trace).order_by('ts')[:limit]
        return Response({'results': [
            {
                'ts': r.ts, 'lat': r.lat, 'lng': r.lng, 'accuracy_m': r.accuracy_m,
                'network_type': r.network_type, 'cell_id': r.cell_id, 'pci': r.pci,
                'tac': r.tac, 'mcc': r.mcc, 'mnc': r.mnc, 'rsrp_dbm': r.rsrp_dbm,
                'rsrq_db': r.rsrq_db, 'sinr_db': r.sinr_db, 'rssi_dbm': r.rssi_dbm, 'cqi': r.cqi,
            }
            for r in rows
        ]})


class TraceRequestDetailView(APIView):
    """`GET /api/v2/trace-requests/<id>/`."""
    permission_classes = [IsTraceOperator]

    def get(self, request, trace_id):
        trace = TraceRequest.objects.select_related('requested_by', 'consent_recorded_by').filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        payload = _operator_view(trace)
        payload['sample_count'] = trace.samples.count()
        session = CollectionSession.objects.filter(trace=trace).first()
        payload['session'] = None if session is None else {
            'id': str(session.id), 'source': session.source, 'sample_count': session.sample_count,
            'started_at': session.started_at, 'last_sample_at': session.last_sample_at,
            'ended_at': session.ended_at,
        }
        payload['speed_results'] = [
            {
                'ran_at': r.ran_at, 'ping_median_ms': r.ping_median_ms, 'jitter_ms': r.jitter_ms,
                'download_mbps': r.download_mbps, 'upload_mbps': r.upload_mbps,
                'network_type': r.network_type, 'rsrp_dbm': r.rsrp_dbm,
            }
            for r in TraceSpeedResult.objects.filter(trace=trace)
        ]
        return Response(payload)


class TraceRequestPhoneConsentView(APIView):
    """`POST /api/v2/trace-requests/<id>/phone-consent/` -- body
    `{"phone_consent_ref": "<call or record reference>"}`. Records that the
    operator obtained the user's agreement by phone. It does NOT start the
    trace: the request stays PENDING, and the phone must still tap Accept
    (and the OS grant location permission) before anything is sent. A
    fresh push tells the phone to show the prompt. Only valid while PENDING
    and not already attested. Attestation is never recorded without a ref."""
    permission_classes = [IsTraceOperator]

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
        if trace.phone_consent_at is not None:
            return Response({'detail': 'phone consent is already recorded for this request'},
                            status=status.HTTP_409_CONFLICT)

        trace.phone_consent_ref = ref
        trace.phone_consent_at = timezone.now()
        trace.consent_recorded_by = request.user
        trace.save()
        push_sent = send_trace_push(trace.device.fcm_token, trace.id)
        log_audit_event(request, 'TRACE.PHONE_CONSENT', resource='trace_request',
                        resource_id=str(trace.id), detail=f'ref={ref} push={push_sent}')
        return Response({**_operator_view(trace), 'push_sent': push_sent})


class TraceRequestCompleteView(APIView):
    """`POST /api/v2/trace-requests/<id>/complete/` -- the operator ends an
    accepted trace on purpose, once the data they need is in. Only an ACCEPTED
    trace can be completed. The phone's next sample post gets a 409 and stops
    sharing (see TraceSharingService on the phone)."""
    permission_classes = [IsTraceOperator]

    def post(self, request, trace_id):
        trace = TraceRequest.objects.filter(pk=trace_id).first()
        if trace is None:
            return Response({'detail': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        trace = _refresh(trace)
        if trace.status != TraceRequest.STATUS_ACCEPTED:
            return Response({'detail': f'cannot complete a {trace.status} request'},
                            status=status.HTTP_409_CONFLICT)
        trace.status = TraceRequest.STATUS_COMPLETED
        trace.ended_at = timezone.now()
        trace.save(update_fields=['status', 'ended_at'])
        close_trace_session(trace)
        log_audit_event(request, 'TRACE.COMPLETED', resource='trace_request', resource_id=str(trace.id))
        return Response(_operator_view(trace))


class TraceRequestCancelView(APIView):
    """`POST /api/v2/trace-requests/<id>/cancel/` -- ends an open request.
    The device learns on its next poll; a cancel push is not sent in this version."""
    permission_classes = [IsTraceOperator]

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
        close_trace_session(trace)
        log_audit_event(request, 'TRACE.CANCELLED', resource='trace_request', resource_id=str(trace.id))
        return Response(_operator_view(trace))


class RegisteredDeviceListView(APIView):
    """`GET /api/v2/registered-devices/` -- superadmin-only. Lists every
    DeviceCredential: the actual "has this phone registered for NTC trace
    requests" record (POST device/register/ above), separate from both
    Rescue Enrolled Devices (SubscriberLastLocation, a different opt-in
    lane keyed by rescue_consent) and DeviceIdentity (crowd/staff model
    info, no registration semantics of its own). This was the missing
    "where can I see the list of devices registered in my dtwatch
    application" answer (2026-10-08) -- no such list existed anywhere
    before this, only single-lookup views for the OTHER two tables.

    msisdn here is self-declared by the device (see DeviceCredential's own
    docstring on what that is and isn't trusted as far as) -- shown as-is,
    not re-verified against anything. Joined to DeviceIdentity by device
    hash for phone model/manufacturer when that device has also sent
    identity info, same join RescueEnrolledListView already does.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        rows = list(DeviceCredential.objects.all().order_by('-last_seen_at'))
        identities = {
            d.device_hash: d
            for d in DeviceIdentity.objects.filter(device_hash__in=[r.device_hash for r in rows])
        }
        results = []
        for r in rows:
            identity = identities.get(r.device_hash)
            results.append({
                'device_hash': r.device_hash,
                'msisdn': r.msisdn or None,
                'app_version': r.app_version or None,
                'has_fcm_token': bool(r.fcm_token),
                'created_at': r.created_at,
                'last_seen_at': r.last_seen_at,
                'revoked_at': r.revoked_at,
                'phone_model': identity.phone_model if identity else None,
                'manufacturer': identity.manufacturer if identity else None,
            })
        # Audited the same way DeviceIdentityLookupView audits a single
        # lookup -- this reveals the same category of identity-adjacent
        # data (msisdn + device hash), just for everyone registered at
        # once rather than one at a time.
        log_audit_event(request, 'DEVICE.REGISTRY_VIEW', resource='device_credential', detail=f'count={len(results)}')
        return Response({'results': results, 'count': len(results)})
