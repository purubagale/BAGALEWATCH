"""Problem reports (2026-10-14).

A person reports a network problem from the app's "Report a problem" button,
or an engineer enters one from a customer's complaint. A report from the app
carries the phone's own reading and a speed test over mobile data taken when
it was sent. The check, worked out each time a report is opened, puts that
next to what other phones and drive tests measured around the spot, compares
the time of the problem with the 7 days before, and names the likely cause
with plain rules (no model). An engineer marks the report checked or closed.

    POST /api/telemetry/v1/device/problem-reports/   registered phone, signed
    GET  /api/v2/problem-reports/                    list, admin and superadmin
    POST /api/v2/problem-reports/                    staff entry
    GET  /api/v2/problem-reports/<id>/               one report with its check
    PATCH /api/v2/problem-reports/<id>/              status and engineer note

Only counts and averages of other phones' readings are shown, never a
device. The reporter's phone number is shown to a superadmin only.
"""
import math
from datetime import datetime, timedelta, timezone as dt_timezone

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.core.cache import cache
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .device_auth import DeviceSignatureAuthentication, IsDevice
from .dt_serving_cell import _candidate_sectors, choose_sector, sectors_by_cell_identity
from .models import DriveTestSample, ProblemReport, Site, TelemetrySample
from .telemetry import TELEMETRY_MATCH_MAX_KM, _scope_by_operator
from .telemetry_level import sample_level
from .views import IsAdminOrSuperadmin

# Limits on reports from phones.
MAX_REPORTS_PER_DAY = 10            # one phone
MAX_REPORTS_PER_DAY_ALL = 2000      # every phone together
MAX_NOTE_CHARS = 500

# What the check looks at around a report. Starting values for RF engineers to tune.
RADIUS_M = 500
BASELINE_DAYS = 7
AT_TIME_HOURS = 1                   # readings this close to the problem count as "at the time"
MIN_READINGS = 5                    # fewer than this and an average is not used
DROP_DB = 6                         # "worse than usual" when the level is this much lower
WEAK_DBM = {'4G': -110, '3G': -105, '2G': -100}
GOOD_DBM = {'4G': -100, '3G': -95, '2G': -85}
BAD_RSRQ_DB = -15
BAD_SINR_DB = 0
SLOW_DL_MBPS = 2.0
HIGH_PING_MS = 150.0
HIGH_LOSS_PCT = 5.0
FOUR_G_USABLE_DBM = -105            # 4G nearby at least this strong: a 2G/3G phone could have used it

_TECH = {'LTE': '4G', 'NR': '4G', 'UMTS': '3G', 'GSM': '2G'}


def _num(value, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and lo <= v <= hi else None


def _int(value, lo, hi):
    v = _num(value, lo, hi)
    return int(round(v)) if v is not None else None


def _mean(values):
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values), 1) if values else None


# ── The check ──────────────────────────────────────────────────────────────


def _phone_readings(report, user):
    """Other phones' readings within RADIUS_M, at the time and in the 7 days before."""
    at = report.happened_at
    start = at - timedelta(days=BASELINE_DAYS)
    end = at + timedelta(hours=AT_TIME_HOURS)
    dlat = RADIUS_M / 111_000.0
    dlng = dlat / max(0.2, math.cos(math.radians(report.lat)))
    qs = TelemetrySample.objects.filter(
        received_at__gte=start, ts__gte=start, ts__lte=end,
        lat__range=(report.lat - dlat, report.lat + dlat), lng__range=(report.lng - dlng, report.lng + dlng),
    ).exclude(trigger_reason__in=('drive_start', 'drive_stop'))
    rows = _scope_by_operator(qs, user).values_list(
        'ts', 'network_type', 'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'rsrq_db', 'lat', 'lng',
    )[:20000]
    near_cut = at - timedelta(hours=AT_TIME_HOURS)
    out = {'at_time': [], 'before': []}
    cos = math.cos(math.radians(report.lat))
    for ts, net, rsrp, rscp, rssi, rsrq, lat, lng in rows:
        if math.hypot((lat - report.lat) * 111_000.0, (lng - report.lng) * 111_000.0 * cos) > RADIUS_M:
            continue
        tech = _TECH.get(net)
        if tech is None:
            continue
        reading = (tech, sample_level(net, rsrp, rscp, rssi), rsrq)
        out['at_time' if ts >= near_cut else 'before'].append(reading)
    return out


