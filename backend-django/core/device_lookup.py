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
emergency or the Rescue Enrolled Devices list) with no case-reference
field required of the caller, while still auditing every call
server-side regardless.
"""
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .collection import imei_lookup_key, msisdn_lookup_key
from .models import DeviceIdentity, DeviceLocationTraceLog, TelemetrySample
from .rescue import _clean_msisdn
from .views import IsSuperadminOnly


class DeviceLocationTraceView(APIView):
    """`GET /api/v2/device-location-trace/?msisdn=...` or `?imei=...` --
    exactly one of the two. Resolves to a DeviceIdentity row by its keyed
    lookup hash (never by decrypting every row), then returns that
    device's most recent GPS-tagged TelemetrySample. No rescue-location
    consent and no case reference required -- this reads whatever MSISDN/
    IMEI the device itself already uploaded as crowd/staff identity info,
    a separate and broader-reaching lane than Rescue Lookup's own
    consent-gated SubscriberLastLocation. Every call is logged to
    DeviceLocationTraceLog regardless of whether it finds a match.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
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
