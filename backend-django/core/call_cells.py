"""Calls from phones put to use in analysis (2026-10-27).

Each `CallContextSample` names the cell a call started and ended on. Here
those cells are matched to a site and sector with the same rule as phone
readings (exact cell identity first, else PCI / code near the call's
position), and the calls feed:

  - `name_calls`: "KTM856 J3" next to each call on the VoLTE Quality page
    and the diagnosis dashboard's Calls card;
  - `sector_calls`: calls started per sector and how many fell back to
    2G/3G, for the sector tables;
  - `call_findings`: likely causes for a call-drop or voice complaint from
    the customer's own calls around the problem time.

A call record carries no end reason (Android gives an ordinary app none),
so "dropped" is never claimed; a fallback to 2G/3G or a weak signal when the
call ended is what the records can show.
"""
import logging
from collections import defaultdict
from datetime import timedelta

from .models import CallContextSample

logger = logging.getLogger(__name__)

CALL_WINDOW_HOURS = 3          # calls this close to a complaint are its evidence
CALL_WEAK_DBM = {'4G': -110, '3G': -105, '2G': -100}   # the problem check's weak limits
_TECH = {'LTE': '4G', 'NR': '4G', 'UMTS': '3G', 'GSM': '2G'}


def _match(rows):
    """rows: [(network_type, lat, lng, cell_id, tac, pci)] -> [(site_id, sector) | None]."""
    from .dt_serving_cell import attach_serving_cells
    from .telemetry import TELEMETRY_MATCH_MAX_KM
    out = [None] * len(rows)
    by_tech = defaultdict(list)
    for i, (net, lat, lng, cell_id, tac, pci) in enumerate(rows):
        tech = _TECH.get((net or '').upper())
        if tech is None or (cell_id is None and pci is None):
            continue
        probe = {'lat': lat, 'lng': lng, 'cell_id': cell_id, 'tac': tac,
                 'pci': pci if tech == '4G' else None, 'scrambling_code': pci if tech == '3G' else None,
                 'bcch': None, 'bsic': None}
        by_tech[tech].append((i, probe))
    for tech, pairs in by_tech.items():
        try:
            attach_serving_cells([p for _, p in pairs], tech, max_km=TELEMETRY_MATCH_MAX_KM)
        except Exception:
            logger.exception('call cell naming failed for %s', tech)
            continue
        for i, p in pairs:
            if p.get('serving_site_id'):
                out[i] = (p['serving_site_id'], p.get('serving_sector') or '')
    return out


def _label(match):
    return f'{match[0]} {match[1]}'.strip() if match else None


def name_calls(calls):
    """For call records: [(start label, end label)], e.g. ('KTM856 J3', None)."""
    calls = list(calls)
    starts = _match([(c.network_type, c.lat, c.lng, c.cell_id, c.tac, c.pci) for c in calls])
    ends = _match([(c.end_network_type, c.end_lat if c.end_lat is not None else c.lat,
                    c.end_lng if c.end_lng is not None else c.lng, c.end_cell_id, c.tac, c.end_pci) for c in calls])
    return [(_label(s), _label(e)) for s, e in zip(starts, ends)]


def sector_calls(device_ids, start=None, end=None):
    """{(site_id, sector): {'calls': n, 'fallback': n}} for calls the phones
    started between `start` and `end`, plus the count no sector took."""
    qs = CallContextSample.objects.filter(device_id__in=list(device_ids))
    if start is not None:
        qs = qs.filter(started_at__gte=start)
    if end is not None:
        qs = qs.filter(started_at__lte=end)
    rows = list(qs.values_list('network_type', 'lat', 'lng', 'cell_id', 'tac', 'pci', 'outcome')[:20000])
    out, unplaced = {}, 0
    for r, m in zip(rows, _match([r[:6] for r in rows])):
        if m is None:
            unplaced += 1
            continue
        e = out.setdefault(m, {'calls': 0, 'fallback': 0})
        e['calls'] += 1
        e['fallback'] += r[6] == 'fallback'
    return out, unplaced


def call_findings(device_ids, at, finding):
    """Likely causes from the customer's calls within CALL_WINDOW_HOURS of `at`.
    `finding(kind, title, cause, action, evidence)` builds one. Empty when
    there are no calls."""
    calls = list(CallContextSample.objects.filter(
        device_id__in=list(device_ids), started_at__gte=at - timedelta(hours=CALL_WINDOW_HOURS),
        started_at__lte=at + timedelta(hours=CALL_WINDOW_HOURS)).order_by('started_at'))
    if not calls:
        return [], 0
    names = name_calls(calls)
    out = []
    fell = [(c, n) for c, n in zip(calls, names) if c.outcome == 'fallback']
    if fell:
        cells = sorted({n[0] for _, n in fell if n[0]})
        where = ', '.join(cells) or 'the serving cell'
        out.append(finding(
            'call_fallback', 'Calls fell back to 2G/3G',
            f'{len(fell)} of {len(calls)} calls around the problem time moved from 4G to 2G/3G, which often '
            'comes with gaps or drops.',
            f'Check VoLTE coverage and the 4G-to-2G/3G (SRVCC) settings and neighbours of {where}.',
            [f'{len(fell)} of {len(calls)} calls fell back', f'started on {where}'],
        ))
    weak = []
    for c, n in zip(calls, names):
        tech = _TECH.get((c.end_network_type or c.network_type or '').upper())
        if tech and c.end_level_dbm is not None and c.end_level_dbm < CALL_WEAK_DBM[tech]:
            weak.append((c, n, tech))
    if weak:
        cells = sorted({(n[1] or n[0]) for _, n, _ in weak if (n[1] or n[0])})
        where = ', '.join(cells) or 'the serving cell'
        worst = min(c.end_level_dbm for c, _, _ in weak)
        out.append(finding(
            'call_weak_end', 'Calls ended on a weak signal',
            f'{len(weak)} of {len(calls)} calls around the problem time ended with a weak signal, the usual '
            'reason a call drops.',
            f'Check the coverage of {where} where the customer was; a drive test along the route helps.',
            [f'{len(weak)} of {len(calls)} calls ended weak', f'weakest {worst} dBm at the end', f'on {where}'],
        ))
    return out, len(calls)
