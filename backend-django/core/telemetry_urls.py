"""URLs for the crowdsourced telemetry ingestion API, mounted at
`/api/telemetry/v1/` (dtwatch/urls.py) — separate from both `/api/v2/`
(the React app, JWT) and `/api/external/v1/` (partner ApiKey), matching
the isolation decision in models.py's TelemetryIngestKey docstring."""
from django.urls import path

from . import device_identity, device_trace, speed_test
from .consent import DriveTestConsentMessageView, DriveTestConsentView
from .rescue import RescueEnrollView
from .telemetry import TelemetryHealthView, TelemetryIngestView
from .volte_quality import VolteSampleIngestView

urlpatterns = [
    path('samples/', TelemetryIngestView.as_view(), name='telemetry-ingest'),
    path('health/', TelemetryHealthView.as_view(), name='telemetry-health'),
    # Device identity (MSISDN, IMEI, model), registered signed devices only (2026-10-05).
    path('device-identity/', device_identity.DeviceIdentityUploadView.as_view(), name='device-identity'),
    # Active speed test (2026-10-05) -- public but size-capped and rate-limited,
    # and the app runs it only on a user tap. See core/speed_test.py.
    path('speedtest/ping/', speed_test.SpeedTestPingView.as_view(), name='speedtest-ping'),
    path('speedtest/download/', speed_test.SpeedTestDownloadView.as_view(), name='speedtest-download'),
    path('speedtest/upload/', speed_test.SpeedTestUploadView.as_view(), name='speedtest-upload'),
    # VoLTE/VoNR call-quality ingest (2026-10-02) -- same ingest-key auth,
    # dormant until the app has carrier-privileged status. See
    # core/volte_quality.py's module docstring.
    path('volte-samples/', VolteSampleIngestView.as_view(), name='volte-samples'),
    # Rescue-beacon opt-in/opt-out (2026-09-01) — same ingest-key auth as
    # samples/ above, called by the device itself. See core/rescue.py.
    path('rescue-enroll/', RescueEnrollView.as_view(), name='rescue-enroll'),
    # Drive-test participation consent (2026-09-02) — same ingest-key
    # auth, called by the device itself. See core/consent.py.
    path('drive-test-consent/', DriveTestConsentView.as_view(), name='drive-test-consent'),
    # Fetches the (superadmin-editable) copy shown before a subscriber
    # answers the above — see core/consent.py's DriveTestConsentMessageView.
    path('drive-test-consent-message/', DriveTestConsentMessageView.as_view(), name='drive-test-consent-message'),

    # Device-bound, consent-gated tracing (2026-10-04) -- signed device
    # calls, not the shared APK key. See core/device_trace.py's docstring.
    path('device/challenge/', device_trace.DeviceChallengeView.as_view(), name='device-challenge'),
    path('device/register/', device_trace.DeviceRegisterView.as_view(), name='device-register'),
    path('device/fcm-token/', device_trace.DeviceFcmTokenView.as_view(), name='device-fcm-token'),
    path('device/trace-requests/', device_trace.DeviceTraceListView.as_view(), name='device-trace-list'),
    path('device/trace-requests/<uuid:trace_id>/respond/', device_trace.DeviceTraceRespondView.as_view(), name='device-trace-respond'),
    path('device/trace-requests/<uuid:trace_id>/samples/', device_trace.DeviceTraceSamplesView.as_view(), name='device-trace-samples'),
]
