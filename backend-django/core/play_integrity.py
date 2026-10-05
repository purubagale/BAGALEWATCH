"""Google Play Integrity verification for device registration (2026-10-04).

Registration is the one moment a device gets a credential, so it is the
one place we ask Google whether the caller is a genuine, unmodified build
of our app on a genuine device. The verdict is checked against:
  * the package name (PLAY_INTEGRITY_PACKAGE_NAME) -- a repackaged APK fails;
  * the challenge nonce the server issued -- a captured token cannot be replayed;
  * PLAY_RECOGNIZED app verdict and MEETS_DEVICE_INTEGRITY -- rooted or
    emulated devices fail.

Fails CLOSED: with PLAY_INTEGRITY_REQUIRED on (the default) and no
credentials or package name configured, registration is refused. Setting
PLAY_INTEGRITY_REQUIRED=false is a development-only escape hatch.
"""
import logging

import requests
from django.conf import settings
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import service_account

from .fcm import load_service_account_info

logger = logging.getLogger(__name__)

PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity'


def verify_integrity_token(token, expected_nonce):
    """Returns (ok, reason). `reason` is for server logs only, never echoed
    to the device, so a probing client learns nothing about which check failed."""
    if not settings.PLAY_INTEGRITY_REQUIRED:
        return True, 'play integrity disabled by settings'

    package = settings.PLAY_INTEGRITY_PACKAGE_NAME
    info = load_service_account_info()
    if not (package and info and token):
        return False, 'play integrity not configured or token missing'

    try:
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=[PLAY_INTEGRITY_SCOPE],
        )
        creds.refresh(GoogleRequest())
        resp = requests.post(
            f'https://playintegrity.googleapis.com/v1/{package}:decodeIntegrityToken',
            json={'integrityToken': token}, timeout=10,
            headers={'Authorization': f'Bearer {creds.token}'},
        )
    except Exception:
        logger.exception('Play Integrity call raised')
        return False, 'play integrity call failed'

    if resp.status_code != 200:
        return False, f'decodeIntegrityToken HTTP {resp.status_code}'

    payload = resp.json().get('tokenPayloadExternal', {})
    details = payload.get('requestDetails', {})
    app = payload.get('appIntegrity', {})
    device = payload.get('deviceIntegrity', {})

    if details.get('nonce') != expected_nonce:
        return False, 'challenge nonce mismatch'
    if app.get('packageName') != package:
        return False, 'package name mismatch'
    if app.get('appRecognitionVerdict') != 'PLAY_RECOGNIZED':
        return False, f'app verdict {app.get("appRecognitionVerdict")}'
    if 'MEETS_DEVICE_INTEGRITY' not in device.get('deviceRecognitionVerdict', []):
        return False, 'device integrity not met'
    return True, 'ok'