def _summary(readings):
    """Count, share on 4G, and the 4G averages, of (tech, level, rsrq) readings."""
    n = len(readings)
    four_g = [r for r in readings if r[0] == '4G']
    return {
        'readings': n,
        'share_4g_pct': round(100.0 * len(four_g) / n) if n else None,
        'rsrp_4g_mean': _mean([r[1] for r in four_g]),
        'rsrq_4g_mean': _mean([r[2] for r in four_g]),
        'readings_4g': len(four_g),
    }


def _drive_tests(report):
    """Drive-test readings within RADIUS_M, any date."""
    point = Point(report.lng, report.lat, srid=4326)
    rows = list(
        DriveTestSample.objects.filter(location__distance_lte=(point, D(m=RADIUS_M)))
        .values_list('session__tech', 'rsrp', 'rscp', 'rsrq', 'dl', 'session_id', 'session__name', 'session__date')[:20000]
    )
    four_g = [r for r in rows if (r[0] or '4G') == '4G']
    sessions = {}
    for r in rows:
        sessions.setdefault(r[5], {'id': r[5], 'name': r[6], 'date': r[7].isoformat() if r[7] else None,
                                   'tech': r[0] or '4G'})
    latest = sorted(sessions.values(), key=lambda s: s['date'] or '', reverse=True)[:5]
    return {
        'readings': len(rows),
        'readings_4g': len(four_g),
        'rsrp_4g_mean': _mean([r[1] for r in four_g]),
        'rsrq_4g_mean': _mean([r[3] for r in four_g]),
        'dl_4g_mean': _mean([r[4] for r in four_g]),
        'sessions': latest,
    }


def _serving(report):
    """The site that served the phone, when its reading names the cell, and the nearest sites."""
    point = Point(report.lng, report.lat, srid=4326)
    nearest = [
        {'site_id': s.pk, 'name': s.name, 'km': round(s.distance.km, 2)}
        for s in Site.objects.filter(location__distance_lte=(point, D(km=TELEMETRY_MATCH_MAX_KM)))
        .annotate(distance=Distance('location', point)).order_by('distance')[:3]
    ]
    serving = None
    if _TECH.get(report.network_type) == '4G':
        sector, km, how = None, None, ''
        if report.cell_id:
            sector = sectors_by_cell_identity({report.cell_id}).get(report.cell_id)
            if sector is not None and sector.site.lat is not None:
                km = math.hypot((sector.site.lat - report.lat) * 111.0,
                                (sector.site.lng - report.lng) * 111.0 * math.cos(math.radians(report.lat)))
                how = 'cell identity'
        if sector is None and report.pci is not None:
            sector, km, uncertain = choose_sector(report.lat, report.lng, list(_candidate_sectors('4G', [report.pci])),
                                                  max_km=TELEMETRY_MATCH_MAX_KM)
            how = 'PCI, uncertain' if uncertain else 'PCI'
        if sector is not None:
            serving = {
                'site_id': sector.site_id, 'name': sector.site.name, 'cell_name': sector.cell_name,
                'km': round(km, 2) if km is not None else None, 'matched_by': how,
            }
    return serving, nearest


def _finding(kind, title, cause, action, evidence):
    return {'kind': kind, 'title': title, 'cause': cause, 'action': action, 'evidence': evidence}


