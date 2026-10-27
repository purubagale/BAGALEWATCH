"""Neighbour cells heard with a phone reading (2026-10-27).

The app sends, with each reading, the other cells the phone heard at that
moment (SDK model/NeighbourCells.kt: serving technology first, strongest
first, at most 8). They are stored on the reading itself
(`TelemetrySample.neighbours`, JSON), so they are pruned with it and need no
table of their own.

Kept in check here too, whatever a client sends:
  - at most MAX_STORED cells, each with an identity (PCI, scrambling code or
    BCCH) and a level in range; anything else is dropped;
  - only the known keys, integers only;
  - each cell is named at upload (site, sector, distance) by the same
    matcher as the serving cell, on the reading's position, so analysis
    reads names instead of matching again.

`session_summary()` turns a set of readings into one row per neighbour cell:
how often it was heard, its average and best level, and how often it was
clearly stronger than the serving cell of the same technology (a cell the
phone did not move to).
"""
import logging
from collections import defaultdict

from .models import Site

logger = logging.getLogger(__name__)

MAX_STORED = 8
STRONGER_DB = 3          # a neighbour this much above the serving cell counts as "stronger"
CROWD_DB = 5             # neighbours within this of the serving cell (or above) compete with it
CROWD_CELLS = 3          # this many competing neighbours: no dominant cell (pilot pollution)
SUMMARY_MAX_READINGS = 50_000
SUMMARY_MAX_ROWS = 60

_NETS = {'LTE', 'UMTS', 'GSM'}
_TECH = {'LTE': '4G', 'UMTS': '3G', 'GSM': '2G'}
# key: (low, high) for every integer the phone may send
_RANGES = {
    'pci': (0, 1007), 'psc': (0, 511), 'bcch': (0, 1023), 'bsic': (0, 63), 'arfcn': (0, 4_000_000),
    'band': (1, 512), 'cell_id': (0, 68_719_476_735), 'tac': (0, 16_777_215),
    'rsrp': (-156, -31), 'rsrq': (-43, 20), 'sinr': (-23, 40), 'rscp': (-125, -25), 'ecio': (-30, 0),
    'rssi': (-125, -25),
}
_LEVEL_KEY = {'LTE': 'rsrp', 'UMTS': 'rscp', 'GSM': 'rssi'}
_SERVING_LEVEL = {'LTE': 'rsrp_dbm', 'UMTS': 'rscp_dbm', 'GSM': 'rssi_dbm'}


def _int(v, low, high):
    if isinstance(v, bool) or v is None:
        return None
    try:
        x = int(float(v))
    except (TypeError, ValueError, OverflowError):
        return None
    return x if low <= x <= high else None


def _identity(c):
    return {'LTE': c.get('pci'), 'UMTS': c.get('psc'), 'GSM': c.get('bcch')}.get(c['net'])


def coerce(raw):
    """The phone's `neighbours` list -> a clean list, or None when nothing is usable."""
    if not isinstance(raw, list):
        return None
    out = []
    for item in raw[:MAX_STORED * 2]:
        if not isinstance(item, dict):
            continue
        net = str(item.get('net') or '').upper()
        if net not in _NETS:
            continue
        cell = {'net': net}
        for key, (low, high) in _RANGES.items():
            value = _int(item.get(key), low, high)
            if value is not None:
                cell[key] = value
        if _identity(cell) is None or cell.get(_LEVEL_KEY[net]) is None:
            continue
        out.append(cell)
        if len(out) >= MAX_STORED:
            break
    return out or None


def attach_sites(rows):
    """Names each neighbour of a coerced upload batch in place: `site`,
    `sector` and `km` from the reading's position. Never raises; a cell that
    cannot be placed keeps no name."""
    from .dt_serving_cell import attach_serving_cells
    from .telemetry import TELEMETRY_MATCH_MAX_KM
    by_tech = defaultdict(list)   # tech -> [(cell, matcher row)]
    for r in rows:
        for cell in r.get('neighbours') or ():
            probe = {'lat': r.get('lat'), 'lng': r.get('lng'), 'cell_id': cell.get('cell_id'),
                     'tac': cell.get('tac'), 'pci': cell.get('pci'), 'scrambling_code': cell.get('psc'),
                     'bcch': cell.get('bcch'), 'bsic': cell.get('bsic')}
            by_tech[_TECH[cell['net']]].append((cell, probe))
    for tech, pairs in by_tech.items():
        try:
            attach_serving_cells([p for _, p in pairs], tech, max_km=TELEMETRY_MATCH_MAX_KM)
        except Exception:
            logger.exception('neighbour naming failed for %s; stored without names', tech)
            continue
        for cell, probe in pairs:
            if probe.get('serving_site_id'):
                cell['site'] = probe['serving_site_id']
                if probe.get('serving_sector'):
                    cell['sector'] = probe['serving_sector']
                if probe.get('serving_dist_km') is not None:
                    cell['km'] = round(probe['serving_dist_km'], 2)


def label(cell):
    """'PCI 65', 'PSC 120', 'BCCH 42 / BSIC 12'."""
    net = cell.get('net')
    if net == 'LTE':
        return f"PCI {cell.get('pci')}"
    if net == 'UMTS':
        return f"PSC {cell.get('psc')}"
    bsic = cell.get('bsic')
    return f"BCCH {cell.get('bcch')}" + (f" / BSIC {bsic}" if bsic is not None else '')


def level(cell):
    return cell.get(_LEVEL_KEY.get(cell.get('net'), 'rsrp'))


