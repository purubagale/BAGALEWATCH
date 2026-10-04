"""Device request signing for the consent-gated tracing lane (2026-10-04).

Replaces the shared `tel_` APK key as the credential for device-originated
calls. The app holds a non-exportable Android Keystore EC P-256 private
key; every device request carries an ECDSA-SHA256 signature over a
canonical string that binds the method, path, timestamp, nonce, and body.
Extracting the APK yields no key that can sign, so it cannot post data.

Headers the device sends:
  X-Device-Id    the fingerprint of its public key (see fingerprint_from_pem)
  X-Timestamp    epoch seconds; must be within SKEW_SECONDS of server time
  X-Nonce        single-use, 8-128 chars of [A-Za-z0-9_-]
  X-Signature    base64 (standard, padded) DER ECDSA signature over
                 canonical_message(method, path, timestamp, nonce, body)

Replay protection: each (device, nonce) pair is stored with cache.add for
NONCE_TTL seconds, so a captured request is rejected the second time it
is seen, and the timestamp window bounds how long a nonce must be remembered.
"""
import base64
import binascii
import hashlib
import re
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.cache import cache
from django.utils import timezone
from rest_framework import authentication, exceptions, permissions

from .models import DeviceCredential
from .telemetry import hash_device_id

SKEW_SECONDS = 120
NONCE_TTL = 300
_NONCE_RE = re.compile(r'^[A-Za-z0-9_-]{8,128}$')


def canonical_message(method, path, ts, nonce, body):
    """The exact bytes the device signs. Changing this format is a breaking
    change for every installed app build -- keep it in sync with the
    mobile SDK's signing spec (docs/telemetry_pipeline_mobile_handoff.md §13)."""
    body_hash = hashlib.sha256(body or b'').hexdigest()
    return f'{method.upper()}|{path}|{ts}|{nonce}|{body_hash}'.encode()


def load_ec_p256_public_key(pem):
    """Parses a PEM public key and insists on P-256. Raises ValueError otherwise."""
    key = serialization.load_pem_public_key(pem.encode())
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != 'secp256r1':
        raise ValueError('device key must be an EC P-256 public key')
    return key


def fingerprint_from_pem(pem):
    """Stable device id: SHA-256 of the key's canonical DER, first 32 hex chars.
    Derived from the key itself so a device cannot claim someone else's id
    while using a different key."""
    key = load_ec_p256_public_key(pem)
    der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:32]


class DeviceSignatureAuthentication(authentication.BaseAuthentication):
    """DRF authentication class for device-originated endpoints. On success
    `request.user` is the DeviceCredential itself (check with IsDevice)."""

    def authenticate(self, request):
        device_id = request.META.get('HTTP_X_DEVICE_ID', '')
        sig_b64 = request.META.get('HTTP_X_SIGNATURE', '')
        ts_raw = request.META.get('HTTP_X_TIMESTAMP', '')
        nonce = request.META.get('HTTP_X_NONCE', '')
        if not (device_id and sig_b64 and ts_raw and nonce):
            raise exceptions.AuthenticationFailed('missing device signature headers')

        try:
            ts = int(ts_raw)
        except ValueError:
            raise exceptions.AuthenticationFailed('invalid timestamp')
        if abs(time.time() - ts) > SKEW_SECONDS:
            raise exceptions.AuthenticationFailed('timestamp outside allowed window')
        if not _NONCE_RE.match(nonce):
            raise exceptions.AuthenticationFailed('invalid nonce')

        device = DeviceCredential.objects.filter(
            device_hash=hash_device_id(device_id), revoked_at__isnull=True,
        ).first()
        if device is None:
            raise exceptions.AuthenticationFailed('unknown or revoked device')

        try:
            pub = load_ec_p256_public_key(device.public_key_pem)
            sig = base64.b64decode(sig_b64, validate=True)
            pub.verify(
                sig,
                canonical_message(request.method, request.path, ts, nonce, request.body),
                ec.ECDSA(hashes.SHA256()),
            )
        except (InvalidSignature, ValueError, TypeError, binascii.Error):
            raise exceptions.AuthenticationFailed('bad device signature')

        # Checked only after the signature verifies, so an attacker without
        # the key cannot burn a legitimate device's nonces.
        if not cache.add(f'devnonce:{device.device_hash}:{nonce}', 1, timeout=NONCE_TTL):
            raise exceptions.AuthenticationFailed('nonce already used')

        DeviceCredential.objects.filter(pk=device.pk).update(last_seen_at=timezone.now())
        return (device, None)

    def authenticate_header(self, request):
        return 'DeviceSignature'


class IsDevice(permissions.BasePermission):
    """Passes only when DeviceSignatureAuthentication authenticated the request."""

    def has_permission(self, request, view):
        return isinstance(request.user, DeviceCredential)
