"""URLs for the crowdsourced telemetry ingestion API, mounted at
`/api/telemetry/v1/` (dtwatch/urls.py) — separate from both `/api/v2/`
(the React app, JWT) and `/api/external/v1/` (partner ApiKey), matching
the isolation decision in models.py's TelemetryIngestKey docstring."""
from django.urls import path

from .consent import DriveTestConsentMessageView, DriveTestConsentView
from .rescue import RescueEnrollView
from .telemetry import TelemetryHealthView, TelemetryIngestView

urlpatterns = [
    path('samples/', TelemetryIngestView.as_view(), name='telemetry-ingest'),
    path('health/', TelemetryHealthView.as_view(), name='telemetry-health'),
    # Rescue-beacon opt-in/opt-out (2026-09-01) — same ingest-key auth as
    # samples/ above, called by the device itself. See core/rescue.py.
    path('rescue-enroll/', RescueEnrollView.as_view(), name='rescue-enroll'),
    # Drive-test participation consent (2026-09-02) — same ingest-key
    # auth, called by the device itself. See core/consent.py.
    path('drive-test-consent/', DriveTestConsentView.as_view(), name='drive-test-consent'),
    # Fetches the (superadmin-editable) copy shown before a subscriber
    # answers the above — see core/consent.py's DriveTestConsentMessageView.
    path('drive-test-consent-message/', DriveTestConsentMessageView.as_view(), name='drive-test-consent-message'),
]
