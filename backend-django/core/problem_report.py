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
import time
from datetime import datetime, timedelta, timezone as dt_timezone

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.core.cache import cache
from django.db.models import Count, F, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .device_auth import DeviceSignatureAuthentication, IsDevice
from .dt_serving_cell import _candidate_sectors, choose_sector, sectors_by_cell_identity
from .models import DriveTestSample, ProblemReport, Site, TelemetrySample
from .problem_notify import queue_update, report_notify_info
from .telemetry import TELEMETRY_MATCH_MAX_KM, _scope_by_operator
from . import neighbour_cells, speed_quality
from .call_cells import call_findings
from .telemetry_level import sample_level
from rest_framework.permissions import BasePermission

from .views import get_visible_menu_items

# Limits on reports from phones.
MAX_REPORTS_PER_DAY = 10            # one phone
MAX_REPORTS_PER_DAY_ALL = 2000      # every phone together
MAX_NOTE_CHARS = 500

# What the check looks at around a report. Starting values for RF engineers to tune.
RADIUS_M = 500
BASELINE_DAYS = 7
AT_TIME_HOURS = 1                   # readings this close to the problem count as "at the time"
# When nothing was measured that close (2026-10-28): look again within
# WIDE_RADIUS_M and WIDE_DAYS either side of the problem, and say so.
WIDE_RADIUS_M = 1000
WIDE_DAYS = 90
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


def _phone_readings(report, user, radius_m=RADIUS_M, wide=False):
    """Other phones' readings within radius_m, at the time and in the 7 days
    before; `wide` takes WIDE_DAYS either side of the problem instead."""
    at = report.happened_at
    start = at - timedelta(days=WIDE_DAYS if wide else BASELINE_DAYS)
    end = at + (timedelta(days=WIDE_DAYS) if wide else timedelta(hours=AT_TIME_HOURS))
    dlat = radius_m / 111_000.0
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
        if math.hypot((lat - report.lat) * 111_000.0, (lng - report.lng) * 111_000.0 * cos) > radius_m:
            continue
        tech = _TECH.get(net)
        if tech is None:
            continue
        reading = (tech, sample_level(net, rsrp, rscp, rssi), rsrq)
        at_time = near_cut <= ts <= at + timedelta(hours=AT_TIME_HOURS)
        out['at_time' if at_time else 'before'].append(reading)
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


def _drive_tests(report, radius_m=RADIUS_M):
    """Drive-test readings within radius_m, any date."""
    point = Point(report.lng, report.lat, srid=4326)
    # dwithin (ST_DWithin) uses the spatial index; distance_lte (ST_Distance)
    # read every drive-test reading and took about 2 s (2026-10-15).
    rows = list(
        DriveTestSample.objects.filter(location__dwithin=(point, D(m=radius_m)))
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
                'sector_id': sector.pk,
                'km': round(km, 2) if km is not None else None, 'matched_by': how,
            }
    return serving, nearest


def _outdoor_4g_mean(report):
    """Average 4G level of readings marked outdoors (or in a vehicle) within
    RADIUS_M in the BASELINE_DAYS before the report, or None with too few."""
    from django.db.models import Avg, Count
    point = Point(report.lng, report.lat, srid=4326)
    start = report.happened_at - timedelta(days=BASELINE_DAYS)
    agg = TelemetrySample.objects.filter(
        received_at__gte=start, ts__gte=start, ts__lte=report.happened_at + timedelta(hours=AT_TIME_HOURS),
        environment__in=('outdoor', 'vehicle'), network_type__in=('LTE', 'NR'), rsrp_dbm__isnull=False,
        location__dwithin=(point, D(m=RADIUS_M)),
    ).aggregate(n=Count('id'), avg=Avg('rsrp_dbm'))
    return round(agg['avg'], 1) if agg['n'] and agg['n'] >= MIN_READINGS else None


NEIGHBOUR_SHARE_PCT = 30            # share of readings before a neighbour finding is made


def _neighbours_near(report, user):
    """The neighbour cells phones heard within RADIUS_M, from BASELINE_DAYS
    before the problem to AT_TIME_HOURS after (2026-10-27,
    core/neighbour_cells.py). Only readings from app 1.2.3 on carry them."""
    point = Point(report.lng, report.lat, srid=4326)
    start = report.happened_at - timedelta(days=BASELINE_DAYS)
    qs = TelemetrySample.objects.filter(
        received_at__gte=start, ts__gte=start, ts__lte=report.happened_at + timedelta(hours=AT_TIME_HOURS),
        location__dwithin=(point, D(m=RADIUS_M)),
    )
    return neighbour_cells.session_summary(_scope_by_operator(qs, user) if user is not None else qs)