def point_fields(neighbours, network_type, with_site=False):
    """For one reading on a chart: how many cells were heard and the
    strongest of the serving technology ('PCI 95 · -88 dBm', with its site
    when `with_site`)."""
    cells = neighbours or []
    same = [c for c in cells if c.get('net') == network_type and level(c) is not None]
    best = max(same, key=level) if same else None
    text = None
    if best is not None:
        text = f'{label(best)} · {level(best)} dBm'
        if with_site and best.get('site'):
            text += f" ({best['site']}{' ' + best['sector'] if best.get('sector') else ''})"
    return {'neighbour_count': len(cells), 'neighbour_best_dbm': level(best) if best else None,
            'neighbour_best': text}


def fields(neighbours):
    """The keys every reading list returns."""
    cells = neighbours or []
    return {'neighbours': cells or None, 'neighbour_count': len(cells)}


def session_summary(qs):
    """One row per neighbour cell heard in these readings (newest
    SUMMARY_MAX_READINGS with neighbours)."""
    total = qs.count()
    rows = list(
        qs.exclude(neighbours__isnull=True).order_by('-ts')
        .values_list('network_type', 'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'serving_site_id', 'serving_sector',
                     'neighbours')[:SUMMARY_MAX_READINGS]
    )
    agg = {}
    # Per reading: cells heard, and against the serving cell of the same
    # technology whether any was clearly stronger and how many competed.
    heard_total = same_tech_readings = any_stronger = crowded = 0
    for net, rsrp, rscp, rssi, srv_site, srv_sector, cells in rows:
        serving_level = {'LTE': rsrp, 'NR': rsrp, 'UMTS': rscp, 'GSM': rssi}.get(net)
        heard_total += len(cells or ())
        same = [level(c) for c in cells or () if c.get('net') == net and level(c) is not None]
        if serving_level is not None and same:
            same_tech_readings += 1
            any_stronger += max(same) >= serving_level + STRONGER_DB
            crowded += sum(1 for v in same if v >= serving_level - CROWD_DB) >= CROWD_CELLS
        for cell in cells or ():
            lvl = level(cell)
            if lvl is None or cell.get('net') not in _NETS:
                continue
            key = (cell['net'], cell.get('site') or '', cell.get('sector') or '', _identity(cell),
                   cell.get('arfcn'))
            a = agg.get(key)
            if a is None:
                a = agg[key] = {'cell': cell, 'n': 0, 'sum': 0, 'best': lvl, 'stronger': 0, 'same_tech': 0,
                                'km_sum': 0.0, 'km_n': 0, 'serving_sites': defaultdict(int)}
            a['n'] += 1
            a['sum'] += lvl
            a['best'] = max(a['best'], lvl)
            if cell.get('km') is not None:
                a['km_sum'] += cell['km']
                a['km_n'] += 1
            if net == cell['net'] and serving_level is not None:
                a['same_tech'] += 1
                if lvl >= serving_level + STRONGER_DB:
                    a['stronger'] += 1
            if srv_site:
                a['serving_sites'][f"{srv_site} {srv_sector or ''}".strip()] += 1
    ordered = sorted(agg.values(), key=lambda a: -a['n'])[:SUMMARY_MAX_ROWS]
    names = dict(Site.objects.filter(id__in={a['cell'].get('site') for a in ordered} - {None})
                 .values_list('id', 'name'))
    out = []
    for a in ordered:
        c = a['cell']
        top_serving = max(a['serving_sites'].items(), key=lambda kv: kv[1])[0] if a['serving_sites'] else None
        out.append({
            'network_type': c['net'], 'tech': _TECH[c['net']], 'cell': label(c),
            'pci': c.get('pci'), 'psc': c.get('psc'), 'bcch': c.get('bcch'), 'bsic': c.get('bsic'),
            'arfcn': c.get('arfcn'), 'band': c.get('band'),
            'site_id': c.get('site'), 'site_name': names.get(c.get('site')) or None, 'sector': c.get('sector'),
            'heard': a['n'], 'level_avg': round(a['sum'] / a['n'], 1), 'level_best': a['best'],
            'stronger': a['stronger'], 'same_tech': a['same_tech'],
            'stronger_pct': round(100.0 * a['stronger'] / a['same_tech'], 1) if a['same_tech'] else None,
            'dist_km_avg': round(a['km_sum'] / a['km_n'], 2) if a['km_n'] else None,
            'mostly_beside': top_serving,
        })
    return {
        'cells': out, 'readings': total, 'with_neighbours': len(rows),
        'capped_readings': len(rows) >= SUMMARY_MAX_READINGS, 'capped_rows': len(agg) > SUMMARY_MAX_ROWS,
        'stronger_db': STRONGER_DB, 'crowd_db': CROWD_DB, 'crowd_cells': CROWD_CELLS,
        **_shares(len(rows), heard_total, same_tech_readings, any_stronger, crowded, len(agg)),
    }


def _shares(with_neighbours, heard_total, same_tech, any_stronger, crowded, cells):
    pct = lambda a: round(100.0 * a / same_tech, 1) if same_tech else None  # noqa: E731
    return {
        'cells_count': cells,
        'avg_cells_heard': round(heard_total / with_neighbours, 1) if with_neighbours else None,
        'same_tech_readings': same_tech,
        'stronger_readings': any_stronger, 'stronger_readings_pct': pct(any_stronger),
        'crowded_readings': crowded, 'crowded_readings_pct': pct(crowded),
    }


def counts_only(summary):
    """The summary without any cell, site or sector: for pages where which
    sites reached a person is location history (the diagnosis dashboard
    outside an emergency)."""
    return {k: v for k, v in summary.items() if k != 'cells'} | {'cells': [], 'names_hidden': True}
