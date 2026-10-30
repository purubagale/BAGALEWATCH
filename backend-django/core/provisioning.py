"""What the network has provisioned for a number, from NTC's ticketing system
(UTS), next to what the phone measured (2026-10-16).

UTS holds billing, HSS and SPR data DT-WATCH never sees: whether 4G and VoLTE
are provisioned, the SIM type, roaming, the plan, and the device's supported
bands. With it the Subscriber Profile can say "the phone sits on 3G because
4G is not provisioned" instead of guessing coverage.

The UTS team's API is not known yet, so the call is configured entirely in
.env (PROVISIONING_* in settings.py), like the SMS gateway: address, method,
headers and a map from our field names to paths in UTS's answer. Off by
default; `demo` returns made-up data so the screens can be tried.

Superadmin only, a reason is needed, and every lookup is logged. Answers are
cached for PROVISIONING_CACHE_SECONDS. The IMEI is masked before it leaves
the server, as on the rest of the profile.
"""
import json
import logging

import requests
from django.conf import settings
from django.core.cache import cache
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .rescue import _clean_msisdn
from .views import IsAdminOrSuperadmin

log = logging.getLogger(__name__)

AUDIT_ACTION = 'SUBSCRIBER_PROFILE.PROVISIONING'
FIELDS = ('subscriber_name', 'billing_type', 'status', 'lte_provisioned', 'volte_provisioned', 'sim_type', 'usim',
          'roaming', 'plan_name', 'data_used_gb', 'data_total_gb', 'device_brand', 'device_model', 'imei',
          'supported_bands', 'location_history', 'usage_daily', 'network_split')
# Which system each field comes from (2026-10-19): the BI system (usage and
# where it happened) or OSS & Core (HSS/SPR provisioning, MME/MSC/PGW state,
# the device). The profile shows them as two cards.
BI_FIELDS = ('plan_name', 'data_used_gb', 'data_total_gb', 'usage_daily', 'network_split', 'location_history')
# The cells the network saw the customer on (UTS "cell sites visited"): a
# list of rows, shown as they come. Location, so only while an emergency is
# declared (the user's decision, 2026-10-19).
LOCATION_FIELDS = ('location_history',)
BOOL_FIELDS = ('lte_provisioned', 'volte_provisioned', 'usim', 'roaming')

# The bands NTC runs (2026-10-16, as UTS lists them): the phone must support
# these to use each layer. Keys are the normalised tokens below.
NTC_BANDS = [
    {'token': 'GSM900', 'tech': '2G', 'label': 'GSM 900', 'use': 'Voice, SMS, coverage'},
    {'token': 'GSM1800', 'tech': '2G', 'label': 'GSM 1800', 'use': 'Voice, SMS, capacity'},
    {'token': 'WCDMA1', 'tech': '3G', 'label': 'WCDMA Band 1 (2100)', 'use': '3G voice and data'},
    {'token': 'B3', 'tech': '4G', 'label': 'LTE Band 3 (1800)', 'use': 'Main 4G capacity layer'},
    {'token': 'B20', 'tech': '4G', 'label': 'LTE Band 20 (800)', 'use': 'Rural and deep-indoor 4G'},
    {'token': 'n78', 'tech': '5G', 'label': 'NR n78 (3500)', 'use': '5G trial'},
]


def band_token(text):
    """One supported-band entry from UTS, in any common spelling, as a token
    comparable with NTC_BANDS: 'B3', 'LTE Band 3', 'FDD B3' -> 'B3';
    'n78', 'NR n78' -> 'n78'; 'GSM 900', 'GSM900' -> 'GSM900';
    'WCDMA FDD Band 1', 'UMTS B1' -> 'WCDMA1'."""
    import re
    t = str(text or '').strip()
    u = t.upper().replace('-', ' ')
    m = re.search(r'\bN\s*(\d{1,3})\b', u)
    if m and ('NR' in u or u.startswith('N')):
        return f'n{int(m.group(1))}'
    m = re.search(r'GSM\s*(\d{3,4})', u)
    if m:
        return f'GSM{m.group(1)}'
    m = re.search(r'(?:BAND|B)\s*(\d{1,2})\b', u)
    if m and ('WCDMA' in u or 'UMTS' in u or 'HSPA' in u):
        return f'WCDMA{int(m.group(1))}'
    if m:
        return f'B{int(m.group(1))}'
    return t


