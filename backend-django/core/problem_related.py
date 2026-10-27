"""Everything stored that relates to one complaint (2026-10-26).

The check (core/problem_report.py) looks only at other phones and drive
tests within 500 m around the time of the problem. A complaint can still
have plenty behind it elsewhere: the customer's own phone readings taken at
other places or dates, the readings the complaint's site served, drive tests
a little further out. This gathers them, for a time range the engineer picks.

    GET /api/v2/problem-reports/<id>/related/
        ?range=latest|around|7d|30d|90d|all|custom
        &hours=24            (around: the complaint time plus or minus)
        &from=&to=           (custom: dates or date-times)
        &radius_km=1         (area: 0.5, 1, 2 or 5)

Three scopes, each from phone telemetry and drive tests:

  customer  the readings of every phone tied to the complaint's number
            (same devices and rules as the Subscriber Network Diagnosis
            Dashboard), its speed tests, calls, sessions and other complaints.
            Sites served are always shown (2026-10-27: only the position is
            withheld); exact positions only while an emergency is declared,
            or inside a complaint window when that switch is on.
  site      the readings the complaint's site served (all phones, counts and
            averages only), its drive tests and its other complaints.
  area      phone and drive-test readings within the radius of the spot,
            and the complaints there. Other phones are never named.

`latest` takes the newest 300 phone readings of each scope and the newest
drive test. Users of the Problem Dashboard; a non-superadmin's look at a
complaint with a number is logged once an hour.
"""
import math
from datetime import datetime, time, timedelta

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.core.cache import cache
from django.db.models import Avg, Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .cqi import sample_cqi_fields
from .emergency import active_emergency
from .models import (
    CallContextSample, CollectionSession, DriveTestSample, ProblemReport, Site, TelemetrySample,
    TelemetrySpeedResult,
)
from .problem_report import CAUSE_LABELS, GOOD_DBM, WEAK_DBM, CanUseProblemDashboard, _TECH
from .subscriber_profile import complaint_windows, devices_of_number
from .telemetry import _scope_by_operator
from .telemetry_level import sample_level
from .telemetry_status import LABELS as STATUS_LABELS, status_of

RANGES = ('latest', 'around', '7d', '30d', '90d', 'all', 'custom')
AROUND_HOURS = (1, 3, 6, 24, 72, 168)
RADII_KM = (0.5, 1, 2, 5)
LATEST_ROWS = 300
MAX_ROWS = 20000          # phone readings summarised per scope
MAX_POINTS = 1500         # dots on a map per scope
SQUARE_DEG = 0.0005       # about 50 m: one dot per square, the weakest
_TELE_FIELDS = ('ts', 'received_at', 'service_state', 'cell_info_status', 'airplane_mode', 'sim_state', 'environment', 'network_type', 'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'rsrq_db', 'sinr_db', 'cqi',
                'serving_site_id', 'serving_sector', 'lat', 'lng', 'device_id', 'band', 'band_mhz')


LATE_SECONDS = 600        # a reading that reached the server more than 10 min after it was taken


def _status_key(r):
    return status_of(r['network_type'], r['lat'], r['service_state'], r['cell_info_status'],
                     r['airplane_mode'], r['sim_state'])


def status_label(r):
    return STATUS_LABELS[_status_key(r)]


def _round(v, digits=1):
    return None if v is None else round(v, digits)


def _mean(values):
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values), 1) if values else None


def _window(report, params):
    """(start, end, label) of the chosen range; None ends mean open."""
    kind = params.get('range') or 'latest'
    if kind not in RANGES:
        kind = 'latest'
    now = timezone.now()
    if kind == 'around':
        try:
            h = int(params.get('hours', 24))
        except (TypeError, ValueError):
            h = 24
        h = min(AROUND_HOURS, key=lambda x: abs(x - h))
        return kind, report.happened_at - timedelta(hours=h), report.happened_at + timedelta(hours=h), h
    if kind in ('7d', '30d', '90d'):
        return kind, now - timedelta(days=int(kind[:-1])), now, None
    if kind == 'custom':
        def when(raw, end):
            if not raw:
                return None
            dt = parse_datetime(raw)
            if dt is None:
                d = parse_date(raw)
                if d is None:
                    return None
                dt = datetime.combine(d, time.max if end else time.min)
            return dt if timezone.is_aware(dt) else timezone.make_aware(dt)
        return kind, when(params.get('from'), False), when(params.get('to'), True), None
    return kind, None, None, None      # latest, all


