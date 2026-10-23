"""Rescue beacon on and off from a registered phone, signed (audit 2026-10-23).

    POST /api/telemetry/v1/device/rescue-consent/   {"consent": true | false}

Replaces the shared-key `rescue-enroll/` (core/rescue.py RescueEnrollView),
which accepted any typed number from any phone holding the app key. Here:

- the request is signed by a registered phone (core/device_auth.py);
- the number is the phone's registered number, never one sent in the body;
- when the Security setting "phone verification required" is on, the
  number must have been proved by SMS first;
- the beacon is filed under the phone's SDK id (`sdk_device_hash`, the id
  its readings arrive under), so its position updates from those readings.
  A phone that has not linked its SDK id yet gets 409 and tries again.

Turning it off erases the beacon, as before. The old endpoint keeps working
until RESCUE_SHARED_KEY_ACCEPTED_UNTIL, then answers 410.
"""
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from .device_auth import DeviceSignatureAuthentication, IsDevice
from .models import SubscriberDevice, SubscriberLastLocation
from .number_verify import verification_required
from .rescue import _clean_msisdn
from .subscriber_device import link_device, unlink_via
from .subscriber_network_resolver import resolve_subscriber_network_info


class DeviceRescueConsentView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request):
        device = request.user
        data = request.data if isinstance(request.data, dict) else {}
        consent = bool(data.get('consent'))
        device_id = device.sdk_device_hash or ''
        if not device_id:
            return Response({'detail': 'This phone has not finished linking yet. Try again in a minute.'}, status=409)

        if not consent:
            deleted, _ = SubscriberLastLocation.objects.filter(device_id=device_id).delete()
            unlink_via(device_id, SubscriberDevice.VIA_RESCUE)
            return Response({'enrolled': False, 'removed': deleted > 0})

        msisdn = _clean_msisdn(device.msisdn)
        if not msisdn:
            return Response({'detail': 'Register this phone with its number first.'}, status=400)
        if verification_required() and not device.msisdn_verified_at:
            return Response({'detail': 'Prove this number with the SMS code first.'}, status=403)

        obj, _ = SubscriberLastLocation.objects.get_or_create(device_id=device_id)
        obj.msisdn = msisdn
        network_info = resolve_subscriber_network_info(msisdn)
        if network_info.get('imsi'):
            obj.imsi = network_info['imsi']
        obj.rescue_consent = True
        obj.rescue_consent_at = timezone.now()
        obj.save(update_fields=['msisdn', 'imsi', 'rescue_consent', 'rescue_consent_at', 'updated_at'])
        link_device(
            msisdn, device_id, SubscriberDevice.VIA_RESCUE,
            app_version=str(data.get('app_version') or device.app_version or ''),
            verified_by=SubscriberDevice.VERIFIED_SMS if device.msisdn_verified_at else None,
        )
        return Response({'enrolled': True, 'msisdn': msisdn})
