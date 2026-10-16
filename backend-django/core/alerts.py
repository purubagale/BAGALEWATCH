"""Attack alerts to the superadmins (2026-10-15).

When the system acts on a login attack it now also tells people, instead
of only flagging the Audit Log:

    ip_blocked      an address was blocked automatically after repeated
                    failed logins (core/ip_block.py maybe_auto_block)
    account_locked  an account reached the failed-login limit and is locked
                    for 15 minutes (core/views.py LoginView)

A superadmin switches alerts on and chooses the channels on the Security
page (SecuritySettings: attack_alerts_enabled, alert_by_email, alert_by_sms,
plus extra addresses and numbers). Every active superadmin is told by the
email and mobile number on their account.

Email goes through Django's mail settings (EMAIL_HOST in .env; without it
the message only reaches the server log). SMS goes through the SMS gateway
(core/sms.py). Each place (address or account) raises at most one alert an
hour, and sending runs in the background so a login never waits on it.
Every alert sent is written to the Audit Log.
"""
import logging
import re
import threading

from django.conf import settings
from django.core.cache import cache
from django.core.mail import send_mail
from django.db import close_old_connections
from django.utils import timezone

from .models import AuditEvent, SecuritySettings, User
from .rescue import _clean_msisdn
from .sms import send_sms

logger = logging.getLogger(__name__)

ONE_ALERT_PER_SECONDS = 3600
_SPLIT = re.compile(r'[\s,;]+')


def email_configured():
    return bool(getattr(settings, 'EMAIL_HOST', ''))


def recipients(security):
    """(emails, numbers) for the channels switched on."""
    admins = list(User.objects.filter(role='superadmin', is_active=True).values_list('email', 'mobile_number'))
    emails, numbers = [], []
    if security.alert_by_email:
        emails = [e for e, _ in admins if e] + [e for e in _SPLIT.split(security.alert_extra_emails or '') if '@' in e]
    if security.alert_by_sms:
        raw = [n for _, n in admins if n] + [n for n in _SPLIT.split(security.alert_extra_numbers or '') if n]
        numbers = [c for c in (_clean_msisdn(n) for n in raw) if c]
    return sorted(set(emails)), sorted(set(numbers))


def deliver(subject, body, sms_text, emails, numbers):
    """Sends now; returns what happened per channel. Never raises."""
    result = {'email': None, 'sms': None}
    if emails:
        try:
            send_mail(subject, body, settings.DEFAULT_FROM_EMAIL, emails, fail_silently=False)
            result['email'] = f'sent to {len(emails)}' + ('' if email_configured() else ' (server log only: no EMAIL_HOST)')
        except Exception as exc:  # noqa: BLE001 -- an alert must never break anything
            logger.warning('attack alert email failed: %r', exc)
            result['email'] = f'failed: {exc.__class__.__name__}'
    if numbers:
        sent = sum(1 for n in numbers if send_sms(n, sms_text)[0])
        result['sms'] = f'sent to {sent} of {len(numbers)}'
    return result


def _deliver_and_log(kind, key, subject, body, sms_text, emails, numbers):
    try:
        result = deliver(subject, body, sms_text, emails, numbers)
        AuditEvent.objects.create(action='ATTACK_ALERT.SENT', resource='security', resource_id=str(key)[:40],
                                  detail=f'{kind}: email {result["email"] or "-"}, sms {result["sms"] or "-"}'[:200])
    except Exception:  # noqa: BLE001
        logger.exception('attack alert failed')
    finally:
        close_old_connections()


def attack_alert(kind, key, what, detail=''):
    """Raises an alert, if alerts are on and none went out for `key` this
    hour. `what` is one line ("Address 1.2.3.4 blocked"), `detail` more."""
    try:
        security = SecuritySettings.objects.filter(pk=1).first()
        if not security or not security.attack_alerts_enabled:
            return
        emails, numbers = recipients(security)
        if not emails and not numbers:
            return
        if not cache.add(f'attackalert:{kind}:{key}', 1, timeout=ONE_ALERT_PER_SECONDS):
            return
        when = timezone.localtime().strftime('%Y-%m-%d %H:%M')
        subject = f'DT-WATCH security alert: {what}'
        body = (f'{what} at {when}.\n\n{detail}\n\n'
                'See the Audit Log and Blocked IPs pages in DT-WATCH. If this was a staff member who forgot their '
                'password, a superadmin can unblock the address on the Blocked IPs page.\n\n'
                'This alert is sent at most once an hour for the same address or account. Alerts are set on the '
                'Security page.')
        sms_text = f'DT-WATCH alert: {what} at {when}. See the Audit Log.'
        threading.Thread(target=_deliver_and_log, args=(kind, key, subject, body, sms_text, emails, numbers),
                         daemon=True).start()
    except Exception:  # noqa: BLE001 -- an alert must never break a login
        logger.exception('attack_alert failed')
