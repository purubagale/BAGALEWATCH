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

from .models import Site
from .views import IsAdminOrSuperadmin

logger = logging.getLogger(__name__)

CACHE_KEY = 'alarms:active:v1'
MAX_PAGES = 40
REFRESH_PER_USER_PER_MIN = 6
SEVERITY_ORDER = {'Critical': 0, 'Major': 1, 'Minor': 2, 'Warning': 3}
_SITE_IN_NAME = re.compile(r'(?<![A-Z])(MWDR|FWDR|KTM|EDR|CDR|WDR)0*(\d{1,4})(?!\d)', re.I)


class AlarmSourceError(Exception):
    pass


def configured():
    return bool(settings.ALARM_API_URL)


def _site_of(alarm):
    site = str(alarm.get('siteId') or '').strip().upper()
    if site:
        return site
    m = _SITE_IN_NAME.search(str(alarm.get('deviceName') or ''))
    return f'{m.group(1).upper()}{int(m.group(2)):03d}' if m else ''


def _fetch():
    headers = {'Accept': 'application/json'}
    if settings.ALARM_API_TOKEN:
        headers['Authorization'] = f'Bearer {settings.ALARM_API_TOKEN}'
    alarms, offset, total = [], 0, None
    for _ in range(MAX_PAGES):
        try:
            resp = requests.get(settings.ALARM_API_URL, headers=headers, timeout=15,
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
    data = _fetch()
    cache.set(CACHE_KEY, data, timeout=max(10, settings.ALARM_CACHE_SECONDS))
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


class AlarmSummaryView(APIView):
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        base = {'configured': configured(), 'url': settings.ALARM_API_URL or None,
                'cache_seconds': settings.ALARM_CACHE_SECONDS}
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
