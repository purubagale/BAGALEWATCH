"""Superadmin device-location trace (2026-10-08).

A DELIBERATE, acknowledged exception to this app's core privacy posture:
core/models.py's SubscriberLastLocation docstring states that table is
"never joined against TelemetrySample." This tool does exactly that,
cross-referencing DeviceIdentity (an MSISDN/IMEI a device uploaded as
part of its own identity -- core/collection.py's upsert_identity, from
the crowd/staff identity upload) to that device's latest position in the
regular anonymous telemetry pipeline. It exists as a second, separate
feature alongside Rescue Lookup, not a replacement for it or an extension
of its consent/case-reference model -- see DeviceLocationTraceLog's own
docstring for why this gets its own audit table instead of reusing
RescueLocationAccessLog, and why it is superadmin-only (a materially
higher bar than IsRescueOperator, the same tier as declaring an
emergency or the Rescue Enrolled Devices list).

Since 2026-10-08 it works only while an emergency is declared
(core/emergency.py) and every search needs a case reference. It was built
for search and rescue after the Bhotekoshi flood, and reads positions with
no consent from the device's owner, so it stays off outside a disaster.
"""
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .collection import imei_lookup_key, msisdn_lookup_key
from .emergency import active_emergency
from .models import DeviceIdentity, DeviceLocationTraceLog, TelemetrySample
from .rescue import _clean_msisdn
from .views import IsSuperadminOnly

TRACE_OFF_DETAIL = 'Device Location Trace is off. A superadmin must declare an emergency to turn it on.'


class DeviceLocationTraceView(APIView):
    """`GET /api/v2/device-location-trace/?msisdn=...` or `?imei=...` --
    exactly one of the two. Resolves to a DeviceIdentity row by its keyed
    lookup hash (never by decrypting every row), then returns that
    device's most recent GPS-tagged TelemetrySample. No rescue-location
    consent required -- this reads whatever MSISDN/IMEI the device itself
    already uploaded as crowd/staff identity info, a separate and
    broader-reaching lane than Rescue Lookup's own consent-gated
    SubscriberLastLocation. Since 2026-10-08 it works only while an
    emergency is declared and needs `case_reference`. Every search is
    logged to DeviceLocationTraceLog and the audit log, whether or not it
    finds a match.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        # Usable only during a declared emergency, and only against a case
        # reference (2026-10-08). It reads positions with no consent from the
        # device's owner, so it is limited to the disaster it was built for.
        emergency = active_emergency()
        if emergency is None:
            return Response({'detail': TRACE_OFF_DETAIL}, status=status.HTTP_403_FORBIDDEN)
        case_reference = (request.query_params.get('case_reference') or '').strip()[:120]
        if not case_reference:
            return Response({'detail': 'A case reference is required'}, status=status.HTTP_400_BAD_REQUEST)

        msisdn_raw = (request.query_params.get('msisdn') or '').strip()
        imei_raw = (request.query_params.get('imei') or '').strip()
        if bool(msisdn_raw) == bool(imei_raw):
            return Response({'detail': 'Provide exactly one of msisdn or imei'}, status=status.HTTP_400_BAD_REQUEST)

        if msisdn_raw:
            query_type, query_value = 'msisdn', msisdn_raw
            canonical = _clean_msisdn(msisdn_raw)
            if not canonical:
                return Response({'detail': 'Not a valid phone number'}, status=status.HTTP_400_BAD_REQUEST)
            identity = DeviceIdentity.objects.filter(msisdn_lookup=msisdn_lookup_key(canonical)).first()
        else:
            query_type, query_value = 'imei', imei_raw
            identity = DeviceIdentity.objects.filter(imei_lookup=imei_lookup_key(imei_raw)).first()

        sample = None
        if identity:
            sample = (
                TelemetrySample.objects
                .filter(device_id=identity.device_hash)
                .exclude(lat__isnull=True).exclude(lng__isnull=True)
                .order_by('-received_at')
                .first()
            )

        found = sample is not None
        DeviceLocationTraceLog.objects.create(
            looked_up_by=request.user, query_type=query_type, query_value=query_value[:32], found=found,
            case_reference=case_reference, emergency=emergency,
        )
        log_audit_event(
            request, 'DEVICE_LOCATION_TRACE.SEARCHED', resource='device_location_trace',
            payload={'case_reference': case_reference, 'query_type': query_type, 'found': found,
                     'emergency_id': emergency.id},
        )

        if not found:
            return Response({'found': False})
        return Response({
            'found': True,
            'device_hash': identity.device_hash,
            'lat': sample.lat,
            'lng': sample.lng,
            'network_type': sample.network_type,
            'ts': sample.ts,
            'received_at': sample.received_at,
            'phone_model': identity.phone_model or None,
            'manufacturer': identity.manufacturer or None,
        })
