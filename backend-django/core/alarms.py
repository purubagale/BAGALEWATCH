"""Active alarms from NTC's alarm middleware (2026-10-26).

The middleware answers `GET <ALARM_API_URL>?limit=&offset=` with
`{"success": true, "data": {"alarms": [...], "pagination": {"total", "limit",
"offset", "hasMore"}}}`; each alarm has id, csn, siteId, severity,
alarmType, occurTime, deviceName and neType. It has no site filter, so the
server reads every page, keeps the whole list in the cache for
ALARM_CACHE_SECONDS (one fetch serves every user) and filters by site
itself. Nothing is written to the database.

    GET /api/v2/alarms/active/?site=KTM529   one site's alarms (signed-in users)
    GET /api/v2/alarms/summary/              totals for Live Site Sync (admin)
    either with refresh=1                    fetch now instead of the cache

A record with no siteId takes the site from its device name
("HTDHBSC08-CDR823_..." -> CDR823). With ALARM_API_URL unset everything
answers `configured: false` and nothing is called.
"""
import logging
import re
import time
from collections import Counter

import requests
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .mfa import decrypt_secret, encrypt_secret
from .models import AlarmSourceSettings, Site
from .views import IsAdminOrSuperadmin

logger = logging.getLogger(__name__)

CACHE_KEY = 'alarms:active:v1'
MAX_PAGES = 40
REFRESH_PER_USER_PER_MIN = 6
SEVERITY_ORDER = {'Critical': 0, 'Major': 1, 'Minor': 2, 'Warning': 3}
_SITE_IN_NAME = re.compile(r'(?<![A-Z])(MWDR|FWDR|KTM|EDR|CDR|WDR)0*(\d{1,4})(?!\d)', re.I)


class AlarmSourceError(Exception):
    pass


def source():
    """The connection in use: the Live Site Sync page's settings when an
    address is saved there (2026-10-26), else ALARM_API_* from .env. Returns
    a dict with url, token, scheme, cache_seconds, enabled and origin."""
    row = AlarmSourceSettings.load()
    if row and row.api_url:
        token = ''
        if row.api_key_encrypted:
            try:
                token = decrypt_secret(row.api_key_encrypted)
            except Exception:
                logger.warning('Stored alarm key could not be decrypted (SECRET_KEY changed?)')
        return {'url': row.api_url, 'token': token, 'scheme': row.auth_scheme or 'Bearer',
                'cache_seconds': row.cache_seconds or 60, 'enabled': row.enabled, 'origin': 'page'}
    return {'url': settings.ALARM_API_URL, 'token': settings.ALARM_API_TOKEN, 'scheme': 'Bearer',
            'cache_seconds': settings.ALARM_CACHE_SECONDS, 'enabled': bool(settings.ALARM_API_URL),
            'origin': 'env' if settings.ALARM_API_URL else 'none'}


def configured():
    s = source()
    return bool(s['url']) and s['enabled']


def _site_of(alarm):
    site = str(alarm.get('siteId') or '').strip().upper()
    if site:
        return site
    m = _SITE_IN_NAME.search(str(alarm.get('deviceName') or ''))
    return f'{m.group(1).upper()}{int(m.group(2)):03d}' if m else ''