def _neighbour_findings(heard, site_name):
    """A stronger cell the phones did not move to, and no dominant cell."""
    out = []
    if (heard.get('same_tech_readings') or 0) < MIN_READINGS:
        return out
    stronger = [c for c in heard['cells'] if c['same_tech'] >= MIN_READINGS
                and (c['stronger_pct'] or 0) >= NEIGHBOUR_SHARE_PCT]
    if stronger:
        c = max(stronger, key=lambda c: c['stronger_pct'])
        where = f"{c['site_id']}{' ' + c['sector'] if c['sector'] else ''}" if c['site_id'] else 'an unplaced cell'
        beside = c['mostly_beside'] or site_name
        out.append(_finding(
            'stronger_neighbour', 'A stronger cell was not used',
            f"Phones here often heard {c['tech']} {c['cell']} of {where} clearly stronger than the cell they were on, "
            'so the handover to it comes late or the neighbour relation is missing.',
            f'Check the neighbour relation and handover settings between {beside} and {where}.',
            [f"{c['cell']} ({where}) {heard['stronger_db']} dB or more above the serving cell in "
             f"{c['stronger_pct']}% of {c['same_tech']} readings", f"best {c['level_best']} dBm, average {c['level_avg']} dBm"],
        ))
    if (heard.get('crowded_readings_pct') or 0) >= NEIGHBOUR_SHARE_PCT:
        names = [f"{c['cell']}{' (' + c['site_id'] + ')' if c['site_id'] else ''}" for c in heard['cells'][:4]]
        out.append(_finding(
            'no_dominant_cell', 'No dominant cell',
            f"Phones here hear {heard['crowd_cells']} or more other cells within {heard['crowd_db']} dB of the one "
            'they use, so no cell dominates and they interfere with each other.',
            f'Make one cell dominant here: review tilt and power of the cells heard ({", ".join(names)}).',
            [f"{heard['crowded_readings_pct']}% of {heard['same_tech_readings']} readings",
             f"{heard['avg_cells_heard']} cells heard per reading on average"],
        ))
    return out


def _customer_devices(report):
    """Every phone id of the complainant: the reporting phone's readings id
    and every phone tied to the number (same rule as the diagnosis dashboard)."""
    from .rescue import _clean_msisdn
    from .subscriber_profile import devices_of_number
    ids = set()
    device = report.device if report.device_id else None
    if device is not None and getattr(device, 'sdk_device_hash', ''):
        ids.add(device.sdk_device_hash)
    msisdn = _clean_msisdn((device.msisdn if device is not None else None) or report.msisdn)
    if msisdn:
        found = devices_of_number(msisdn)
        ids |= set(found['ids'])
    return ids


def _cell_load(report, serving, nearest):
    """The network KPIs of the serving cell around the problem time, else
    of the serving or nearest site's busiest cell (2026-10-28)."""
    from .cell_kpi import load_at
    if serving and serving.get('sector_id'):
        found = load_at(report.happened_at, sector_id=serving['sector_id'])
        if found:
            return found
    site = (serving or {}).get('site_id') or (nearest[0]['site_id'] if nearest else None)
    return load_at(report.happened_at, site_id=site) if site else None


def _load_line(load):
    if not load or load.get('prb_dl') is None:
        return ''
    from .cell_kpi import describe
    extra = [f"{load['thr_dl_user']} Mbps per user" if load.get('thr_dl_user') is not None else '',
             f"{load['users_avg']} users on average" if load.get('users_avg') is not None else '']
    return ', '.join([describe(load)] + [e for e in extra if e])


def _drop_line(load):
    if not load or (load.get('service_drop') is None and load.get('volte_drop') is None):
        return ''
    parts = [f"service drop {load['service_drop']}%" if load.get('service_drop') is not None else '',
             f"VoLTE call drop {load['volte_drop']}%" if load.get('volte_drop') is not None else '']
    return f"{load['cell_name'] or load['site_id']} on {load['date']}: " + ', '.join(p for p in parts if p)


def _finding(kind, title, cause, action, evidence):
    return {'kind': kind, 'title': title, 'cause': cause, 'action': action, 'evidence': evidence}


