"""Device identity upload and operator lookup (2026-10-05).

The app sends its own MSISDN, IMEI, model and declared user type. On current
Android, a normal app can't read MSISDN or IMEI, so these fields stay empty
until the build is carrier-privileged. The server accepts what's sent and
never guesses.

    POST /api/telemetry/v1/device-identity/   device upload (registered device only)
    GET  /api/v2/device-identities/           operator lookup, device.view_identity, audited
"""
import re

from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .access import CanViewIdentity
from .audit import log_audit_event
from .collection import decrypted_identity, msisdn_lookup_key, upsert_identity
from .models import DeviceIdentity
from .rescue import _clean_msisdn
from .telemetry import resolve_ingest_caller

_IMEI_RE = re.compile(r'^\d{14,16}$')
_MAX_RESULTS = 20


class DeviceIdentityUploadView(APIView):
    """`POST /api/telemetry/v1/device-identity/` -- body, every field optional:
    `{"msisdn": "+977...", "imei": "...", "phone_model": "...",
      "manufacturer": "...", "user_type": "general" | "employee"}`

    Needs a registered, signed device. The shared key is refused here, since
    it ships in the APK and can't prove which phone it's coming from. An
    empty string clears a field. Responses never echo the values back."""
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own auth, like the other device endpoints

    def post(self, request):
        device, _key, err = resolve_ingest_caller(request)
        if err:
            return Response({'detail': err}, status=status.HTTP_401_UNAUTHORIZED)
        if device is None:
            return Response({'detail': 'identity upload needs a registered device'},
                            status=status.HTTP_403_FORBIDDEN)

        data = request.data if isinstance(request.data, dict) else {}
        fields = {}

        if 'msisdn' in data:
            raw = str(data.get('msisdn') or '').strip()
            if raw and not _clean_msisdn(raw):
                return Response({'detail': 'msisdn is not a valid number'}, status=status.HTTP_400_BAD_REQUEST)
            fields['msisdn'] = _clean_msisdn(raw) or ''
        if 'imei' in data:
            raw = str(data.get('imei') or '').strip()
            if raw and not _IMEI_RE.match(raw):
                return Response({'detail': 'imei must be 14 to 16 digits'}, status=status.HTTP_400_BAD_REQUEST)
            fields['imei'] = raw
        if 'phone_model' in data:
            fields['phone_model'] = str(data.get('phone_model') or '').strip()[:80]
        if 'manufacturer' in data:
            fields['manufacturer'] = str(data.get('manufacturer') or '').strip()[:80]
        if 'user_type' in data:
            user_type = str(data.get('user_type') or '').strip().lower()
            valid = {choice for choice, _ in DeviceIdentity.USER_TYPE_CHOICES}
            if user_type not in valid:
                return Response({'detail': 'user_type must be general or employee'},
                                status=status.HTTP_400_BAD_REQUEST)
            fields['user_type'] = user_type

        upsert_identity(device.device_hash, **fields)
        return Response({'stored': sorted(fields.keys())}, status=status.HTTP_200_OK)


class DeviceIdentityLookupView(APIView):
    """`GET /api/v2/device-identities/?msisdn=+977...` or `?device_hash=...`.
    Needs device.view_identity. Every call is audited, including the ones that
    find nothing. The audit entry records how many matched, never the number
    searched for."""
    permission_classes = [IsAuthenticated, CanViewIdentity]

    def get(self, request):
        msisdn = request.query_params.get('msisdn')
        device_hash = (request.query_params.get('device_hash') or '').strip()
        if not msisdn and not device_hash:
            return Response({'detail': 'msisdn or device_hash is required'},
                            status=status.HTTP_400_BAD_REQUEST)

        if msisdn:
            cleaned = _clean_msisdn(msisdn.strip())
            if not cleaned:
                return Response({'detail': 'msisdn is not a valid number'}, status=status.HTTP_400_BAD_REQUEST)
            matches = list(DeviceIdentity.objects.filter(
                msisdn_lookup=msisdn_lookup_key(cleaned))[:_MAX_RESULTS])
            query_by = 'msisdn'
        else:
            matches = list(DeviceIdentity.objects.filter(device_hash=device_hash)[:_MAX_RESULTS])
            query_by = 'device_hash'

        log_audit_event(
            request, 'IDENTITY.VIEW', resource='device_identity',
            resource_id=matches[0].device_hash if len(matches) == 1 else '',
            detail=f'by={query_by} matches={len(matches)}',
        )
        return Response({'results': [decrypted_identity(m) for m in matches]})