def _fetch(src=None):
    src = src or source()
    headers = {'Accept': 'application/json'}
    if src['token']:
        headers['Authorization'] = f"{src['scheme']} {src['token']}"
    alarms, offset, total = [], 0, None
    for _ in range(MAX_PAGES):
        try:
            resp = requests.get(src['url'], headers=headers, timeout=15,
                                params={'limit': settings.ALARM_PAGE_SIZE, 'offset': offset})
        except requests.RequestException as exc:
            raise AlarmSourceError(f'The alarm service could not be reached ({exc.__class__.__name__}).') from exc
        if resp.status_code in (401, 403):
            raise AlarmSourceError('The alarm service refused the access key.')
        if resp.status_code != 200:
            raise AlarmSourceError(f'The alarm service answered HTTP {resp.status_code}.')
        try:
            data = (resp.json() or {}).get('data') or {}
        except ValueError as exc:
            raise AlarmSourceError('The alarm service did not answer with JSON.') from exc
        page = data.get('alarms') or []
        alarms.extend(page)
        pag = data.get('pagination') or {}
        try:
            total = int(pag.get('total')) if pag.get('total') is not None else total
        except (TypeError, ValueError):
            pass
        if not pag.get('hasMore') or not page:
            break
        offset += len(page)
    rows = []
    for a in alarms:
        rows.append({
            'id': a.get('id'), 'csn': a.get('csn'), 'site_id': _site_of(a),
            'severity': a.get('severity') or '', 'alarm': a.get('alarmType') or '',
            'device': a.get('deviceName') or '', 'ne_type': a.get('neType') or '',
            'occurred_at': a.get('occurTime'),
        })
    # Most severe first, newest first within a severity.
    rows.sort(key=lambda r: r['occurred_at'] or '', reverse=True)
    rows.sort(key=lambda r: SEVERITY_ORDER.get(r['severity'], 9))
    return {'alarms': rows, 'total': total if total is not None else len(rows),
            'fetched_at': timezone.now().isoformat()}


def active_alarms(refresh=False):
    """The whole active list, from the cache unless `refresh`. Raises AlarmSourceError."""
    if not refresh:
        hit = cache.get(CACHE_KEY)
        if hit is not None:
            return hit
    src = source()
    data = _fetch(src)
    cache.set(CACHE_KEY, data, timeout=max(10, src['cache_seconds']))
    return data


def site_alarm_counts():
    """{site_id: count} from the cached list, or {} when off or unreachable.
    For pages that only want a number next to a site."""
    if not configured():
        return {}
    try:
        data = active_alarms()
    except AlarmSourceError:
        return {}
    return Counter(r['site_id'] for r in data['alarms'] if r['site_id'])


def _refresh_allowed(request):
    if request.query_params.get('refresh') != '1':
        return False
    bucket = f'alarms:refresh:{request.user.pk}:{int(time.time() // 60)}'
    cache.add(bucket, 0, timeout=120)
    try:
        return cache.incr(bucket) <= REFRESH_PER_USER_PER_MIN
    except ValueError:
        return True


class SiteActiveAlarmsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        site = str(request.query_params.get('site') or '').strip().upper()
        if not configured():
            return Response({'configured': False, 'site': site, 'alarms': []})
        try:
            data = active_alarms(refresh=_refresh_allowed(request))
        except AlarmSourceError as exc:
            return Response({'configured': True, 'site': site, 'alarms': [], 'error': str(exc)}, status=502)
        rows = [r for r in data['alarms'] if r['site_id'] == site] if site else []
        return Response({'configured': True, 'site': site, 'alarms': rows, 'fetched_at': data['fetched_at']})