def check_report(report, user):
    """The measurements around a report and the likely causes, most likely first."""
    phones = _phone_readings(report, user)
    at_time, before = _summary(phones['at_time']), _summary(phones['before'])
    dt = _drive_tests(report)
    # Nothing that close (2026-10-28): look wider rather than say "no data"
    # while readings 1 km away or a month later exist.
    radius_m, widened = RADIUS_M, False
    if report.level_dbm is None and not (at_time['readings'] or before['readings'] or dt['readings']):
        phones = _phone_readings(report, user, WIDE_RADIUS_M, wide=True)
        at_time, before = _summary(phones['at_time']), _summary(phones['before'])
        dt = _drive_tests(report, WIDE_RADIUS_M)
        radius_m, widened = WIDE_RADIUS_M, True
    serving, nearest = _serving(report)
    site_name = (serving or {}).get('site_id') or (nearest[0]['site_id'] if nearest else 'the nearest site')
    load = _cell_load(report, serving, nearest)

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

    # Inside a building, weak, while outdoor readings around are good
    # (2026-10-26): the building, not the network, is the likely cause.
    outdoor_4g = _outdoor_4g_mean(report) if report.environment == 'indoor' and weak_here else None
    outside_good = outdoor_4g if outdoor_4g is not None else spot_4g
    if report.environment == 'indoor' and weak_here and level is not None and outside_good is not None \
            and outside_good >= GOOD_DBM['4G']:
        findings.append(_finding(
            'building_penetration', 'Weak indoors, good outside',
            'The phone was inside a building where the signal is weak, while the signal outside nearby is good. '
            'The building walls are likely blocking it.',
            f'Offer an indoor solution (repeater, small cell or Wi-Fi calling); no change at {site_name} is needed '
            'for this alone.',
            [f'{level} dBm on the phone, indoors',
             f'{outside_good} dBm average outside nearby' + (' (readings marked outdoors)' if outdoor_4g is not None else '')],
        ))
        weak_here = False

    if weak_here:
        shown = f'{level} dBm on the phone' if level is not None else f'{spot_4g} dBm average nearby'
        findings.append(_finding(
            'weak_coverage', 'Weak signal at this spot',
            'The signal here is too weak for a steady connection.',
            f'Check the tilt and direction of the sector of {site_name} that faces this spot; if the customer '
            'is indoors, an indoor solution may be needed. Plan a drive test if there is none recent.',
            [shown],
        ))

    # Neighbour cells heard by phones around (2026-10-27): measured, so ahead
    # of the quality-based interference guess below.
    heard = _neighbours_near(report, user)
    findings.extend(_neighbour_findings(heard, site_name))

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
    signal_ok = good_here or (level is None and spot_4g is not None and spot_4g >= GOOD_DBM['4G'])
    speed_evidence = [f'download {report.download_mbps} Mbps' if report.download_mbps is not None else '',
                      f'ping {report.ping_ms} ms' if report.ping_ms is not None else '',
                      f'packet loss {report.packet_loss_pct}%' if report.packet_loss_pct is not None else '']
    # The cell's real load from the network KPIs (2026-10-28, core/cell_kpi.py):
    # busy confirms the guess, quiet rules it out.
    if slow and not weak_here and signal_ok and load and load['quiet']:
        findings.append(_finding(
            'slow_not_busy', 'Slow, but the cell was not busy',
            'The signal is good and the cell had capacity to spare at that time, so the slowness is more likely '
            'the phone, its data plan or settings, or the link behind the site.',
            f"Check the customer's data plan and APN, try another phone at the spot, and check the "
            f'transmission link of {site_name}.',
            speed_evidence + [_load_line(load)],
        ))
    elif slow and not weak_here and signal_ok:
        findings.append(_finding(
            'busy_cell', 'Good signal but slow',
            'The signal is good but the speed is low: the cell is busy at this time.' if load and load['busy'] else
            'The signal is good but the speed is low: the cell is probably busy at this time.',
            f'Check the load and number of users of the serving cell of {site_name} at this hour; consider '
            'more capacity (another carrier, load balancing) if it is busy every day.',
            speed_evidence + [_load_line(load)],
        ))
    elif report.category == 'slow_data' and not weak_here and load and load['busy']:
        findings.append(_finding(
            'busy_cell', 'Busy cell at that time',
            'The customer reports slow data and the cell was busy at that time.',
            f'Consider more capacity for the serving cell of {site_name} (another carrier, load balancing) if it '
            'is busy every day.',
            [_load_line(load)],
        ))

    # Delay rising under load (2026-10-29, the phone's loaded latency): the
    # speed and idle ping look fine, but calls, video calls and games lag.
    loaded = speed_quality.loaded_latency(report.latency_down_ms, report.latency_up_ms)
    if not slow and loaded is not None and loaded > speed_quality.HIGH_LOADED_MS and             (report.ping_ms is None or report.ping_ms <= HIGH_PING_MS):
        findings.append(_finding(
            'loaded_latency', 'Delay rises under load',
            f'The speed is fine, but the delay rises to {round(loaded)} ms while data is moving'
            + (f' ({round(report.ping_ms)} ms when idle)' if report.ping_ms is not None else '')
            + '. Queues fill up under load, so calls, video calls and games lag.',
            f'Check the queue and scheduler settings of the serving cell of {site_name} and the load on its '
            'transmission link; compare with a test on another site.',
            [f'ping during download {report.latency_down_ms} ms' if report.latency_down_ms is not None else '',
             f'ping during upload {report.latency_up_ms} ms' if report.latency_up_ms is not None else '',
             f'idle ping {report.ping_ms} ms' if report.ping_ms is not None else ''],
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

    # The customer's own calls around the problem time (2026-10-27,
    # core/call_cells.py): a fallback to 2G/3G or a weak signal at the end.
    call_found, calls_near = ([], 0)
    if report.category in ('call_drop', 'no_signal', 'other'):
        call_found, calls_near = call_findings(_customer_devices(report), report.happened_at, _finding)
        findings.extend(call_found)
    if report.category == 'call_drop' and not call_found:
        findings.append(_finding(
            'call_drop', 'Call drops cannot be seen in phone readings',
            (f'The phone recorded {calls_near} call{"" if calls_near == 1 else "s"} around that time; none fell back '
             'to 2G/3G or ended on a weak signal. ' if calls_near else '')
            + 'Phone readings show the signal, not why a call ended.',
            f'Check the call drop counters of the serving cell of {site_name} for that hour.',
            [_drop_line(load)],
        ))

    has_data = level is not None or at_time['readings'] or before['readings'] or dt['readings']
    if not has_data:
        findings.append(_finding(
            'no_data', 'No measurements near this spot',
            f'No phone measured within {WIDE_RADIUS_M // 1000} km in the {WIDE_DAYS} days before or after the '
            f'problem, and no drive test passed within {WIDE_RADIUS_M // 1000} km, so the cause cannot be told '
            'from the data.',
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

    if widened and findings[0]['kind'] != 'no_data':
        findings[0]['evidence'].append(
            f'from readings within {WIDE_RADIUS_M // 1000} km and {WIDE_DAYS} days either side; none within '
            f'{RADIUS_M} m in the week before')
    for f in findings:
        f['evidence'] = [e for e in f['evidence'] if e]

    return {
        'radius_m': radius_m,
        'baseline_days': BASELINE_DAYS,
        # True when nothing was within RADIUS_M in the week before and the
        # check used WIDE_RADIUS_M and WIDE_DAYS either side instead.
        'widened': widened,
        'wide_days': WIDE_DAYS,
        'phones_at_time': at_time,
        'phones_before': before,
        'drive_tests': dt,
        'serving': serving,
        'nearest_sites': nearest,
        'neighbours': heard,
        'cell_load': load,
        'findings': findings,
        'customer_reply': CUSTOMER_REPLY.get(findings[0]['kind'], CUSTOMER_REPLY['no_fault_found']),
    }


# A short reply an engineer can send the customer, by the first finding.
CUSTOMER_REPLY = {
    'weak_coverage': 'Thank you for telling us. The signal at your location is weak; our engineers are checking '
                     'the nearby tower to improve it.',
    'building_penetration': 'Thank you for telling us. The signal outside your building is good, but the walls '
                            'weaken it indoors. Near a window it is usually better; you can also turn on Wi-Fi '
                            'calling, or ask NTC about an indoor solution.',
    'interference': 'Thank you for telling us. We found a signal quality problem at your location and our '
                    'engineers are adjusting the nearby towers.',
    'stronger_neighbour': 'Thank you for telling us. Phones at your location stay on a weaker tower when a '
                          'stronger one is available; our engineers are adjusting how phones move between them.',
    'no_dominant_cell': 'Thank you for telling us. Several towers overlap at your location and disturb each other; '
                        'our engineers are adjusting them.',
    'slow_not_busy': 'Thank you for telling us. The network at your location had capacity to spare at that time; '
                     'please check your data pack and restart the phone. If it stays slow, our engineers will '
                     'check further.',
    'busy_cell': 'Thank you for telling us. The network at your location is busy at this time of day; we are '
                 'working to add capacity.',
    'loaded_latency': 'Thank you for telling us. Your connection is fast, but its delay rises while data is '
                      'moving, which makes calls and games lag. Our engineers are checking the tower and its '
                      'link.',
    'lower_tech': 'Thank you for telling us. 4G is available at your location. Please set your phone\'s network '
                  'mode to 4G/LTE and restart it. If it still stays on 3G, please visit an NTC service centre.',
    'lower_tech_weak_4g': 'Thank you for telling us. 4G coverage at your location is weak; our engineers are '
                          'looking at how to improve it.',
    'worse_than_usual': 'Thank you for telling us. We found a change in the network near you and our engineers '
                        'are checking it.',
    'call_fallback': 'Thank you for telling us. Your calls moved from 4G to an older network at your location; '
                     'our engineers are checking the towers there.',
    'call_weak_end': 'Thank you for telling us. The signal was weak where your calls ended; our engineers are '
                     'looking at the coverage there.',
    'call_drop': 'Thank you for telling us. Our engineers are checking the call records of the tower serving '
                 'your area.',
    'no_data': 'Thank you for telling us. Our engineers will measure the network at your location.',
    'no_fault_found': 'Thank you for telling us. We did not find a network fault at your location. Please tell '
                      'us the exact place and time the problem happens.',
}


# ── Saved cause and site, for the dashboard (2026-10-15) ───────────────────

# The finding kinds above, as the dashboard names them.
CAUSE_LABELS = {
    'weak_coverage': 'Weak signal',
    'building_penetration': 'Weak indoors, good outside',
    'interference': 'Good signal, poor quality',
    'stronger_neighbour': 'Stronger cell not used',
    'no_dominant_cell': 'No dominant cell',
    'busy_cell': 'Good signal, slow (busy cell)',
    'slow_not_busy': 'Slow, cell not busy',
    'loaded_latency': 'Delay rises under load',
    'lower_tech': 'Phone on 2G/3G where 4G is usable',
    'lower_tech_weak_4g': 'Little 4G here',
    'worse_than_usual': 'Worse than usual',
    'call_drop': 'Call drops (needs KPI)',
    'call_fallback': 'Calls fell back to 2G/3G',
    'call_weak_end': 'Calls ended on a weak signal',
    'no_data': 'No measurements nearby',
    'no_fault_found': 'No fault found',
}
# Phones upload their readings a few minutes late, and the check looks up to
# AT_TIME_HOURS after the problem; a report is worked out again once after this.
SETTLE_HOURS = AT_TIME_HOURS + 1
# Reports are classified in the background (classify_problem_reports, every
# few minutes); the dashboard spends at most this long on new ones itself.
CLASSIFY_PER_REQUEST = 60
DASHBOARD_CLASSIFY_SECONDS = 3
OVERDUE_HOURS = 48                  # a new report older than this is flagged
AREA_DEG = 0.005                    # about 500 m: reports with no site are grouped by this square


def classify_report(report, check=None):
    """Saves the check's main cause and the site it points at on the report.
    The check is worked out with every phone's readings (no operator filter),
    so the dashboard counts the same for everyone; a check made for an
    unrestricted user can be passed in to save working it out twice."""
    if check is None:
        check = check_report(report, None)
    serving, nearest = check.get('serving'), check.get('nearest_sites') or []
    if serving:
        site_id, site_by, sector = serving['site_id'], 'serving', serving.get('cell_name') or ''
    elif nearest:
        site_id, site_by, sector = nearest[0]['site_id'], 'nearest', ''
    else:
        site_id, site_by, sector = None, '', ''
    cause = check['findings'][0]['kind'] if check.get('findings') else ''
    # A new cause or site counts as a change for a linked system's "since" query.
    changed = (cause, site_id) != (report.cause, report.site_id)
    report.cause = cause
    report.site_id, report.site_by, report.sector = site_id, site_by, sector[:64]
    report.classified_at = timezone.now()
    report.save(update_fields=['cause', 'site', 'site_by', 'sector', 'classified_at']
                + (['updated_at'] if changed else []))
    if changed and cause:
        queue_update(report, 'cause')       # a linked system on Automatic hears of it


def _unsettled(now):
    """Reports not yet classified, or classified before their readings settled.
    An open report with no measurements nearby is looked at again once a day
    (2026-10-28): readings may have arrived since, or the check widened."""
    settle = timedelta(hours=SETTLE_HOURS)
    return Q(classified_at__isnull=True) | Q(
        classified_at__lt=F('happened_at') + settle, happened_at__lte=now - settle) | (
        Q(cause='no_data', classified_at__lt=now - timedelta(days=1)) & ~Q(status='closed'))


def classify_pending(seconds, since=None):
    """Classifies unsettled reports, newest first, for at most `seconds`
    (a check takes one to a few seconds). Returns how many were done. Run
    every few minutes by classify_problem_reports, and briefly by the
    dashboard so a new report shows up without waiting for the job."""
    now = timezone.now()
    qs = ProblemReport.objects.filter(_unsettled(now))
    if since is not None:
        qs = qs.filter(happened_at__gte=since)
    deadline = time.monotonic() + seconds
    done = 0
    for report in qs.order_by('-happened_at')[:CLASSIFY_PER_REQUEST]:
        if time.monotonic() >= deadline:
            break
        classify_report(report)
        done += 1
    return done


def _reported_place(data):
    """{'reported_lat', 'reported_lng'} from an entry, both or neither (2026-10-29)."""
    lat = _num(data.get('reported_lat'), -90, 90)
    lng = _num(data.get('reported_lng', data.get('reported_lon')), -180, 180)
    return {'reported_lat': lat, 'reported_lng': lng} if lat is not None and lng is not None else {}


SHARE_MAX_HOURS = 72
SHARE_INTERVAL_S = 300


def start_customer_share(request, report, device):
    """Starts the customer's own sharing for a complaint: an accepted trace
    on their phone, labelled with the complaint, for up to SHARE_MAX_HOURS.
    It ends when the complaint is closed (`end_customer_share`), when the
    customer taps Stop, or at the limit. Returns what the phone needs."""
    from .collection import ensure_trace_session
    from .models import TraceRequest
    now = timezone.now()
    trace = TraceRequest.objects.create(
        device=device, msisdn=device.msisdn or '', kind=TraceRequest.KIND_INVESTIGATION,
        case_reference=complaint_labels(report)[0], status=TraceRequest.STATUS_ACCEPTED,
        consent_method=TraceRequest.CONSENT_APP, consent_at=now, policy_mode='customer_share',
        ttl_minutes=SHARE_MAX_HOURS * 60, expires_at=now + timedelta(hours=SHARE_MAX_HOURS),
    )
    ensure_trace_session(trace)
    log_audit_event(request, 'PROBLEM_REPORT.CUSTOMER_SHARE', resource='problem_report',
                    resource_id=str(report.pk), detail=f'trace={trace.id} hours={SHARE_MAX_HOURS}')
    return {'trace_id': str(trace.id), 'expires_at': trace.expires_at.isoformat(), 'interval_s': SHARE_INTERVAL_S}


def end_customer_share(report):
    """Ends the customer's own sharing when the complaint is closed. Returns how many ended."""
    from .models import TraceRequest
    if not report.device_id:
        return 0
    return TraceRequest.objects.filter(
        device_id=report.device_id, policy_mode='customer_share', status=TraceRequest.STATUS_ACCEPTED,
        case_reference__in=complaint_labels(report)[1],
    ).update(status=TraceRequest.STATUS_COMPLETED, ended_at=timezone.now())


def complaint_reference(report):
    """How a complaint is named on screens (2026-10-29: "Complaint ID 28";
    before it was "PR-28", Problem Report). A complaint from another NTC
    system keeps that system's ticket ("UTS 12345")."""
    if report.external_ref:
        return f'{report.external_system} {report.external_ref}'
    return f'Complaint ID {report.pk}'


def complaint_labels(report):
    """The label live requests and traces of a complaint carry, and the
    earlier form ("Complaint PR-28") they were found by before 2026-10-29."""
    ref = complaint_reference(report)
    label = (ref if ref.startswith('Complaint') else f'Complaint {ref}')[:120]
    return label, [label, f'Complaint PR-{report.pk}']


def is_staff(user):
    """NTC staff (admin and superadmin): on the Problem Dashboard and the
    diagnosis dashboard they see every subscriber detail except positions
    (decided by the user on 2026-10-27)."""
    return getattr(user, 'role', '') in ('admin', 'superadmin')


def _unrestricted(user):
    return not getattr(user, 'operator_mncs', None)


# ── Views ──────────────────────────────────────────────────────────────────


PROBLEM_DASHBOARD_PATH = '/r4q7cx'


def can_use_problem_dashboard(user):
    """Admin and superadmin, and any role a superadmin has given the Problem
    Dashboard menu item (2026-10-24): the menu's visibility is the
    permission, so there is one switch for the page and its API."""
    if not (user and user.is_authenticated):
        return False
    if user.role in ('superadmin', 'admin'):
        return True
    visible_top, visible_children = get_visible_menu_items(user)
    stack = list(visible_top)
    while stack:
        item = stack.pop()
        if item.path == PROBLEM_DASHBOARD_PATH:
            return True
        stack.extend(visible_children(item.id))
    return False


class CanUseProblemDashboard(BasePermission):
    def has_permission(self, request, view):
        return can_use_problem_dashboard(request.user)


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
        # Complaint registered location (2026-10-29); null when not known.
        'reported_lat': report.reported_lat, 'reported_lng': report.reported_lng,
        'network_type': report.network_type, 'band': report.band, 'pci': report.pci, 'cell_id': report.cell_id,
        'level_dbm': report.level_dbm, 'rsrq_db': report.rsrq_db, 'sinr_db': report.sinr_db,
        'download_mbps': report.download_mbps, 'upload_mbps': report.upload_mbps,
        'ping_ms': report.ping_ms, 'jitter_ms': report.jitter_ms, 'packet_loss_pct': report.packet_loss_pct,
        # Loaded latency and the four ratings of the report's speed test (2026-10-29).
        **speed_quality.fields(report.download_mbps, report.upload_mbps, report.ping_ms, report.jitter_ms,
                               report.packet_loss_pct, report.latency_down_ms, report.latency_up_ms),
        'phone_model': report.phone_model, 'android_version': report.android_version,
        'app_version': report.app_version,
        'environment': report.environment or None,
        'status': report.status,
        'engineer_note': report.engineer_note,
        'entered_by': report.entered_by.username if report.entered_by_id else None,
        'checked_by': report.checked_by.username if report.checked_by_id else None,
        'checked_at': report.checked_at.isoformat() if report.checked_at else None,
        'cause': report.cause,
        'cause_label': CAUSE_LABELS.get(report.cause, ''),
        'site_id': report.site_id,
        'site_by': report.site_by,
        'sector': report.sector,
        'external_system': report.external_system,
        'external_ref': report.external_ref,
        'located_by': report.located_by,
        # How the report is named on screens and as the profile's reference (2026-10-19).
        'reference': complaint_reference(report),
        'has_number': bool((report.device_id and report.device.msisdn) or report.msisdn),
    }
    # The list shows the number to NTC staff (admin and superadmin; widened
    # from superadmin by the user on 2026-10-27). One complaint opened on the
    # Problem Dashboard shows it to everyone who may use the dashboard, to
    # deal with that complaint (2026-10-24); the detail view logs it.
    if is_staff(user) or with_check:
        out['phone_number'] = (report.device.msisdn if report.device_id else None) or report.msisdn or None
    if with_check:
        out['notify'] = report_notify_info(report)
        out['check'] = check_report(report, user)
        # Opening a report also brings its saved cause and site up to date.
        classify_report(report, out['check'] if _unrestricted(user) else None)
        out.update(cause=report.cause, cause_label=CAUSE_LABELS.get(report.cause, ''),
                   site_id=report.site_id, site_by=report.site_by, sector=report.sector)
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
            # Sent from where the phone was: that is also where the complaint was registered.
            reported_lat=lat, reported_lng=lon,
            network_type=str(data.get('network_type') or '').upper()[:12],
            band=str(data.get('band') or '')[:24],
            pci=_int(data.get('pci'), 0, 1007), cell_id=_int(data.get('cell_id'), 0, 2 ** 36),
            level_dbm=_int(data.get('level_dbm'), -160, 0),
            rsrq_db=_int(data.get('rsrq_db'), -40, 10), sinr_db=_int(data.get('sinr_db'), -30, 50),
            download_mbps=_num(data.get('download_mbps'), 0, 10_000),
            upload_mbps=_num(data.get('upload_mbps'), 0, 10_000),
            ping_ms=_num(data.get('ping_ms'), 0, 60_000), jitter_ms=_num(data.get('jitter_ms'), 0, 60_000),
            latency_down_ms=_num(data.get('latency_down_ms'), 0, 60_000),
            latency_up_ms=_num(data.get('latency_up_ms'), 0, 60_000),
            packet_loss_pct=_num(data.get('packet_loss_pct'), 0, 100),
            phone_model=str(data.get('phone_model') or '')[:80],
            android_version=str(data.get('android_version') or '')[:16],
            app_version=str(data.get('app_version') or '')[:40],
            # Where the phone was (2026-10-26): outdoor / indoor / vehicle.
            environment=str(data.get('environment') or '') if data.get('environment') in ('outdoor', 'indoor', 'vehicle') else '',
        )
        for key in (day_key, all_key):
            cache.add(key, 0, timeout=86400)
            try:
                cache.incr(key)
            except ValueError:
                pass
        out = {'id': report.pk, 'stored': True}
        # "Share my location with NTC until this is fixed" (2026-10-29): the
        # customer starts it on the phone, so it begins accepted.
        if str(data.get('share_until_fixed', '')).lower() in ('1', 'true', 'yes'):
            out['share'] = start_customer_share(request, report, device)
        return Response(out, status=201)


def _search_q(q, user):
    from .rescue import _clean_msisdn
    from .subscriber_profile import number_variants
    cond = Q(external_ref__icontains=q) | Q(note__icontains=q)
    # "Complaint ID 28", "ID 28", "28", and the earlier "PR-28".
    digits = q.upper().strip()
    for prefix in ('COMPLAINT', 'ID', ':', '#', 'PR-', 'PR'):
        digits = digits.removeprefix(prefix).strip()
    if digits.isdigit() and len(digits) <= 9:
        cond |= Q(pk=int(digits))
    canonical = _clean_msisdn(q) if is_staff(user) else None
    if canonical:
        variants = number_variants(canonical)
        cond |= Q(msisdn__in=variants) | Q(device__msisdn__in=variants)
    return cond


class ProblemReportListView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request):
        qs = ProblemReport.objects.select_related('device', 'entered_by', 'checked_by')
        # cause, site and days come from the dashboard: one hotspot's reports (2026-10-15).
        for field in ('category', 'source', 'cause'):
            value = request.query_params.get(field)
            if value:
                qs = qs.filter(**{field: value})
        site = request.query_params.get('site')
        if site:
            qs = qs.filter(site_id=site)
        area = request.query_params.get('area')
        if area:
            try:
                lat0, lng0 = (float(v) for v in area.split(','))
            except ValueError:
                return Response({'detail': 'Unknown area.'}, status=400)
            qs = qs.filter(site__isnull=True, lat__gte=lat0, lat__lt=lat0 + AREA_DEG,
                           lng__gte=lng0, lng__lt=lng0 + AREA_DEG)
        days = _int(request.query_params.get('days'), 1, 3650)
        if days:
            qs = qs.filter(happened_at__gte=timezone.now() - timedelta(days=days))
        # Search (2026-10-19): a report number (PR-12 or 12), another
        # system's ticket, words of the note, or (superadmin, who alone sees
        # numbers) the customer's mobile number in any spelling.
        q = (request.query_params.get('q') or '').strip()[:60]
        if q:
            qs = qs.filter(_search_q(q, request.user))
        # Complaints tab (2026-10-28): a date range (days of the problem,
        # Nepal time), sorting, pages and a count per status. The counts
        # ignore the status filter, so the tiles above the list stay put.
        from .collection import NEPAL_TZ
        for key, lookup, extra in (('from', 'gte', 0), ('to', 'lt', 1)):
            raw = request.query_params.get(key)
            if raw:
                try:
                    day = datetime.strptime(raw[:10], '%Y-%m-%d').date() + timedelta(days=extra)
                except ValueError:
                    return Response({'detail': 'Dates are written as YYYY-MM-DD.'}, status=400)
                qs = qs.filter(**{f'happened_at__{lookup}': datetime.combine(day, datetime.min.time(), NEPAL_TZ)})
        counts = {k: 0 for k in ('new', 'checked', 'closed')}
        for row in qs.order_by().values('status').annotate(n=Count('id')):
            counts[row['status']] = row['n']
        counts['all'] = sum(counts.values())
        status_filter = request.query_params.get('status')
        if status_filter:
            qs = qs.filter(status=status_filter)
        order = {'oldest': ('happened_at', 'id'), 'status': ('status', '-happened_at'),
                 'cause': ('cause', '-happened_at')}.get(request.query_params.get('sort') or '', ('-happened_at', '-id'))
        qs = qs.order_by(*order)
        page = _int(request.query_params.get('page'), 1, 100000)
        if not page:
            return Response({'results': [_row(r, request.user) for r in qs[:500]], 'counts': counts})
        size = _int(request.query_params.get('page_size'), 1, 200) or 10
        total = qs.count()
        rows = qs[(page - 1) * size:page * size]
        return Response({'results': [_row(r, request.user) for r in rows], 'counts': counts, 'total': total,
                         'page': page, 'page_size': size})

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
        # The customer's mobile number (2026-10-19), optional; shown to
        # superadmin only and links the report to the Subscriber Profile.
        msisdn = ''
        if str(data.get('msisdn') or '').strip():
            from .rescue import _clean_msisdn
            msisdn = _clean_msisdn(data.get('msisdn')) or ''
            if not msisdn:
                return Response({'detail': 'That is not a mobile number.'}, status=400)
        report = ProblemReport.objects.create(
            source=ProblemReport.SOURCE_STAFF, entered_by=request.user, category=category,
            note=str(data.get('note') or '')[:MAX_NOTE_CHARS], happened_at=happened_at, lat=lat, lng=lng,
            msisdn=msisdn, **_reported_place(data),
        )
        log_audit_event(request, 'problem_report_create', resource='problem_report', resource_id=str(report.pk),
                        detail=f'entered a {category} problem')
        return Response(_row(report, request.user, with_check=True), status=201)


class ProblemReportDetailView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport.objects.select_related('device', 'entered_by', 'checked_by'), pk=pk)
        out = _row(report, request.user, with_check=True)
        if (out.get('phone_number') and request.user.role != 'superadmin'
                and cache.add(f'prnum:seen:{request.user.pk}:{pk}', 1, timeout=3600)):
            # Who saw a customer's number, and for which complaint (2026-10-24);
            # once an hour per person and complaint, as the page refetches.
            log_audit_event(request, 'PROBLEM_REPORT.NUMBER_VIEWED', resource='problem_report',
                            resource_id=str(pk), detail=f'reference={out["reference"]}')
        return Response(out)

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
            report.save(update_fields=fields + ['updated_at'])
            if status_value is not None:
                queue_update(report, 'status')   # a linked system on Automatic hears of it
            if report.status == 'closed':
                end_customer_share(report)       # "until this is fixed" (2026-10-29)
            log_audit_event(request, 'problem_report_update', resource='problem_report', resource_id=str(pk),
                            detail=f'status {report.status}')
        return Response({'id': report.pk, 'status': report.status})