def check_report(report, user):
    """The measurements around a report and the likely causes, most likely first."""
    phones = _phone_readings(report, user)
    at_time, before = _summary(phones['at_time']), _summary(phones['before'])
    dt = _drive_tests(report)
    serving, nearest = _serving(report)
    site_name = (serving or {}).get('site_id') or (nearest[0]['site_id'] if nearest else 'the nearest site')

    tech = _TECH.get(report.network_type)
    level = report.level_dbm
    findings = []

    # 4G level at the spot, from whatever measured it: the phone, other phones now, drive tests.
    spot_4g = level if tech == '4G' else None
    if spot_4g is None and at_time['readings_4g'] >= MIN_READINGS:
        spot_4g = at_time['rsrp_4g_mean']
    if spot_4g is None and before['readings_4g'] >= MIN_READINGS:
        spot_4g = before['rsrp_4g_mean']
    if spot_4g is None and dt['readings_4g'] >= MIN_READINGS:
        spot_4g = dt['rsrp_4g_mean']

    weak_here = (tech and level is not None and level < WEAK_DBM[tech]) or \
        (level is None and spot_4g is not None and spot_4g < WEAK_DBM['4G'])
    good_here = tech and level is not None and level >= GOOD_DBM[tech]

    if weak_here:
        shown = f'{level} dBm on the phone' if level is not None else f'{spot_4g} dBm average nearby'
        findings.append(_finding(
            'weak_coverage', 'Weak signal at this spot',
            'The signal here is too weak for a steady connection.',
            f'Check the tilt and direction of the sector of {site_name} that faces this spot; if the customer '
            'is indoors, an indoor solution may be needed. Plan a drive test if there is none recent.',
            [shown],
        ))

    if good_here and ((report.rsrq_db is not None and report.rsrq_db <= BAD_RSRQ_DB) or
                      (report.sinr_db is not None and report.sinr_db < BAD_SINR_DB)):
        findings.append(_finding(
            'interference', 'Good signal but poor quality',
            'The signal is strong but its quality is poor: other cells are likely interfering here.',
            f'Check overlapping cells around {site_name}: tilt, power and PCI/neighbour plan.',
            [f'level {level} dBm', f'RSRQ {report.rsrq_db} dB' if report.rsrq_db is not None else '',
             f'SINR {report.sinr_db} dB' if report.sinr_db is not None else ''],
        ))
    elif level is None and at_time['readings_4g'] >= MIN_READINGS and at_time['rsrp_4g_mean'] is not None \
            and at_time['rsrp_4g_mean'] >= GOOD_DBM['4G'] and (at_time['rsrq_4g_mean'] or 0) <= BAD_RSRQ_DB:
        findings.append(_finding(
            'interference', 'Good signal but poor quality nearby',
            'Phones nearby see a strong signal of poor quality: other cells are likely interfering here.',
            f'Check overlapping cells around {site_name}: tilt, power and PCI/neighbour plan.',
            [f'RSRP {at_time["rsrp_4g_mean"]} dBm and RSRQ {at_time["rsrq_4g_mean"]} dB average nearby'],
        ))

    slow = (report.download_mbps is not None and report.download_mbps < SLOW_DL_MBPS) or \
        (report.ping_ms is not None and report.ping_ms > HIGH_PING_MS) or \
        (report.packet_loss_pct is not None and report.packet_loss_pct >= HIGH_LOSS_PCT)
    if slow and not weak_here and (good_here or (level is None and spot_4g is not None and spot_4g >= GOOD_DBM['4G'])):
        findings.append(_finding(
            'busy_cell', 'Good signal but slow',
            'The signal is good but the speed is low: the cell is probably busy at this time.',
            f'Check the load and number of users of the serving cell of {site_name} at this hour; consider '
            'more capacity (another carrier, load balancing) if it is busy every day.',
            [f'download {report.download_mbps} Mbps' if report.download_mbps is not None else '',
             f'ping {report.ping_ms} ms' if report.ping_ms is not None else '',
             f'packet loss {report.packet_loss_pct}%' if report.packet_loss_pct is not None else ''],
        ))

    four_g_nearby = [v for v, n in ((before['rsrp_4g_mean'], before['readings_4g']),
                                    (dt['rsrp_4g_mean'], dt['readings_4g'])) if v is not None and n >= MIN_READINGS]
    lower_tech = tech in ('2G', '3G') or report.category == 'stuck_2g3g'
    if lower_tech and four_g_nearby and max(four_g_nearby) >= FOUR_G_USABLE_DBM:
        findings.append(_finding(
            'lower_tech', '4G is available here but the phone was on 2G/3G',
            'Other phones and drive tests receive usable 4G at this spot, so the phone itself is the likely cause.',
            'Ask the customer to set the network mode to 4G/LTE, check the SIM is a 4G SIM, and check the '
            'phone supports NTC 4G bands. Restarting the phone often brings it back to 4G.',
            [f'4G {max(four_g_nearby)} dBm average nearby'],
        ))
    elif lower_tech and four_g_nearby:
        findings.append(_finding(
            'lower_tech_weak_4g', 'Little 4G at this spot',
            'The 4G signal here is weak, so phones fall back to 2G/3G.',
            f'Treat as a 4G coverage gap near {site_name}: check the sector facing this spot, plan a drive test.',
            [f'4G {max(four_g_nearby)} dBm average nearby'],
        ))

    if at_time['readings'] >= MIN_READINGS and before['readings'] >= MIN_READINGS and \
            at_time['rsrp_4g_mean'] is not None and before['rsrp_4g_mean'] is not None and \
            before['rsrp_4g_mean'] - at_time['rsrp_4g_mean'] >= DROP_DB:
        findings.append(_finding(
            'worse_than_usual', 'Worse than usual',
            'Phones here received a weaker signal at the time of the problem than over the week before: '
            'something may have changed at the site.',
            f'Check alarms, outages and recent changes at {site_name} for that time.',
            [f'4G {at_time["rsrp_4g_mean"]} dBm at the time against {before["rsrp_4g_mean"]} dBm in the week before'],
        ))

    if report.category == 'call_drop':
        findings.append(_finding(
            'call_drop', 'Call drops cannot be seen in phone readings',
            'Phone readings show the signal, not why a call ended.',
            f'Check the call drop counters of the serving cell of {site_name} for that hour.',
            [],
        ))

    has_data = level is not None or at_time['readings'] or before['readings'] or dt['readings']
    if not has_data:
        findings.append(_finding(
            'no_data', 'No measurements near this spot',
            'Nothing has been measured within 500 m, so the cause cannot be told from the data.',
            'Plan a drive test here, or ask the phones in the area for a fresh reading.',
            [],
        ))
    elif not findings:
        findings.append(_finding(
            'no_fault_found', 'No fault found in the measurements',
            'The signal and speed measured around this spot look normal.',
            'Ask the customer for the exact place and time, and check the serving cell for alarms at that time.',
            [],
        ))

    for f in findings:
        f['evidence'] = [e for e in f['evidence'] if e]

    return {
        'radius_m': RADIUS_M,
        'baseline_days': BASELINE_DAYS,
        'phones_at_time': at_time,
        'phones_before': before,
        'drive_tests': dt,
        'serving': serving,
        'nearest_sites': nearest,
        'findings': findings,
        'customer_reply': CUSTOMER_REPLY.get(findings[0]['kind'], CUSTOMER_REPLY['no_fault_found']),
    }