def _mask(imei):
    imei = str(imei or '').strip()
    return ('•' * (len(imei) - 4) + imei[-4:]) if len(imei) > 4 else (imei or None)


def _dig(data, path):
    for part in str(path).split('.'):
        if isinstance(data, list) and part.isdigit():
            data = data[int(part)] if int(part) < len(data) else None
        elif isinstance(data, dict):
            data = data.get(part)
        else:
            return None
    return data


def _as_bool(v):
    if isinstance(v, bool) or v is None:
        return v
    s = str(v).strip().lower()
    if s in ('1', 'true', 'yes', 'y', 'active', 'enabled', 'provisioned', 'on'):
        return True
    if s in ('0', 'false', 'no', 'n', 'inactive', 'disabled', 'not provisioned', 'off', ''):
        return False
    return None


def _demo(canonical):
    """Made-up provisioning, for trying the screens before UTS is linked."""
    odd = int(canonical[-1]) % 2 == 1
    return {
        'subscriber_name': 'Demo Subscriber', 'billing_type': 'Postpaid', 'status': 'Active',
        'lte_provisioned': not odd, 'volte_provisioned': not odd, 'sim_type': 'Standard SIM' if odd else '4G USIM',
        'usim': not odd, 'roaming': False, 'plan_name': '20 GB data pack', 'data_used_gb': 7.4, 'data_total_gb': 20.5,
        'device_brand': 'Samsung', 'device_model': 'Galaxy A52s 5G (SM-A528B)', 'imei': '359922294527261',
        'supported_bands': ['B1', 'B3', 'B5', 'B7', 'B8', 'B20', 'B28', 'B40', 'WCDMA FDD Band 1', 'WCDMA FDD Band 8',
                            'GSM 900', 'GSM 1800', 'n1', 'n3', 'n28', 'n78'],
        'location_history': [
            {'cell': 'DEMO001_SITEA-L3', 'ci': 475137, 'lac': 10429, 'tech': '4G', 'location': 'Kathmandu',
             'data_mb': 141.8, 'voice_min': None, 'events': 1},
            {'cell': 'DEMO002_SITEB-L3', 'ci': 279811, 'lac': 10416, 'tech': '4G', 'location': 'Kathmandu',
             'data_mb': 93.5, 'voice_min': None, 'events': 1},
            {'cell': 'DEMO003_SITEC_P2', 'ci': 21224, 'lac': 10206, 'tech': '3G', 'location': 'Kathmandu',
             'data_mb': 1.1, 'voice_min': 1.0, 'events': 2},
        ],
        'usage_daily': [
            {'day': f'2026-10-{d:02d}', 'data_mb': round(80 + 37 * ((d * 7) % 5), 1), 'voice_min': (d * 3) % 11,
             'sms': d % 4}
            for d in range(5, 19)
        ],
        'network_split': {'4G': 71.0, '3G': 18.5, '2G': 10.5} if not odd else {'4G': 12.0, '3G': 41.0, '2G': 47.0},
    }


def _http(canonical):
    local = canonical[3:] if canonical.startswith('977') else canonical
    fill = lambda s: s.replace('{msisdn}', canonical).replace('{msisdn_local}', local)
    headers = {'Accept': 'application/json'}
    headers.update({k: fill(str(v)) for k, v in json.loads(settings.PROVISIONING_HTTP_HEADERS or '{}').items()})
    if settings.PROVISIONING_HTTP_TOKEN:
        headers['Authorization'] = f'Bearer {settings.PROVISIONING_HTTP_TOKEN}'
    kwargs = {'headers': headers, 'timeout': settings.PROVISIONING_HTTP_TIMEOUT,
              'verify': settings.PROVISIONING_HTTP_VERIFY_TLS, 'allow_redirects': False}
    if settings.PROVISIONING_HTTP_METHOD == 'POST' and settings.PROVISIONING_HTTP_BODY:
        kwargs['json'] = json.loads(fill(settings.PROVISIONING_HTTP_BODY))
    resp = requests.request(settings.PROVISIONING_HTTP_METHOD, fill(settings.PROVISIONING_HTTP_URL), **kwargs)
    resp.raise_for_status()
    answer = resp.json()
    mapping = json.loads(settings.PROVISIONING_FIELDS or '{}')
    return {name: _dig(answer, path) for name, path in mapping.items() if name in FIELDS}


