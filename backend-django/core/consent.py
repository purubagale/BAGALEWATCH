"""
Drive-test participation consent (2026-09-02) — a FOURTH lane alongside
the anonymous telemetry pipeline (telemetry.py), the rescue-location
beacon (rescue.py), and the uploaded-.trp-file drive-test manager
(drive_test.py). Deliberately its own module, same "one file per feature"
convention as those three, because this is its own purpose-limited
consent with its own governance, not an extension of any of them.

One endpoint, device-initiated, same trust boundary as rescue-enroll:

  * DriveTestConsentView — `POST /api/telemetry/v1/drive-test-consent/`,
    mounted alongside TelemetryIngestView/RescueEnrollView
    (core/telemetry_urls.py) and authenticated the SAME way (a
    TelemetryIngestKey), because it's the device recording its own
    subscriber's choice, not an admin action.

This consent is read ONLY by TelemetryDriveTestSessionSamplesView
(core/telemetry_admin.py), and only for a session an admin explicitly
flagged `require_consent=True` at creation — see
TelemetryDriveTestSession.require_consent and TelemetryDriveTestConsent's
docstring (core/models.py) for the full "who checks this, and when"
picture. It is NEVER consulted for a session that didn't ask for it, and
it has no effect on whether a device's samples are ingested/stored at all
— only on whether a consent-gated session's samples VIEW surfaces them.

A SECOND pair of endpoints, added 2026-09-02, for the consent MESSAGE
itself rather than the subscriber's answer — same "device reads, admin
writes" split RescueConsentPolicy's two endpoints use in rescue.py:

  * DriveTestConsentMessageView — `GET /api/telemetry/v1/
    drive-test-consent-message/`, same ingest-key trust boundary as
    DriveTestConsentView above. Lets a host app that wants to DISPLAY
    centrally-editable copy fetch it instead of hardcoding its own —
    purely optional, see DriveTestConsentConfig's docstring (core/models.py).

  * DriveTestConsentMessageAdminView — `GET/POST /api/v2/telemetry/
    consent-message/`, superadmin-only, edits the same
    DriveTestConsentConfig row the view above serves.
"""
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DriveTestConsentConfig, TelemetryDriveTestConsent
from .telemetry import _key_from_request, _resolve_key, hash_device_id
from .views import IsSuperadminOnly


class DriveTestConsentView(APIView):
    """`POST /api/telemetry/v1/drive-test-consent/` — body:
    `{"device_id": "<raw sdk device id>", "consent": true}`

    Upserts a standing per-device flag (see TelemetryDriveTestConsent) —
    not tied to any one session, since a consent-gated session's samples
    view reads whatever this device's CURRENT flag is at fetch time. A
    device can flip this at any point; a later fetch reflects the change
    immediately (accept mid-session -> starts appearing; withdraw ->
    stops appearing), matching "those who accept the consent, will fetch
    data from that mobile else not."

    Same key mechanism as TelemetryIngestView/RescueEnrollView
    (Authorization: Bearer <tel_key> or X-API-Key) — this is the device
    recording its own subscriber's choice, not an admin action, so it
    belongs on the ingest-key surface, not `/api/v2/`.
    """
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own key check, same as TelemetryIngestView

    def post(self, request):
        key = _resolve_key(_key_from_request(request))
        if key is None:
            return Response({'detail': 'invalid or missing telemetry ingest key'},
                            status=status.HTTP_401_UNAUTHORIZED)

        raw_device_id = str(request.data.get('device_id') or '').strip()
        if not raw_device_id:
            return Response({'detail': 'device_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        device_id = hash_device_id(raw_device_id)
        consent = bool(request.data.get('consent'))

        obj, _created = TelemetryDriveTestConsent.objects.get_or_create(device_id=device_id)
        obj.consent = consent
        if consent:
            obj.consented_at = timezone.now()
        obj.save(update_fields=['consent', 'consented_at', 'updated_at'])
        return Response({'consent': consent})


class DriveTestConsentMessageView(APIView):
    """`GET /api/telemetry/v1/drive-test-consent-message/` — device-facing
    read of DriveTestConsentConfig.message (core/models.py). Same
    ingest-key trust boundary as DriveTestConsentView above (this is a
    device fetching copy to show its own subscriber, not an admin
    action). Gated by a valid key like every other endpoint on this
    surface, even though the message itself isn't sensitive — keeps this
    endpoint inside the same key-tracking/rate-limit accounting as the
    rest of `/api/telemetry/v1/`, rather than carving out a silent
    exception.
    """
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        key = _resolve_key(_key_from_request(request))
        if key is None:
            return Response({'detail': 'invalid or missing telemetry ingest key'},
                            status=status.HTTP_401_UNAUTHORIZED)
        config, _created = DriveTestConsentConfig.objects.get_or_create(pk=1)
        return Response({'message': config.message})


class DriveTestConsentMessageSerializer(serializers.Serializer):
    message = serializers.CharField(allow_blank=True, max_length=2000)


class DriveTestConsentMessageAdminView(APIView):
    """`GET/POST /api/v2/telemetry/consent-message/` — superadmin-only
    edit of the SAME DriveTestConsentConfig row DriveTestConsentMessageView
    (above) serves to devices. No audit log — see DriveTestConsentConfig's
    docstring for why this is lighter-weight than RescueConsentPolicy's
    change-tracking.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        config, _created = DriveTestConsentConfig.objects.get_or_create(pk=1)
        return Response({'message': config.message, 'updated_at': config.updated_at})

    def post(self, request):
        serializer = DriveTestConsentMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        config, _created = DriveTestConsentConfig.objects.get_or_create(pk=1)
        config.message = serializer.validated_data['message']
        config.updated_by = request.user
        config.save(update_fields=['message', 'updated_by', 'updated_at'])
        return Response({'message': config.message, 'updated_at': config.updated_at})