# A short reply an engineer can send the customer, by the first finding.
CUSTOMER_REPLY = {
    'weak_coverage': 'Thank you for telling us. The signal at your location is weak; our engineers are checking '
                     'the nearby tower to improve it.',
    'interference': 'Thank you for telling us. We found a signal quality problem at your location and our '
                    'engineers are adjusting the nearby towers.',
    'busy_cell': 'Thank you for telling us. The network at your location is busy at this time of day; we are '
                 'working to add capacity.',
    'lower_tech': 'Thank you for telling us. 4G is available at your location. Please set your phone\'s network '
                  'mode to 4G/LTE and restart it. If it still stays on 3G, please visit an NTC service centre.',
    'lower_tech_weak_4g': 'Thank you for telling us. 4G coverage at your location is weak; our engineers are '
                          'looking at how to improve it.',
    'worse_than_usual': 'Thank you for telling us. We found a change in the network near you and our engineers '
                        'are checking it.',
    'call_drop': 'Thank you for telling us. Our engineers are checking the call records of the tower serving '
                 'your area.',
    'no_data': 'Thank you for telling us. Our engineers will measure the network at your location.',
    'no_fault_found': 'Thank you for telling us. We did not find a network fault at your location. Please tell '
                      'us the exact place and time the problem happens.',
}


