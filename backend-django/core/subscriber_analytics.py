"""Analysis of one number's readings for the Subscriber Profile (2026-10-16).

Patterns taken from NTC's ticketing system (UTS) the user showed: the cells
and sites a customer used, shares by network, a daily trend and usage by
time of day. Here they are built from the phone's own measured readings, so
each also carries signal quality, which the network-side view lacks.

Everything is aggregated in the database and holds no exact position: cells
and sites served are masts, which the profile always shows (the rule agreed
for the location lookups). Phones with withdrawn rescue consent are left out
by the caller, as for the signal history.

Weak / fair / good use the problem check's limits (problem_report.WEAK_DBM,
GOOD_DBM) so "weak" means the same on every page.
"""
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.db.models import Avg, Case, Count, F, FloatField, IntegerField, Max, Min, Q, When
from django.db.models.functions import Cast, ExtractHour, Floor, TruncDate

from . import radio_band
from .models import Site, TelemetrySample
from .problem_report import GOOD_DBM, WEAK_DBM
from .sector_stats import telemetry_sectors
from .telemetry_status import status_breakdown

NEPAL = ZoneInfo('Asia/Kathmandu')
CELLS_MAX = 60
DAYS = 90

_TECH = {'LTE': '4G', 'NR': '4G', 'UMTS': '3G', 'GSM': '2G'}
_LEVEL_FIELD = {'4G': 'rsrp_dbm', '3G': 'rscp_dbm', '2G': 'rssi_dbm'}
_NETS = {'4G': ('LTE', 'NR'), '3G': ('UMTS',), '2G': ('GSM',)}


def _level():
    return Case(
        When(network_type='UMTS', then=F('rscp_dbm')),
        When(network_type='GSM', then=F('rssi_dbm')),
        default=F('rsrp_dbm'), output_field=IntegerField(),
    )


def _class_q(limits, below):
    """Readings whose level is below (weak) or at least (good) the limit of their technology."""
    q = Q()
    for tech, nets in _NETS.items():
        key = f'{_LEVEL_FIELD[tech]}__{"lt" if below else "gte"}'
        q |= Q(network_type__in=nets, **{key: limits[tech]})
    return q


WEAK_Q = _class_q(WEAK_DBM, below=True)
GOOD_Q = _class_q(GOOD_DBM, below=False)


def _round(v, digits=1):
    return round(v, digits) if v is not None else None


