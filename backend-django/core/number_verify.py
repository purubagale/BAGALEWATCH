"""Proving a registered phone owns its number (2026-10-15 security audit).

Until now the number a phone registered with was only typed in the app, so
someone could register another person's number, and that person's lookups
(Subscriber Profile, Device Location Trace, rescue) would then show the
wrong phone. Now the server can send a code by SMS to the number
(core/sms.py), and the app sends it back:

    GET  /api/telemetry/v1/device/verify-number/          is it verified, can it be
    POST /api/telemetry/v1/device/verify-number/start/    send a code to the number
    POST /api/telemetry/v1/device/verify-number/confirm/  {"code": "123456"}

All three are signed by the registered phone (DeviceSignatureAuthentication),
so a code is only ever sent to the number that phone registered with, and
only that phone can confirm it.

On success the phone's credential is marked verified and its links to the
number are marked "Confirmed by SMS code". Another phone that had registered
the same number WITHOUT proving it loses it (its links end, reason
"verified_elsewhere"): an unproven claim no longer blocks the real owner.

With SecuritySettings.phone_verification_required on, the lookups count
only links confirmed by SMS (or read from the SIM); see
subscriber_device.devices_for_msisdn.

Limits: a code lives CODE_MINUTES, takes MAX_TRIES guesses, is stored only
as a hash, and a phone can ask for one every RESEND_SECONDS, at most
MAX_PER_DAY a day; a number receives at most MAX_PER_NUMBER_DAY a day.
"""
import hashlib
import hmac
import secrets

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .device_auth import DeviceSignatureAuthentication, IsDevice
from .models import DeviceCredential, SecuritySettings, SubscriberDevice
from .rescue import _clean_msisdn
from .sms import send_sms, status as sms_status

CODE_MINUTES = 10
MAX_TRIES = 5
RESEND_SECONDS = 60
MAX_PER_DAY = 5
MAX_PER_NUMBER_DAY = 5


def verification_available():
    """True when a code can actually reach a phone (or the log, when testing)."""
    return settings.SMS_BACKEND == 'console' or sms_status()['configured']


def verification_required():
    return SecuritySettings.objects.filter(pk=1, phone_verification_required=True).exists()


def info(credential):
    """What the app is told after registering, and on GET."""
    return {
        'number_verified': credential.msisdn_verified_at is not None,
        'verification_available': verification_available(),
        'verification_required': verification_required(),
    }


def _hash(code, device_hash):
    return hashlib.sha256(f'{device_hash}:{code}'.encode()).hexdigest()


def _counter(key, timeout):
    cache.add(key, 0, timeout=timeout)
    try:
        return cache.incr(key)
    except ValueError:
        return 1


def mark_verified(credential, msisdn):
    """The phone proved `msisdn`. Marks it, and releases the number from any
    other phone that only claimed it."""
    now = timezone.now()
    DeviceCredential.objects.filter(pk=credential.pk).update(msisdn_verified_at=now)
    own = [h for h in (credential.device_hash, credential.sdk_device_hash) if h]
    SubscriberDevice.objects.filter(msisdn=msisdn, device_hash__in=own, ended_at__isnull=True).update(
        number_verified_by=SubscriberDevice.VERIFIED_SMS)
    others = DeviceCredential.objects.filter(msisdn=msisdn, msisdn_verified_at__isnull=True).exclude(pk=credential.pk)
    released = 0
    for other in others:
        hashes = [h for h in (other.device_hash, other.sdk_device_hash) if h]
        SubscriberDevice.objects.filter(msisdn=msisdn, device_hash__in=hashes, ended_at__isnull=True).update(
            ended_at=now, ended_reason='verified_elsewhere')
        other.msisdn = ''
        other.save(update_fields=['msisdn'])
        released += 1
    return released


class NumberVerifyStatusView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def get(self, request):
        return Response(info(request.user))


class NumberVerifyStartView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request):
        device = request.user
        msisdn = _clean_msisdn(device.msisdn)
        if not msisdn:
            return Response({'detail': 'This phone has no number registered.'}, status=status.HTTP_400_BAD_REQUEST)
        if device.msisdn_verified_at:
            return Response({**info(device), 'detail': 'The number is already verified.'})
        if not verification_available():
            return Response({'detail': 'Number verification is not available yet.'},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if not cache.add(f'numverify:wait:{device.device_hash}', 1, timeout=RESEND_SECONDS):
            return Response({'detail': f'Wait a minute before asking for another code.', 'retry_after': RESEND_SECONDS},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)
        day = f'{timezone.now():%Y%m%d}'
        if _counter(f'numverify:day:{device.device_hash}:{day}', 86400) > MAX_PER_DAY or \
                _counter(f'numverify:num:{msisdn}:{day}', 86400) > MAX_PER_NUMBER_DAY:
            return Response({'detail': 'Too many codes today. Try again tomorrow.'},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)

        code = f'{secrets.randbelow(10 ** 6):06d}'
        cache.set(f'numverify:code:{device.device_hash}',
                  {'h': _hash(code, device.device_hash), 'msisdn': msisdn, 'tries': 0}, timeout=CODE_MINUTES * 60)
        sent, message = send_sms(msisdn, settings.SMS_VERIFY_TEXT.format(code=code, minutes=CODE_MINUTES))
        if not sent:
            cache.delete(f'numverify:code:{device.device_hash}')
            cache.delete(f'numverify:wait:{device.device_hash}')
            return Response({'detail': 'The code could not be sent. Try again later.'},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        log_audit_event(request, 'number_verify_sent', resource='device_credential', resource_id=str(device.pk),
                        detail=f'code sent to {msisdn[:5]}…{msisdn[-2:]}')
        return Response({'sent': True, 'expires_in': CODE_MINUTES * 60, 'resend_after': RESEND_SECONDS})


class NumberVerifyConfirmView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request):
        device = request.user
        key = f'numverify:code:{device.device_hash}'
        entry = cache.get(key)
        code = ''.join(ch for ch in str(request.data.get('code') or '') if ch.isdigit())
        if not entry:
            return Response({'detail': 'The code has expired. Ask for a new one.'}, status=status.HTTP_400_BAD_REQUEST)
        entry['tries'] += 1
        if entry['tries'] > MAX_TRIES:
            cache.delete(key)
            return Response({'detail': 'Too many wrong codes. Ask for a new one.'}, status=status.HTTP_400_BAD_REQUEST)
        msisdn = _clean_msisdn(device.msisdn)
        if not hmac.compare_digest(entry['h'], _hash(code, device.device_hash)) or msisdn != entry['msisdn']:
            cache.set(key, entry, timeout=CODE_MINUTES * 60)
            left = MAX_TRIES - entry['tries']
            return Response({'detail': f'Wrong code. {left} tr{"y" if left == 1 else "ies"} left.'},
                            status=status.HTTP_400_BAD_REQUEST)
        cache.delete(key)
        released = mark_verified(device, msisdn)
        device.msisdn_verified_at = timezone.now()
        log_audit_event(request, 'number_verified', resource='device_credential', resource_id=str(device.pk),
                        detail=f'{msisdn[:5]}…{msisdn[-2:]} verified by SMS'
                               + (f'; released from {released} other phone(s)' if released else ''))
        return Response({**info(device), 'detail': 'Number verified.'})