# ── Views ──────────────────────────────────────────────────────────────────


def _row(report, user, with_check=False):
    out = {
        'id': report.pk,
        'source': report.source,
        'category': report.category,
        'category_label': report.get_category_display(),
        'note': report.note,
        'happened_at': report.happened_at.isoformat(),
        'created_at': report.created_at.isoformat(),
        'lat': report.lat, 'lng': report.lng,
        'network_type': report.network_type, 'band': report.band, 'pci': report.pci, 'cell_id': report.cell_id,
        'level_dbm': report.level_dbm, 'rsrq_db': report.rsrq_db, 'sinr_db': report.sinr_db,
        'download_mbps': report.download_mbps, 'upload_mbps': report.upload_mbps,
        'ping_ms': report.ping_ms, 'jitter_ms': report.jitter_ms, 'packet_loss_pct': report.packet_loss_pct,
        'phone_model': report.phone_model, 'android_version': report.android_version,
        'app_version': report.app_version,
        'status': report.status,
        'engineer_note': report.engineer_note,
        'entered_by': report.entered_by.username if report.entered_by_id else None,
        'checked_by': report.checked_by.username if report.checked_by_id else None,
        'checked_at': report.checked_at.isoformat() if report.checked_at else None,
    }
    if user.role == 'superadmin':
        out['phone_number'] = report.device.msisdn if report.device_id else None
    if with_check:
        out['check'] = check_report(report, user)
    return out


class DeviceProblemReportView(APIView):
    """One report from a registered phone, with its reading and speed test."""
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def post(self, request):
        device = request.user
        data = request.data if isinstance(request.data, dict) else {}

        today = f'{timezone.now():%Y%m%d}'
        day_key = f'problemreport:{device.device_hash}:{today}'
        all_key = f'problemreport:all:{today}'
        if cache.get(day_key, 0) >= MAX_REPORTS_PER_DAY or cache.get(all_key, 0) >= MAX_REPORTS_PER_DAY_ALL:
            return Response({'detail': 'Daily report limit reached. Try again tomorrow.'}, status=429)

        category = str(data.get('category') or '')
        if category not in dict(ProblemReport.CATEGORIES):
            return Response({'detail': 'Choose what the problem is.'}, status=400)
        lat = _num(data.get('lat'), -90, 90)
        lon = _num(data.get('lon'), -180, 180)
        if lat is None or lon is None:
            return Response({'detail': 'The phone\'s position is needed. Switch on location and try again.'},
                            status=400)
        now = timezone.now()
        happened_at = now
        ts = _num(data.get('ts'), 0, 4e12)
        if ts is not None:
            happened_at = datetime.fromtimestamp(ts / 1000, tz=dt_timezone.utc)
            if not now - timedelta(days=1) <= happened_at <= now + timedelta(minutes=10):
                happened_at = now

        report = ProblemReport.objects.create(
            source=ProblemReport.SOURCE_APP, device=device, category=category,
            note=str(data.get('note') or '')[:MAX_NOTE_CHARS], happened_at=happened_at, lat=lat, lng=lon,
            network_type=str(data.get('network_type') or '').upper()[:12],
            band=str(data.get('band') or '')[:24],
            pci=_int(data.get('pci'), 0, 1007), cell_id=_int(data.get('cell_id'), 0, 2 ** 36),
            level_dbm=_int(data.get('level_dbm'), -160, 0),
            rsrq_db=_int(data.get('rsrq_db'), -40, 10), sinr_db=_int(data.get('sinr_db'), -30, 50),
            download_mbps=_num(data.get('download_mbps'), 0, 10_000),
            upload_mbps=_num(data.get('upload_mbps'), 0, 10_000),
            ping_ms=_num(data.get('ping_ms'), 0, 60_000), jitter_ms=_num(data.get('jitter_ms'), 0, 60_000),
            packet_loss_pct=_num(data.get('packet_loss_pct'), 0, 100),
            phone_model=str(data.get('phone_model') or '')[:80],
            android_version=str(data.get('android_version') or '')[:16],
            app_version=str(data.get('app_version') or '')[:40],
        )
        for key in (day_key, all_key):
            cache.add(key, 0, timeout=86400)
            try:
                cache.incr(key)
            except ValueError:
                pass
        return Response({'id': report.pk, 'stored': True}, status=201)