def profile_analytics(ids, include_location=False, qs=None):
    """The analysis block of the profile for these device ids.

    The cells and sites served are the customer's location history, so
    (decided by the user on 2026-10-19) they are given only with
    `include_location`, i.e. while an emergency is declared; otherwise only
    their counts are. `qs` narrows it to the readings the signal history
    shows (same range, session and technology; 2026-10-19)."""
    if qs is None:
        qs = TelemetrySample.objects.filter(device_id__in=ids)
    if not ids or not qs.exists():
        return None
    level = _level()

    # ── Quality per technology: weak / fair / good / no level ─────────────
    per_net = list(qs.values('network_type').annotate(
        n=Count('id'), weak=Count('id', filter=WEAK_Q), good=Count('id', filter=GOOD_Q),
        level=Avg(level), rsrq=Avg('rsrq_db'), sinr=Avg('sinr_db'),
        with_level=Count('id', filter=Q(network_type__in=('LTE', 'NR'), rsrp_dbm__isnull=False)
                         | Q(network_type='UMTS', rscp_dbm__isnull=False)
                         | Q(network_type='GSM', rssi_dbm__isnull=False)),
    ).order_by('-n'))
    networks = [{
        'network_type': r['network_type'], 'readings': r['n'], 'weak': r['weak'], 'good': r['good'],
        'fair': max(0, r['with_level'] - r['weak'] - r['good']), 'no_level': r['n'] - r['with_level'],
        'level_avg': _round(r['level']), 'rsrq_avg': _round(r['rsrq']), 'sinr_avg': _round(r['sinr']),
    } for r in per_net]

    # ── Cells and sites served (UTS "cell sites visited", with quality) ──
    cell_rows = list(qs.exclude(cell_id__isnull=True, pci__isnull=True).values(
        'network_type', 'cell_id', 'pci', 'tac', 'serving_site_id', 'serving_sector', 'serving_cell_name',
    ).annotate(
        n=Count('id'), level=Avg(level), rsrq=Avg('rsrq_db'), sinr=Avg('sinr_db'),
        weak=Count('id', filter=WEAK_Q), first=Min('ts'), last=Max('ts'),
        band=Max('band'), band_mhz=Max('band_mhz'), dist=Avg('serving_dist_km'),
    ).order_by('-n')[:CELLS_MAX])
    site_ids = {r['serving_site_id'] for r in cell_rows if r['serving_site_id']}
    site_rows = list(qs.exclude(serving_site_id='').exclude(serving_site_id__isnull=True)
                     .values('serving_site_id').annotate(n=Count('id'), weak=Count('id', filter=WEAK_Q),
                                                         level=Avg(level)).order_by('-n')[:CELLS_MAX])
    site_ids |= {r['serving_site_id'] for r in site_rows}
    site_info = {s['id']: s for s in Site.objects.filter(id__in=site_ids).values('id', 'name', 'district', 'lat', 'lng')}
    cells = [{
        'network_type': r['network_type'], 'cell_id': r['cell_id'], 'pci': r['pci'], 'tac': r['tac'],
        'site_id': r['serving_site_id'] or None, 'sector': r['serving_sector'] or None,
        'cell_name': r['serving_cell_name'] or None,
        'site_name': (site_info.get(r['serving_site_id']) or {}).get('name') or None,
        'district': (site_info.get(r['serving_site_id']) or {}).get('district') or None,
        'band_label': radio_band.label(r['network_type'], r['band'], r['band_mhz']) or None,
        'readings': r['n'], 'weak': r['weak'], 'level_avg': _round(r['level']), 'rsrq_avg': _round(r['rsrq']),
        'sinr_avg': _round(r['sinr']), 'dist_km_avg': _round(r['dist'], 2),
        'first': r['first'].isoformat(), 'last': r['last'].isoformat(),
    } for r in cell_rows]
    sites = [{
        'site_id': r['serving_site_id'], 'readings': r['n'], 'weak': r['weak'], 'level_avg': _round(r['level']),
        'name': (site_info.get(r['serving_site_id']) or {}).get('name') or None,
        'district': (site_info.get(r['serving_site_id']) or {}).get('district') or None,
        'lat': (site_info.get(r['serving_site_id']) or {}).get('lat'),
        'lng': (site_info.get(r['serving_site_id']) or {}).get('lng'),
    } for r in site_rows]

    # ── Daily trend, last DAYS days with readings (Nepal time) ────────────
    newest = qs.aggregate(m=Max('ts'))['m']
    day_rows = (qs.filter(ts__gte=newest - timedelta(days=DAYS))
                .annotate(day=TruncDate('ts', tzinfo=NEPAL)).values('day', 'network_type')
                .annotate(n=Count('id'), weak=Count('id', filter=WEAK_Q), level=Avg(level)).order_by('day'))
    days = {}
    for r in day_rows:
        d = days.setdefault(r['day'].isoformat(), {'day': r['day'].isoformat(), 'by_network': {}, 'readings': 0,
                                                   'weak': 0, '_lsum': 0.0, '_ln': 0})
        d['by_network'][r['network_type']] = r['n']
        d['readings'] += r['n']
        d['weak'] += r['weak']
        if r['level'] is not None:
            d['_lsum'] += r['level'] * r['n']
            d['_ln'] += r['n']
    daily = []
    for d in days.values():
        d['level_avg'] = _round(d['_lsum'] / d['_ln']) if d['_ln'] else None
        del d['_lsum'], d['_ln']
        daily.append(d)

    # ── Time of day (Nepal time) ──────────────────────────────────────────
    hour_rows = (qs.annotate(hour=ExtractHour('ts', tzinfo=NEPAL)).values('hour')
                 .annotate(n=Count('id'), weak=Count('id', filter=WEAK_Q), level=Avg(level)).order_by('hour'))
    hours = [{'hour': r['hour'], 'readings': r['n'], 'weak': r['weak'], 'level_avg': _round(r['level'])}
             for r in hour_rows]

    # ── Histograms ────────────────────────────────────────────────────────
    def histogram(field_expr, step, nets, extra_filter=Q()):
        rows = (qs.filter(network_type__in=nets).filter(extra_filter)
                .annotate(v=Cast(field_expr, FloatField()))
                .exclude(v__isnull=True)
                .annotate(b=Floor(F('v') / step) * step)
                .values('b').annotate(n=Count('id')).order_by('b'))
        return [{'from': int(r['b']), 'to': int(r['b']) + step, 'readings': r['n']} for r in rows]

    histograms = {
        'level': {tech: histogram(level, 5, nets) for tech, nets in _NETS.items()},
        'rsrq': histogram(F('rsrq_db'), 2, _NETS['4G']),
        'sinr': histogram(F('sinr_db'), 3, _NETS['4G']),
    }

    # ── Bands seen (4G and 5G) ────────────────────────────────────────────
    bands = [{
        'network_type': r['network_type'], 'band_label': radio_band.label(r['network_type'], r['band'], r['band_mhz']),
        'readings': r['n'], 'weak': r['weak'], 'level_avg': _round(r['level']),
    } for r in qs.filter(network_type__in=('LTE', 'NR')).exclude(band__isnull=True)
        .values('network_type', 'band', 'band_mhz')
        .annotate(n=Count('id'), weak=Count('id', filter=WEAK_Q), level=Avg(level)).order_by('-n')]

    # ── Per serving sector (2026-10-19, core/sector_stats.py) ─────────────
    by_sector = telemetry_sectors(qs)

    return {
        'networks': networks, 'daily': daily, 'hours': hours, 'histograms': histograms, 'bands': bands,
        # Readings without a network, split by what they mean (2026-10-26):
        # no coverage, flight mode / no SIM, or not measured by the phone.
        'no_network': status_breakdown(qs),
        # Outdoors / indoors / in a vehicle (2026-10-26); '' = not tagged.
        'environments': {(r['environment'] or ''): r['n'] for r in
                         qs.values('environment').annotate(n=Count('id')).order_by()},
        # Sectors served are location history too: emergency only; the count always.
        'sectors': by_sector['sectors'] if include_location else [],
        'sectors_count': len(by_sector['sectors']), 'sectors_unmatched': by_sector['unmatched'],
        'limits': {'weak_dbm': WEAK_DBM, 'good_dbm': GOOD_DBM},
        # Location history: in an emergency only; the counts always.
        'location_shown': include_location,
        'cells': cells if include_location else [],
        'sites': sites if include_location else [],
        'cells_count': len(cell_rows), 'sites_count': len(site_rows),
        'cells_capped': len(cell_rows) >= CELLS_MAX,
    }
