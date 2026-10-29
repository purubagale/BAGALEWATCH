"""OSS diagnostics (KPI) of a complaint (2026-10-29): the network KPIs of
the sites related to it, for Site related analysis on the Problem Dashboard.

    GET /api/v2/problem-reports/<id>/oss-kpi/?radius_km=3

Related sites, in this order and without repeats:
  complaint  the site that served the report, else the nearest site
  served     sites that served phone or drive-test readings within 1 km of
             the spot (phones: 3 days either side of the problem; drive
             tests: the last year), busiest first
  nearby     the nearest sites within the radius
For each, the busiest cell around the problem time (`cell_kpi.load_at`) and
the week up to the problem day from the busy-hour and whole-day rows: busy
days, worst availability, highest drop rates, lowest speed per user. Sites
are masts, so nothing personal is shown.
"""
from datetime import datetime, time, timedelta

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.db.models import Count, Max
from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from .cell_kpi import BUSY_PRB, QUIET_PRB, load_at
from .collection import NEPAL_TZ
from .models import CellKpi, CellKpiSourceSettings, DriveTestSample, ProblemReport, Sector, Site, TelemetrySample
from .problem_report import CanUseProblemDashboard
from .problem_sites import _bearing

RADII_KM = (1, 2, 3, 5)
SERVED_RADIUS_KM = 1
SERVED_DAYS = 3
SERVED_MAX = 5
NEARBY_MAX = 8
WEEK_DAYS = 7
OUTAGE_AVAILABILITY = 99.0   # below this on any day the site was partly down
NEAR_BUSY_PRB = BUSY_PRB - 10


def _r(v, n=1):
    return round(v, n) if v is not None else None


def _served(report):
    """[(site_id, readings)] of sites serving readings near the spot."""
    point = Point(report.lng, report.lat, srid=4326)
    near = D(km=SERVED_RADIUS_KM)
    start = report.happened_at - timedelta(days=SERVED_DAYS)
    end = report.happened_at + timedelta(days=SERVED_DAYS)
    counts = {}
    phones = (TelemetrySample.objects.filter(location__dwithin=(point, near), ts__gte=start, ts__lte=end,
                                             received_at__gte=start)
              .exclude(serving_site_id='').exclude(serving_site_id__isnull=True)
              .values('serving_site_id').annotate(n=Count('id')))
    for row in phones:
        counts[row['serving_site_id']] = counts.get(row['serving_site_id'], 0) + row['n']
    drives = (DriveTestSample.objects.filter(location__dwithin=(point, near),
                                             session__date__gte=(report.happened_at - timedelta(days=365)).date())
              .exclude(serving_site_id='').exclude(serving_site_id__isnull=True)
              .values('serving_site_id').annotate(n=Count('id')))
    for row in drives:
        counts[row['serving_site_id']] = counts.get(row['serving_site_id'], 0) + row['n']
    return sorted(counts.items(), key=lambda kv: -kv[1])[:SERVED_MAX]


def related_sites(report, radius_km):
    """[{'site_id', 'roles', 'why', 'readings'}] in the order described above."""
    point = Point(report.lng, report.lat, srid=4326)
    out, seen = [], {}

    def add(site_id, role, why, readings=None):
        if not site_id:
            return
        if site_id in seen:
            entry = seen[site_id]
            if role not in entry['roles']:
                entry['roles'].append(role)
            if readings and not entry['readings']:
                entry['readings'] = readings
            return
        entry = {'site_id': site_id, 'roles': [role], 'why': why, 'readings': readings}
        seen[site_id] = entry
        out.append(entry)

    if report.site_id:
        add(report.site_id, 'complaint', 'served the report')
    else:
        nearest = (Site.objects.filter(location__dwithin=(point, D(km=10))).annotate(d=Distance('location', point))
                   .order_by('d').values_list('pk', flat=True).first())
        add(nearest, 'complaint', 'nearest site')
    for site_id, n in _served(report):
        add(site_id, 'served', 'served readings near the spot', n)
    for site_id in (Site.objects.filter(location__dwithin=(point, D(km=radius_km)))
                    .annotate(d=Distance('location', point)).order_by('d').values_list('pk', flat=True)[:NEARBY_MAX]):
        add(site_id, 'nearby', f'within {radius_km:g} km')
    return out