class ProblemReportListView(APIView):
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        qs = ProblemReport.objects.select_related('device', 'entered_by', 'checked_by')
        for field in ('status', 'category', 'source'):
            value = request.query_params.get(field)
            if value:
                qs = qs.filter(**{field: value})
        return Response({'results': [_row(r, request.user) for r in qs[:500]]})

    def post(self, request):
        """An engineer enters a problem from a customer's complaint."""
        data = request.data if isinstance(request.data, dict) else {}
        category = str(data.get('category') or '')
        if category not in dict(ProblemReport.CATEGORIES):
            return Response({'detail': 'Choose what the problem is.'}, status=400)
        lat = _num(data.get('lat'), -90, 90)
        lng = _num(data.get('lng'), -180, 180)
        if lat is None or lng is None:
            return Response({'detail': 'Pick the place on the map.'}, status=400)
        happened_at = parse_datetime(str(data.get('happened_at') or '')) or timezone.now()
        if timezone.is_naive(happened_at):
            happened_at = timezone.make_aware(happened_at)
        report = ProblemReport.objects.create(
            source=ProblemReport.SOURCE_STAFF, entered_by=request.user, category=category,
            note=str(data.get('note') or '')[:MAX_NOTE_CHARS], happened_at=happened_at, lat=lat, lng=lng,
        )
        log_audit_event(request, 'problem_report_create', resource='problem_report', resource_id=str(report.pk),
                        detail=f'entered a {category} problem')
        return Response(_row(report, request.user, with_check=True), status=201)


class ProblemReportDetailView(APIView):
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport.objects.select_related('device', 'entered_by', 'checked_by'), pk=pk)
        return Response(_row(report, request.user, with_check=True))

    def patch(self, request, pk):
        report = get_object_or_404(ProblemReport, pk=pk)
        data = request.data if isinstance(request.data, dict) else {}
        fields = []
        status_value = data.get('status')
        if status_value is not None:
            if status_value not in dict(ProblemReport.STATUSES):
                return Response({'detail': 'Unknown status.'}, status=400)
            report.status = status_value
            report.checked_by = request.user
            report.checked_at = timezone.now()
            fields += ['status', 'checked_by', 'checked_at']
        if 'engineer_note' in data:
            report.engineer_note = str(data.get('engineer_note') or '')[:2000]
            fields.append('engineer_note')
        if fields:
            report.save(update_fields=fields)
            log_audit_event(request, 'problem_report_update', resource='problem_report', resource_id=str(pk),
                            detail=f'status {report.status}')
        return Response({'id': report.pk, 'status': report.status})