# Days on the dashboard are Nepal's (UTC+5:45), not the server's UTC.
NEPAL_TZ = dt_timezone(timedelta(hours=5, minutes=45))


def _count(counter, key):
    counter[key] = counter.get(key, 0) + 1


def _ranked(counter, labels=None, top=None):
    rows = sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))
    if top:
        rows = rows[:top]
    return [{'key': k, 'label': (labels or {}).get(k, k), 'count': n} for k, n in rows]


class ProblemDashboardView(APIView):
    """Totals, causes, a map and the sites with the most reports (2026-10-15).

        GET /api/v2/problem-reports/dashboard/?days=30

    Reports are classified in the background; this spends at most
    DASHBOARD_CLASSIFY_SECONDS on any still waiting, and counts the rest in
    `pending`. No phone number is returned."""
    permission_classes = [CanUseProblemDashboard]

    def get(self, request):
        days = _int(request.query_params.get('days'), 1, 3650) or 30
        return Response(dashboard_data(days))


def dashboard_data(days, classify=True):
    """The dashboard's figures for the last `days` days. Also read by the
    summaries that need the same figures, with classify=False."""
    now = timezone.now()
    since = now - timedelta(days=days)
    window = ProblemReport.objects.filter(happened_at__gte=since)

    if classify:
        classify_pending(DASHBOARD_CLASSIFY_SECONDS, since=since)
    pending = window.filter(classified_at__isnull=True).count()

    reports = list(window.select_related('site').order_by('-happened_at'))
    categories = dict(ProblemReport.CATEGORIES)
    statuses = {'new': 0, 'checked': 0, 'closed': 0}
    sources, causes, cats, techs, bands, districts = {}, {}, {}, {}, {}, {}
    per_day = {}
    hours_to_check, overdue, oldest_open = [], 0, None
    spots = {}
    for r in reports:
        statuses[r.status] = statuses.get(r.status, 0) + 1
        _count(sources, r.external_system or r.get_source_display())
        _count(causes, r.cause or 'unchecked')
        _count(cats, r.category)
        _count(techs, _TECH.get(r.network_type) or ('Not known' if r.source == 'staff' else r.network_type or 'Not known'))
        if r.band:
            _count(bands, r.band)
        _count(districts, (r.site.district if r.site_id and r.site.district else 'Not known'))
        day = r.happened_at.astimezone(NEPAL_TZ).date().isoformat()
        per_day.setdefault(day, {})
        _count(per_day[day], r.category)
        if r.status == 'new':
            if oldest_open is None or r.created_at < oldest_open:
                oldest_open = r.created_at
            if now - r.created_at > timedelta(hours=OVERDUE_HOURS):
                overdue += 1
        elif r.checked_at:
            hours_to_check.append((r.checked_at - r.created_at).total_seconds() / 3600)

        if r.site_id:
            key = f'site:{r.site_id}'
            spot = spots.get(key) or spots.setdefault(key, {
                'key': key, 'kind': 'site', 'site_id': r.site_id, 'name': r.site.name,
                'district': r.site.district or '', 'lat': r.site.lat, 'lng': r.site.lng,
            })
        else:
            lat0 = math.floor(r.lat / AREA_DEG) * AREA_DEG
            lng0 = math.floor(r.lng / AREA_DEG) * AREA_DEG
            key = f'area:{lat0:.3f},{lng0:.3f}'
            spot = spots.get(key) or spots.setdefault(key, {
                'key': key, 'kind': 'area', 'site_id': None, 'name': f'Area near {lat0:.3f}, {lng0:.3f}',
                'district': '', 'lat': lat0 + AREA_DEG / 2, 'lng': lng0 + AREA_DEG / 2,
                'area': f'{lat0:.3f},{lng0:.3f}',
            })
        spot['count'] = spot.get('count', 0) + 1
        spot['open'] = spot.get('open', 0) + (r.status == 'new')
        spot.setdefault('causes', {})
        _count(spot['causes'], r.cause or 'unchecked')
        spot.setdefault('sectors', {})
        if r.sector:
            _count(spot['sectors'], r.sector)
        spot.setdefault('levels', []).append(r.level_dbm)
        if 'latest_at' not in spot:
            spot['latest_at'] = r.happened_at.isoformat()   # newest first

    cause_labels = dict(CAUSE_LABELS, unchecked='Not checked yet')
    hotspots = []
    top_spots = sorted(spots.values(), key=lambda s: (-s['count'], -s['open'], s['key']))[:25]
    # Busy-hour load of each hotspot site over the last week (2026-10-28, core/cell_kpi.py).
    from .cell_kpi import site_busy_days
    loads = site_busy_days({s['site_id'] for s in top_spots if s['site_id']})
    for spot in top_spots:
        top = max(spot['causes'].items(), key=lambda kv: kv[1])[0]
        hotspots.append({
            **{k: v for k, v in spot.items() if k not in ('causes', 'sectors', 'levels')},
            'top_cause': top, 'top_cause_label': cause_labels.get(top, top),
            'causes': _ranked(spot['causes'], cause_labels),
            'sectors': _ranked(spot['sectors'], top=5),
            'level_mean': _mean(spot['levels']),
            'cell_load': loads.get(spot['site_id']) if spot['site_id'] else None,
        })

    start_day = since.astimezone(NEPAL_TZ).date()
    series = []
    for i in range(days + 1):
        day = (start_day + timedelta(days=i)).isoformat()
        series.append({'date': day, **{k: per_day.get(day, {}).get(k, 0) for k in categories}})

    hours_to_check.sort()
    return {
        'days': days,
        'generated_at': now.isoformat(),
        'pending': pending,
        'totals': {
            'all': len(reports), **statuses,
            'app': sum(r.source == 'app' for r in reports), 'staff': sum(r.source == 'staff' for r in reports),
            'external': sum(r.source == 'external' for r in reports),
            'overdue': overdue, 'overdue_hours': OVERDUE_HOURS,
            'oldest_open_at': oldest_open.isoformat() if oldest_open else None,
            'median_hours_to_check': round(hours_to_check[len(hours_to_check) // 2], 1) if hours_to_check else None,
        },
        'categories': [{'key': k, 'label': v} for k, v in ProblemReport.CATEGORIES],
        'per_day': series,
        # Where reports came from: the app, staff, or each linked system by name.
        'by_source': _ranked(sources),
        'by_cause': _ranked(causes, cause_labels),
        'by_category': _ranked(cats, categories),
        'by_tech': _ranked(techs),
        'by_band': _ranked(bands, top=8),
        'by_district': _ranked(districts, top=10),
        'hotspots': hotspots,
        'points': [{
            'id': r.id, 'lat': r.lat, 'lng': r.lng, 'cause': r.cause, 'category': r.category,
            'status': r.status, 'happened_at': r.happened_at.isoformat(), 'site_id': r.site_id,
        } for r in reports[:3000]],
    }