def _tele_range(qs, start, end):
    if start:
        # received_at is the partition key; a reading arrives after it is taken.
        qs = qs.filter(ts__gte=start, received_at__gte=start)
    if end:
        qs = qs.filter(ts__lte=end)
    return qs


def _dt_range(qs, start, end):
    if start:
        qs = qs.filter(session__date__gte=start.date())
    if end:
        qs = qs.filter(session__date__lte=end.date())
    return qs


def _quality(tech, level):
    if level is None or tech not in WEAK_DBM:
        return None
    return 'weak' if level < WEAK_DBM[tech] else 'good' if level >= GOOD_DBM[tech] else 'fair'


def _squares(points):
    """One dot per ~50 m square, the weakest level there, at most MAX_POINTS."""
    best = {}
    for p in points:
        key = (round(p['lat'] / SQUARE_DEG), round(p['lng'] / SQUARE_DEG), p['tech'])
        cur = best.get(key)
        if cur is None or (p['level'] is not None and (cur['level'] is None or p['level'] < cur['level'])):
            best[key] = p
    out = sorted(best.values(), key=lambda p: (p['level'] is None, p['level'] if p['level'] is not None else 0))
    return out[:MAX_POINTS]


def _telemetry(qs, kind, *, show_sites=True, positions=None):
    """Summary of phone readings. `positions(ts)` says whether a reading's
    place may be shown (None: always); `show_sites` whether the sites served
    are listed (else only counted)."""
    total = qs.count()
    if not total:
        return None
    limit = LATEST_ROWS if kind == 'latest' else MAX_ROWS
    rows = list(qs.order_by('-ts').values(*_TELE_FIELDS)[:limit])
    per_tech, sites, points, devices, delays = {}, {}, [], set(), []
    envs = {}
    for r in rows:
        envs[r['environment'] or ''] = envs.get(r['environment'] or '', 0) + 1
        # No network: say what it means (2026-10-26, core/telemetry_status.py).
        tech = _TECH.get(r['network_type']) or status_label(r)
        if r['received_at'] and r['ts']:
            delays.append((r['received_at'] - r['ts']).total_seconds())
        level = sample_level(r['network_type'], r['rsrp_dbm'], r['rscp_dbm'], r['rssi_dbm'])
        q = _quality(tech, level)
        t = per_tech.setdefault(tech, {'tech': tech, 'readings': 0, 'weak': 0, 'fair': 0, 'good': 0,
                                       'status': 'measured' if tech in WEAK_DBM else _status_key(r),
                                       '_lvl': [], '_rsrq': [], '_sinr': [], '_cqi': []})
        t['readings'] += 1
        if q:
            t[q] += 1
        t['_lvl'].append(level)
        if tech == '4G':
            t['_rsrq'].append(r['rsrq_db'])
            t['_sinr'].append(r['sinr_db'])
            t['_cqi'].append(sample_cqi_fields(r['cqi'], r['sinr_db'], r['rsrq_db'], r['network_type'])['cqi_value'])
        devices.add(r['device_id'])
        if r['serving_site_id']:
            s = sites.setdefault((r['serving_site_id'], r['serving_sector'] or '', tech),
                                 {'site_id': r['serving_site_id'], 'sector': r['serving_sector'] or '', 'tech': tech,
                                  'readings': 0, 'weak': 0, '_lvl': []})
            s['readings'] += 1
            s['weak'] += q == 'weak'
            s['_lvl'].append(level)
        if r['lat'] is not None and r['lng'] is not None and (positions is None or positions(r['ts'])):
            points.append({'lat': r['lat'], 'lng': r['lng'], 'tech': tech, 'level': level,
                           'ts': r['ts'], 'site_id': r['serving_site_id'] or None})
    techs = []
    for t in sorted(per_tech.values(), key=lambda t: -t['readings']):
        techs.append({k: v for k, v in t.items() if not k.startswith('_')} | {
            'level_mean': _mean(t.pop('_lvl')), 'rsrq_mean': _mean(t.pop('_rsrq')),
            'sinr_mean': _mean(t.pop('_sinr')), 'cqi_mean': _mean(t.pop('_cqi')),
        })
    site_rows = sorted(sites.values(), key=lambda s: -s['readings'])
    newest = rows[0]
    newest_tech = _TECH.get(newest['network_type'])
    return {
        'total': total, 'summarised': len(rows), 'devices': len(devices),
        'first': rows[-1]['ts'], 'last': newest['ts'],
        'by_tech': techs,
        'sites_count': len({s['site_id'] for s in site_rows}),
        'sites': [{k: v for k, v in s.items() if k != '_lvl'} | {'level_mean': _mean(s['_lvl'])}
                  for s in site_rows[:20]] if show_sites else None,
        'newest': {
            'ts': newest['ts'], 'network_type': newest['network_type'], 'tech': newest_tech,
            'level': sample_level(newest['network_type'], newest['rsrp_dbm'], newest['rscp_dbm'], newest['rssi_dbm']),
            'rsrq': newest['rsrq_db'], 'sinr': newest['sinr_db'],
            'cqi': sample_cqi_fields(newest['cqi'], newest['sinr_db'], newest['rsrq_db'], newest['network_type'])['cqi_value'],
            'site_id': newest['serving_site_id'] or None, 'sector': newest['serving_sector'] or None,
        },
        'points': _squares(points),
        'points_hidden': positions is not None and not points,
        # Outdoors / indoors / in a vehicle of the readings analysed (2026-10-26); '' = not tagged.
        'environments': envs,
        # How late readings reached the server: queued on the phone while it
        # had no data connection, or not let out in the background. Not
        # coverage (2026-10-26).
        'delay': {
            'median_s': round(sorted(delays)[len(delays) // 2]) if delays else None,
            'late_pct': round(100 * sum(1 for d in delays if d > LATE_SECONDS) / len(delays)) if delays else None,
            'late_after_s': LATE_SECONDS,
        },
    }


def _drive_tests(qs, kind):
    """Summary of drive-test readings, per session; `latest` keeps the newest session."""
    sessions = list(
        qs.values('session_id', 'session__name', 'session__date', 'session__tech')
        .annotate(n=Count('id'), rsrp=Avg('rsrp'), rscp=Avg('rscp'), rsrq=Avg('rsrq'), sinr=Avg('sinr'), dl=Avg('dl'))
        .order_by('-session__date', '-session_id')[:50]
    )
    if not sessions:
        return None
    if kind == 'latest':
        sessions = sessions[:1]
        qs = qs.filter(session_id=sessions[0]['session_id'])
    rows = list(qs.values('lat', 'lng', 'rsrp', 'rscp', 'session__tech')[:MAX_ROWS])
    counts = {'weak': 0, 'fair': 0, 'good': 0}
    points = []
    for r in rows:
        tech = r['session__tech'] or '4G'
        level = r['rscp'] if tech == '3G' and r['rscp'] is not None else r['rsrp']
        q = _quality(tech, level)
        if q:
            counts[q] += 1
        if r['lat'] is not None and r['lng'] is not None:
            points.append({'lat': r['lat'], 'lng': r['lng'], 'tech': tech, 'level': level, 'ts': None, 'site_id': None})
    return {
        'readings': sum(s['n'] for s in sessions), 'quality': counts,
        'sessions': [{
            'id': s['session_id'], 'name': s['session__name'], 'tech': s['session__tech'] or '4G',
            'date': s['session__date'].isoformat() if s['session__date'] else None, 'readings': s['n'],
            'level_mean': _round(s['rscp'] if (s['session__tech'] == '3G' and s['rscp'] is not None) else s['rsrp']),
            'rsrq_mean': _round(s['rsrq']), 'sinr_mean': _round(s['sinr']), 'dl_mean': _round(s['dl'], 2),
        } for s in sessions],
        'points': _squares(points),
    }


def _complaints(qs, report, start, end):
    if start:
        qs = qs.filter(happened_at__gte=start)
    if end:
        qs = qs.filter(happened_at__lte=end)
    qs = qs.exclude(pk=report.pk)
    rows = list(qs.order_by('-happened_at')[:20])
    causes = {}
    for c in qs.values_list('cause', flat=True)[:2000]:
        causes[c or 'unchecked'] = causes.get(c or 'unchecked', 0) + 1
    return {
        'count': qs.count(),
        'by_cause': [{'cause': k, 'label': CAUSE_LABELS.get(k, 'Not checked'), 'count': v}
                     for k, v in sorted(causes.items(), key=lambda kv: -kv[1])],
        'recent': [{'id': p.pk, 'reference': f'{p.external_system} {p.external_ref}' if p.external_ref else f'PR-{p.pk}',
                    'category': p.get_category_display(), 'happened_at': p.happened_at, 'status': p.status,
                    'cause_label': CAUSE_LABELS.get(p.cause, '')} for p in rows],
    }


def _customer(report, kind, start, end, user):
    msisdn = (report.device.msisdn if report.device_id and report.device else '') or report.msisdn
    if not msisdn:
        return None
    found = devices_of_number(msisdn)
    ids = [i for i in found['ids'] if i not in found['withdrawn']]
    # A superadmin always sees positions; others in an emergency or a
    # complaint window (2026-10-27).
    declared = active_emergency() is not None
    emergency = declared or getattr(user, 'role', '') == 'superadmin'
    windows = complaint_windows(msisdn, found['credentials'])

    def positions(ts):
        return emergency or any(a <= ts <= b for a, b, _rid in windows)

    tele = None
    if ids:
        tele = _telemetry(_tele_range(TelemetrySample.objects.filter(device_id__in=ids), start, end), kind,
                          show_sites=True, positions=positions)
    speed = TelemetrySpeedResult.objects.filter(device_id__in=ids)
    calls = CallContextSample.objects.filter(device_id__in=ids)
    sessions = CollectionSession.objects.filter(device_hash__in=ids)
    if start:
        speed, calls = speed.filter(ts__gte=start), calls.filter(started_at__gte=start)
        sessions = sessions.filter(Q(last_sample_at__gte=start) | Q(started_at__gte=start))
    if end:
        speed, calls, sessions = speed.filter(ts__lte=end), calls.filter(started_at__lte=end), sessions.filter(started_at__lte=end)
    speed_total = speed.count()
    speed_rows = list(speed.order_by('-ts')[:10 if kind == 'latest' else 200])
    call_counts = dict(calls.values_list('outcome').annotate(n=Count('id')))
    others = ProblemReport.objects.filter(Q(msisdn=msisdn) | Q(device__msisdn=msisdn))
    return {
        'phones': len(ids),
        'withdrawn': len(found['withdrawn']),
        'location_rule': 'emergency' if declared else 'superadmin' if emergency else (
            'complaint_windows' if windows else 'hidden'),
        'telemetry': tele,
        'speed_tests': {
            'count': speed_total,
            'download_mean': _mean([s.download_mbps for s in speed_rows]),
            'upload_mean': _mean([s.upload_mbps for s in speed_rows]),
            'ping_mean': _mean([s.ping_median_ms for s in speed_rows]),
            'recent': [{'ts': s.ts, 'network_type': s.network_type, 'bearer': s.bearer, 'download_mbps': s.download_mbps,
                        'upload_mbps': s.upload_mbps, 'ping_ms': s.ping_median_ms, 'packet_loss_pct': s.packet_loss_pct,
                        'rsrp_dbm': s.rsrp_dbm} for s in speed_rows[:10]],
        },
        'calls': {'count': sum(call_counts.values()),
                  'by_outcome': [{'outcome': k, 'label': dict(CallContextSample.OUTCOMES).get(k, k), 'count': v}
                                 for k, v in sorted(call_counts.items(), key=lambda kv: -kv[1])]},
        'sessions': [{'id': str(s.id), 'name': s.name or s.source, 'source': s.source, 'readings': s.sample_count,
                      'started_at': s.started_at, 'last_sample_at': s.last_sample_at}
                     for s in sessions.order_by('-started_at')[:20]],
        'complaints': _complaints(others, report, start, end),
    }


def _site_of(report):
    if report.site_id:
        return report.site_id, 'served the report'
    point = Point(report.lng, report.lat, srid=4326)
    s = Site.objects.filter(location__dwithin=(point, D(km=10))).annotate(d=Distance('location', point)) \
        .order_by('d').values_list('pk', flat=True).first()
    return (s, 'nearest site') if s else (None, '')


def _site(report, kind, start, end, user):
    site_id, why = _site_of(report)
    if not site_id:
        return None
    site = Site.objects.filter(pk=site_id).values('pk', 'name', 'district', 'lat', 'lng').first() or {}
    tele = _telemetry(_tele_range(_scope_by_operator(TelemetrySample.objects.filter(serving_site_id=site_id), user),
                                  start, end), kind)
    dt = _drive_tests(_dt_range(DriveTestSample.objects.filter(serving_site_id=site_id), start, end), kind)
    return {
        'site_id': site_id, 'name': site.get('name'), 'district': site.get('district'),
        'lat': site.get('lat'), 'lng': site.get('lng'), 'why': why,
        'telemetry': tele, 'drive_tests': dt,
        'complaints': _complaints(ProblemReport.objects.filter(site_id=site_id), report, start, end),
    }


def _area(report, kind, start, end, user, radius_km):
    point = Point(report.lng, report.lat, srid=4326)
    near = D(km=radius_km)
    tele = _telemetry(_tele_range(_scope_by_operator(
        TelemetrySample.objects.filter(location__dwithin=(point, near))
        .exclude(trigger_reason__in=('drive_start', 'drive_stop')), user), start, end), kind)
    dt = _drive_tests(_dt_range(DriveTestSample.objects.filter(location__dwithin=(point, near)), start, end), kind)
    # Complaints near the spot: a box is close enough for a list of reports.
    dlat = radius_km / 111.0
    dlng = dlat / max(0.2, math.cos(math.radians(report.lat)))
    others = ProblemReport.objects.filter(lat__range=(report.lat - dlat, report.lat + dlat),
                                          lng__range=(report.lng - dlng, report.lng + dlng))
    return {'radius_km': radius_km, 'telemetry': tele, 'drive_tests': dt,
            'complaints': _complaints(others, report, start, end)}


class ProblemRelatedView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport.objects.select_related('device'), pk=pk)
        kind, start, end, hours = _window(report, request.query_params)
        try:
            radius = float(request.query_params.get('radius_km', 1))
        except (TypeError, ValueError):
            radius = 1
        radius = min(RADII_KM, key=lambda r: abs(r - radius))
        customer = _customer(report, kind, start, end, request.user)
        if (customer and request.user.role != 'superadmin'
                and cache.add(f'prrel:seen:{request.user.pk}:{pk}', 1, timeout=3600)):
            log_audit_event(request, 'PROBLEM_REPORT.RELATED_VIEWED', resource='problem_report', resource_id=str(pk),
                            detail=f'range={kind}')
        return Response({
            'range': {'kind': kind, 'start': start, 'end': end, 'hours': hours,
                      'hours_options': AROUND_HOURS, 'radii_km': RADII_KM},
            'customer': customer,
            'site': _site(report, kind, start, end, request.user),
            'area': _area(report, kind, start, end, request.user, radius),
        })
