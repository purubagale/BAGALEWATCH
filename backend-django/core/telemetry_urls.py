"""URLs for the crowdsourced telemetry ingestion API, mounted at
`/api/telemetry/v1/` (dtwatch/urls.py) — separate from both `/api/v2/`
(the React app, JWT) and `/api/external/v1/` (partner ApiKey), matching
the isolation decision in models.py's TelemetryIngestKey docstring."""
from django.urls import path

from . import (area_sample, call_context, device_identity, device_trace, number_verify, problem_report,
               rescue_signed, scheduled_readings, serving_site_lookup, site_photo, speed_test, trace_speed)
from .consent import DriveTestConsentMessageView, DriveTestConsentView
from .rescue import RescueEnrollView
from .telemetry import TelemetryHealthView, TelemetryIngestView
from .volte_quality import VolteSampleIngestView

urlpatterns = [
    path('samples/', TelemetryIngestView.as_view(), name='telemetry-ingest'),
    path('health/', TelemetryHealthView.as_view(), name='telemetry-health'),
    # General speed test results, from the public Speed test card (2026-10-07).
    path('speed-samples/', speed_test.TelemetrySpeedResultIngestView.as_view(), name='speed-samples-ingest'),
    # Push token of a sharing device, for on-demand area samples (2026-10-08).
    path('push-token/', area_sample.TelemetryPushTokenView.as_view(), name='telemetry-push-token'),
    # Device identity (MSISDN, IMEI, model), registered signed devices only (2026-10-05).
    path('device-identity/', device_identity.DeviceIdentityUploadView.as_view(), name='device-identity'),
    # Active speed test (2026-10-05) -- public but size-capped and rate-limited,
    # and the app runs it only on a user tap. See core/speed_test.py.
    path('speedtest/ping/', speed_test.SpeedTestPingView.as_view(), name='speedtest-ping'),
    path('speedtest/download/', speed_test.SpeedTestDownloadView.as_view(), name='speedtest-download'),
    path('speedtest/upload/', speed_test.SpeedTestUploadView.as_view(), name='speedtest-upload'),
    # Where phones run the test (2026-10-26): null = this server's nginx /speedtest/.
    path('speedtest/config/', speed_test.SpeedTestConfigView.as_view(), name='speedtest-config'),
    # VoLTE/VoNR call-quality ingest (2026-10-02) -- same ingest-key auth,
    # dormant until the app has carrier-privileged status. See
    # core/volte_quality.py's module docstring.
    path('volte-samples/', VolteSampleIngestView.as_view(), name='volte-samples'),
    # Calls as an ordinary app sees them: voice network, duration, cell and
    # level, no quality figures (2026-10-14). See core/call_context.py.
    path('call-samples/', call_context.CallContextIngestView.as_view(), name='call-samples'),
    # 'Help improve NTC's network': four anonymous readings a day (2026-10-29).
    path('scheduled-readings/', scheduled_readings.ScheduledReadingIngestView.as_view(), name='scheduled-readings'),
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
    # Ties a registered phone to its SDK device id, for signed uploads (2026-10-14).
    path('device/sdk-link/', device_trace.DeviceSdkLinkView.as_view(), name='device-sdk-link'),
    # Proving the registered number by SMS code (2026-10-15) -- see core/number_verify.py.
    path('device/verify-number/', number_verify.NumberVerifyStatusView.as_view(), name='device-verify-number'),
    path('device/verify-number/start/', number_verify.NumberVerifyStartView.as_view(), name='device-verify-number-start'),
    path('device/verify-number/confirm/', number_verify.NumberVerifyConfirmView.as_view(), name='device-verify-number-confirm'),
    # Site photos from the app (2026-10-11) -- see core/site_photo.py.
    path('device/nearby-sites/', site_photo.DeviceNearbySitesView.as_view(), name='device-nearby-sites'),
    path('device/site-photos/', site_photo.DeviceSitePhotoUploadView.as_view(), name='device-site-photos'),
    # Rescue beacon from a registered phone, signed (2026-10-23) -- see core/rescue_signed.py.
    path('device/rescue-consent/', rescue_signed.DeviceRescueConsentView.as_view(), name='device-rescue-consent'),
    # Site and sector of the phone's serving cell, for the Signal screen (2026-10-19).
    path('device/serving-site/', serving_site_lookup.DeviceServingSiteView.as_view(), name='device-serving-site'),
    # "Report a problem" from the app (2026-10-14) -- see core/problem_report.py.
    path('device/problem-reports/', problem_report.DeviceProblemReportView.as_view(), name='device-problem-reports'),
    path('device/trace-requests/', device_trace.DeviceTraceListView.as_view(), name='device-trace-list'),
    path('device/trace-requests/<uuid:trace_id>/respond/', device_trace.DeviceTraceRespondView.as_view(), name='device-trace-respond'),
    path('device/trace-requests/<uuid:trace_id>/samples/', device_trace.DeviceTraceSamplesView.as_view(), name='device-trace-samples'),
    # Speed test bound to an accepted trace (2026-10-05): device-signed, and only
    # while the trace is ACCEPTED and not expired. See core/trace_speed.py.
    path('device/trace-requests/<uuid:trace_id>/speedtest/ping/', trace_speed.TraceSpeedPingView.as_view(), name='device-trace-speedtest-ping'),
    path('device/trace-requests/<uuid:trace_id>/speedtest/download/', trace_speed.TraceSpeedDownloadView.as_view(), name='device-trace-speedtest-download'),
    path('device/trace-requests/<uuid:trace_id>/speedtest/upload/', trace_speed.TraceSpeedUploadView.as_view(), name='device-trace-speedtest-upload'),
    path('device/trace-requests/<uuid:trace_id>/speedtest/result/', trace_speed.TraceSpeedResultView.as_view(), name='device-trace-speedtest-result'),
]