class SitesActiveAlarmsView(APIView):
    """`GET alarms/sites/?sites=A,B,C[&refresh=1]` (2026-10-28): the active
    alarms of up to 200 sites at once, for the alarm column of Sites
    Topology, plus how many sites have one at all."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        wanted = {s.strip().upper() for s in str(request.query_params.get('sites') or '').split(',') if s.strip()}
        wanted = set(sorted(wanted)[:200])
        if not configured():
            return Response({'configured': False, 'by_site': {}, 'sites_with_alarms': 0})
        try:
            data = active_alarms(refresh=_refresh_allowed(request))
        except AlarmSourceError as exc:
            return Response({'configured': True, 'by_site': {}, 'sites_with_alarms': 0, 'error': str(exc)}, status=502)
        by_site = {}
        for r in data['alarms']:
            if r['site_id'] in wanted:
                by_site.setdefault(r['site_id'], []).append(r)
        return Response({
            'configured': True, 'fetched_at': data['fetched_at'], 'by_site': by_site,
            'sites_with_alarms': len({r['site_id'] for r in data['alarms'] if r['site_id']}),
            'total': data['total'],
        })


class AlarmSummaryView(APIView):
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        src = source()
        base = {'configured': configured(), 'url': src['url'] or None, 'origin': src['origin'],
                'cache_seconds': src['cache_seconds']}
        if not configured():
            return Response(base)
        t = time.monotonic()
        try:
            data = active_alarms(refresh=_refresh_allowed(request))
        except AlarmSourceError as exc:
            return Response({**base, 'error': str(exc)}, status=502)
        rows = data['alarms']
        by_site = Counter(r['site_id'] for r in rows if r['site_id'])
        names = dict(Site.objects.filter(pk__in=list(by_site)).values_list('pk', 'name'))
        return Response({
            **base,
            'fetched_at': data['fetched_at'], 'took_ms': round((time.monotonic() - t) * 1000),
            'total': data['total'], 'received': len(rows),
            'by_severity': Counter(r['severity'] or 'Unknown' for r in rows).most_common(),
            'by_type': Counter(r['alarm'] or 'Unknown' for r in rows).most_common(15),
            'by_ne_type': Counter(r['ne_type'] or 'Unknown' for r in rows).most_common(),
            'sites': len(by_site),
            'unknown_sites': sum(1 for s in by_site if s not in names),
            'no_site': sum(1 for r in rows if not r['site_id']),
            'top_sites': [{'site_id': s, 'name': names.get(s), 'count': n, 'known': s in names}
                          for s, n in by_site.most_common(25)],
        })


def _source_view(row):
    src = source()
    return {
        'api_url': row.api_url if row else '', 'auth_scheme': row.auth_scheme if row else 'Bearer',
        'has_key': bool(row and row.api_key_encrypted), 'cache_seconds': row.cache_seconds if row else src['cache_seconds'],
        'enabled': row.enabled if row else True,
        'origin': src['origin'],  # page / env / none: which connection is in use now
        'env_url': settings.ALARM_API_URL or None,
        'updated_by': (row.updated_by.username if row and row.updated_by else None),
        'updated_at': row.updated_at if row else None,
    }


class AlarmSourceView(APIView):
    """`GET/PUT /api/v2/alarms/source/` -- the alarm connection set on the Live
    Site Sync page (2026-10-26). Admin and superadmin, like the site sources.
    PUT: api_url (http or https; empty = use .env), api_key (blank keeps the
    saved key; clear_key=true removes it), auth_scheme Bearer|Token,
    cache_seconds 15-900, enabled. The key is never sent back."""
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        return Response(_source_view(AlarmSourceSettings.load()))

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        row = AlarmSourceSettings.load() or AlarmSourceSettings()
        url = str(data.get('api_url', row.api_url) or '').strip()
        if url and not (url.startswith('http://') or url.startswith('https://')):
            return Response({'detail': 'The address must start with http:// or https://.'}, status=400)
        scheme = str(data.get('auth_scheme', row.auth_scheme) or 'Bearer')
        if scheme not in dict(AlarmSourceSettings.AUTH_CHOICES):
            return Response({'detail': 'Unknown header type.'}, status=400)
        try:
            cache_s = int(data.get('cache_seconds', row.cache_seconds or 60))
        except (TypeError, ValueError):
            cache_s = 60
        row.api_url, row.auth_scheme = url[:500], scheme
        row.cache_seconds = max(15, min(cache_s, 900))
        row.enabled = bool(data.get('enabled', row.enabled))
        key = str(data.get('api_key') or '').strip()
        if data.get('clear_key'):
            row.api_key_encrypted = ''
        elif key:
            row.api_key_encrypted = encrypt_secret(key)
        row.updated_by = request.user
        row.save()
        cache.delete(CACHE_KEY)  # the next look asks the (new) source
        log_audit_event(request, 'ALARM_SOURCE.UPDATED', resource='alarm_source', resource_id='1',
                        detail=f'url={url or "(env)"} scheme={scheme} key={"changed" if key else ("cleared" if data.get("clear_key") else "kept")} '
                               f'enabled={row.enabled}')
        return Response(_source_view(row))
