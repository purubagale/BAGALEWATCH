"""Firebase Cloud Messaging (HTTP v1) push for device trace requests
(2026-10-04). Inert when FCM_SERVICE_ACCOUNT_JSON is unset: send_trace_push()
returns False and the device still learns of pending requests by polling
GET /api/telemetry/v1/device/trace-requests/, so push is an accelerator,
not a requirement.

The payload is data-only and carries only the request id. No MSISDN, no
case reference, no location -- a push can be read off the device's
notification log, so it must reveal nothing about why it was sent.
"""
import json
import logging

import requests
from django.conf import settings
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import service_account

logger = logging.getLogger(__name__)

FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
_credentials = None


def load_service_account_info():
    """The service-account JSON as a dict, from either the inline JSON or a
    file path, or None when unset/unreadable. Shared with play_integrity."""
    raw = (settings.FCM_SERVICE_ACCOUNT_JSON or '').strip()
    if not raw:
        return None
    try:
        if raw.startswith('{'):
            return json.loads(raw)
        with open(raw, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        logger.exception('FCM_SERVICE_ACCOUNT_JSON is set but could not be loaded')
        return None


def _access_token(info, scope):
    creds = service_account.Credentials.from_service_account_info(info, scopes=[scope])
    creds.refresh(GoogleRequest())
    return creds.token


def send_trace_push(fcm_token, request_id):
    """Sends one trace_request data message. Returns True only on a 200 from
    FCM. Never raises: a failed push must not fail the operator's request."""
    global _credentials
    if not fcm_token:
        return False
    info = load_service_account_info()
    if not info:
        return False
    try:
        if _credentials is None:
            _credentials = service_account.Credentials.from_service_account_info(
                info, scopes=[FCM_SCOPE],
            )
        if not _credentials.valid:
            _credentials.refresh(GoogleRequest())
        url = f'https://fcm.googleapis.com/v1/projects/{info["project_id"]}/messages:send'
        body = {
            'message': {
                'token': fcm_token,
                'data': {'type': 'trace_request', 'request_id': str(request_id)},
                'android': {'priority': 'high'},
            },
        }
        resp = requests.post(
            url, json=body, timeout=10,
            headers={'Authorization': f'Bearer {_credentials.token}'},
        )
        if resp.status_code == 200:
            return True
        logger.warning('FCM push failed: HTTP %s %s', resp.status_code, resp.text[:300])
    except Exception:
        logger.exception('FCM push raised')
    return False
