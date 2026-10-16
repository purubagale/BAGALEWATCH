"""Sending an SMS (2026-10-15; the seam planned as Phase G).

One function, `send_sms(number, text)`, and the backend chosen by
`SMS_BACKEND` in .env (see settings.py for every setting):

    off       the default: sends nothing, and the app is not asked to
              verify its number.
    console   writes the message to the server log; nothing is sent. For
              testing on a development machine.
    http      a generic HTTP SMS gateway, described entirely by settings:
              address, method, field names, headers, authentication.
    ntc       the same as http; the name to use once NTC's gateway details
              are filled in.

`send_sms` never raises: it returns (sent, message), so a gateway that is
down shows as a plain error to the person, not a server fault. The message
text is never written to the log by the http backend (it holds codes).
"""
import base64
import json
import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)


def number_forms(canonical):
    """The spellings a gateway may want, from a canonical 977XXXXXXXXXX."""
    local = canonical[3:] if canonical.startswith('977') else canonical
    return {'to': canonical, 'to_local': local, 'to_plus': f'+{canonical}'}


def status():
    """What the Security page shows about the gateway (no secrets)."""
    backend = settings.SMS_BACKEND
    configured = backend in ('http', 'ntc') and bool(settings.SMS_HTTP_URL)
    return {
        'backend': backend,
        'configured': configured,
        'sends_real_sms': configured,
        'address_host': requests.utils.urlparse(settings.SMS_HTTP_URL).hostname if settings.SMS_HTTP_URL else None,
        'sender_id': settings.SMS_SENDER_ID,
        'encoding': settings.SMS_HTTP_ENCODING,
        'method': settings.SMS_HTTP_METHOD,
    }


def _fill(value, values):
    if isinstance(value, str):
        for k, v in values.items():
            value = value.replace('{' + k + '}', v)
        return value
    if isinstance(value, dict):
        return {k: _fill(v, values) for k, v in value.items()}
    if isinstance(value, list):
        return [_fill(v, values) for v in value]
    return value


def _send_http(canonical, text):
    if not settings.SMS_HTTP_URL:
        return False, 'The SMS gateway address is not set.'
    try:
        fields = json.loads(settings.SMS_HTTP_FIELDS or '{}')
        headers = json.loads(settings.SMS_HTTP_HEADERS or '{}')
    except ValueError:
        return False, 'SMS_HTTP_FIELDS or SMS_HTTP_HEADERS is not valid JSON.'
    values = {**number_forms(canonical), 'text': text, 'sender': settings.SMS_SENDER_ID}
    fields = _fill(fields, values)
    headers = {str(k): str(_fill(v, values)) for k, v in headers.items()}
    if settings.SMS_HTTP_TOKEN:
        headers['Authorization'] = f'Bearer {settings.SMS_HTTP_TOKEN}'
    elif settings.SMS_HTTP_USERNAME:
        pair = f'{settings.SMS_HTTP_USERNAME}:{settings.SMS_HTTP_PASSWORD}'.encode()
        headers['Authorization'] = 'Basic ' + base64.b64encode(pair).decode()
    kwargs = {'headers': headers, 'timeout': settings.SMS_HTTP_TIMEOUT,
              'verify': settings.SMS_HTTP_VERIFY_TLS, 'allow_redirects': False}
    enc = settings.SMS_HTTP_ENCODING
    if settings.SMS_HTTP_METHOD == 'GET' or enc == 'query':
        kwargs['params'] = fields
    elif enc == 'form':
        kwargs['data'] = fields
    else:
        kwargs['json'] = fields
    try:
        resp = requests.request(settings.SMS_HTTP_METHOD, settings.SMS_HTTP_URL, **kwargs)
    except requests.RequestException as exc:
        logger.warning('sms gateway unreachable: %s', exc.__class__.__name__)
        return False, 'The SMS gateway could not be reached.'
    ok = 200 <= resp.status_code < 300
    if ok and settings.SMS_HTTP_SUCCESS_TEXT:
        ok = settings.SMS_HTTP_SUCCESS_TEXT in (resp.text or '')
    if not ok:
        logger.warning('sms gateway refused: %s %s', resp.status_code, (resp.text or '')[:200])
        return False, f'The SMS gateway answered {resp.status_code}.'
    return True, 'Sent.'


def send_sms(canonical, text):
    """(sent, message) for one SMS to a canonical 977... number."""
    backend = settings.SMS_BACKEND
    if backend == 'off':
        return False, 'Sending SMS is switched off.'
    if backend == 'console':
        logger.warning('SMS (console, not sent) to %s: %s', canonical, text)
        return True, 'Written to the server log (no SMS gateway is set up).'
    if backend in ('http', 'ntc'):
        return _send_http(canonical, text)
    return False, f'Unknown SMS_BACKEND "{backend}".'