def lookup(canonical):
    """(data, error) for one number; data is None when off or failed."""
    backend = settings.PROVISIONING_BACKEND
    if backend == 'off':
        return None, None
    key = f'provisioning:{canonical}'
    hit = cache.get(key)
    if hit is not None:
        return hit, None
    try:
        if backend == 'demo':
            raw = _demo(canonical)
        elif backend == 'http' and settings.PROVISIONING_HTTP_URL:
            raw = _http(canonical)
        else:
            return None, 'The provisioning source is not set up.'
    except (requests.RequestException, ValueError) as exc:
        log.warning('provisioning lookup failed: %s', exc.__class__.__name__)
        return None, 'The ticketing system did not answer. Try again later.'
    data = {name: raw.get(name) for name in FIELDS}
    for name in BOOL_FIELDS:
        data[name] = _as_bool(data[name])
    data['imei'] = _mask(data['imei'])
    # Rows of plain values only, at most 200, whatever shape the source sends.
    rows = data['location_history'] if isinstance(data['location_history'], list) else []
    data['location_history'] = [
        {str(k)[:40]: v for k, v in r.items() if isinstance(v, (str, int, float, bool)) or v is None}
        for r in rows[:200] if isinstance(r, dict)
    ]
    days = data['usage_daily'] if isinstance(data['usage_daily'], list) else []
    data['usage_daily'] = [
        {'day': str(r.get('day') or r.get('date') or '')[:10],
         **{k: (float(r[k]) if isinstance(r.get(k), (int, float)) else None) for k in ('data_mb', 'voice_min', 'sms')}}
        for r in days[:120] if isinstance(r, dict)
    ]
    split = data['network_split'] if isinstance(data['network_split'], dict) else {}
    data['network_split'] = {str(k)[:8]: float(v) for k, v in split.items() if isinstance(v, (int, float))}
    bands = data['supported_bands'] or []
    if isinstance(bands, str):
        bands = [b for b in bands.replace(';', ',').split(',') if b.strip()]
    data['supported_bands'] = [str(b).strip() for b in bands]
    tokens = {band_token(b) for b in data['supported_bands']}
    data['ntc_bands'] = [dict(b, supported=(b['token'] in tokens) if data['supported_bands'] else None) for b in NTC_BANDS]
    data['source'] = 'demo' if backend == 'demo' else 'uts'
    cache.set(key, data, settings.PROVISIONING_CACHE_SECONDS)
    return data, None


def status_summary():
    """For the Security page: whether a source is set (never a secret)."""
    backend = settings.PROVISIONING_BACKEND
    return {
        'backend': backend,
        'configured': backend == 'demo' or (backend == 'http' and bool(settings.PROVISIONING_HTTP_URL)),
        'address_host': (requests.utils.urlparse(settings.PROVISIONING_HTTP_URL).hostname
                         if settings.PROVISIONING_HTTP_URL else None),
    }


class SubscriberProvisioningView(APIView):
    """`GET /api/v2/subscriber-profile/provisioning/?msisdn=&reason=`."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        canonical = _clean_msisdn(request.query_params.get('msisdn'))
        reason = (request.query_params.get('reason') or '').strip()[:200]
        if not canonical or not reason:
            return Response({'detail': 'A valid number and a reference are needed.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if settings.PROVISIONING_BACKEND == 'off':
            return Response({'enabled': False, 'data': None, 'error': None, 'ntc_bands': NTC_BANDS})
        log_audit_event(request, AUDIT_ACTION, resource='subscriber_profile', resource_id=canonical, detail=reason)
        data, error = lookup(canonical)
        # Location history is for superadmin only (2026-10-30, the user's
        # rule; it replaces the 2026-10-27 "all staff" decision).
        shown = request.user.role == 'superadmin'
        if data is not None and not shown:
            data = {**data, 'location_history': []}
        return Response({'enabled': True, 'data': data, 'error': error, 'ntc_bands': NTC_BANDS,
                         'location_shown': shown})