def _week(site_ids, day):
    """{site_id: week summary} from the busy-hour and whole-day rows of the
    `WEEK_DAYS` days up to `day`."""
    since = day - timedelta(days=WEEK_DAYS - 1)
    per = {}
    for r in (CellKpi.objects.filter(site_id__in=site_ids, date__gte=since, date__lte=day,
                                     level__in=(CellKpi.LEVEL_BBH, CellKpi.LEVEL_DAY))
              .values('site_id', 'date', 'level', 'cell_name', 'prb_dl', 'thr_dl_user', 'availability',
                      'service_drop', 'volte_drop')):
        p = per.setdefault(r['site_id'], {'busy_by_day': {}, 'cells': set(), 'dates': set(), 'avail': None,
                                          'avail_cell': None, 'drop': None, 'volte_drop': None, 'thr': None,
                                          'thr_cell': None})
        p['cells'].add(r['cell_name'])
        p['dates'].add(r['date'])
        if r['level'] == CellKpi.LEVEL_BBH and r['prb_dl'] is not None:
            p['busy_by_day'][r['date']] = max(p['busy_by_day'].get(r['date'], 0), r['prb_dl'])
            if r['thr_dl_user'] is not None and (p['thr'] is None or r['thr_dl_user'] < p['thr']):
                p['thr'], p['thr_cell'] = r['thr_dl_user'], r['cell_name']
        if r['availability'] is not None and (p['avail'] is None or r['availability'] < p['avail']):
            p['avail'], p['avail_cell'] = r['availability'], r['cell_name']
        for key, field in (('drop', 'service_drop'), ('volte_drop', 'volte_drop')):
            if r[field] is not None and (p[key] is None or r[field] > p[key]):
                p[key] = r[field]
    out = {}
    for site, p in per.items():
        busy = p['busy_by_day']
        out[site] = {
            'days': len(p['dates']), 'cells': len(p['cells']),
            'prb_dl_max': _r(max(busy.values())) if busy else None,
            'busy_days': sum(1 for v in busy.values() if v >= BUSY_PRB),
            'availability_min': _r(p['avail'], 2), 'availability_cell': p['avail_cell'],
            'service_drop_max': _r(p['drop'], 2), 'volte_drop_max': _r(p['volte_drop'], 2),
            'thr_dl_user_min': _r(p['thr']), 'thr_cell': p['thr_cell'],
        }
    return out


def _verdict(at, week, when='around the problem time'):
    """('outage'|'busy'|'near'|'quiet'|'ok'|'none', plain words)."""
    if not at and not week:
        return 'none', 'No network KPIs for this site around the problem time.'
    week = week or {}
    if week.get('availability_min') is not None and week['availability_min'] < OUTAGE_AVAILABILITY:
        return 'outage', f"Partly down that week: availability fell to {week['availability_min']}% on {week['availability_cell']}."
    prb = (at or {}).get('prb_dl')
    if (at or {}).get('busy') or week.get('busy_days', 0) >= 3:
        days = week.get('busy_days', 0)
        return 'busy', (f'Busy: DL PRB {prb}% {when}' if prb is not None else 'Busy') + (
            f', and busy on {days} of the {week.get("days", 0)} days.' if days else '.')
    if prb is not None and prb >= NEAR_BUSY_PRB:
        return 'near', f'Close to busy: DL PRB {prb}% {when}.'
    if prb is not None and prb < QUIET_PRB:
        return 'quiet', f'Room to spare: DL PRB {prb}% {when}.'
    return 'ok', 'Load and availability in the normal range.'


class ProblemOssKpiView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport, pk=pk)
        try:
            radius = float(request.query_params.get('radius_km', 3))
        except (TypeError, ValueError):
            radius = 3
        radius = min(RADII_KM, key=lambda r: abs(r - radius))
        related = related_sites(report, radius)
        ids = [s['site_id'] for s in related]
        point = Point(report.lng, report.lat, srid=4326)
        sites = {s.pk: s for s in Site.objects.filter(pk__in=ids).annotate(d=Distance('location', point))}
        has_4g = set(Sector.objects.filter(site_id__in=ids, tech__iexact='4G').values_list('site_id', flat=True))
        day = report.happened_at.astimezone(NEPAL_TZ).date()
        week = _week(ids, day)
        row = CellKpiSourceSettings.load()
        # A site with no figures that week (the complaint is newer than the
        # newest import, or older than what is kept): its newest week instead.
        newest = dict(CellKpi.objects.filter(site_id__in=ids).values('site_id').annotate(d=Max('date'))
                      .values_list('site_id', 'd'))
        out = []
        for entry in related:
            s = sites.get(entry['site_id'])
            at = load_at(report.happened_at, site_id=entry['site_id'])
            w = week.get(entry['site_id'])
            figures_from = None
            if not at and not w and newest.get(entry['site_id']):
                d = newest[entry['site_id']]
                at = load_at(datetime.combine(d, time(20), tzinfo=NEPAL_TZ), site_id=entry['site_id'])
                w = _week([entry['site_id']], d).get(entry['site_id'])
                figures_from = d.isoformat()
            verdict, words = _verdict(at, w, f'on {d.strftime("%d %b")}, its newest figures' if figures_from
                                      else 'around the problem time')
            out.append({
                **entry,
                'name': s.name if s else None, 'district': s.district if s else None,
                'distance_m': round(s.d.m) if s and s.d is not None else None,
                'bearing_deg': _bearing(report.lat, report.lng, s.lat, s.lng) if s and s.lat is not None else None,
                'has_4g': entry['site_id'] in has_4g,
                'at_problem': at, 'week': w, 'verdict': verdict, 'verdict_text': words,
                'figures_from': figures_from,
            })
        return Response({
            'configured': bool(row and row.backend != CellKpiSourceSettings.BACKEND_OFF),
            'problem_date': day.isoformat(), 'week_from': (day - timedelta(days=WEEK_DAYS - 1)).isoformat(),
            'radius_km': radius, 'radii_km': RADII_KM, 'busy_prb': BUSY_PRB,
            'newest_date': (CellKpi.objects.order_by('-date').values_list('date', flat=True).first() or None),
            'sites': out,
        })
