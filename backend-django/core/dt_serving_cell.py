"""Serving-cell -> site attribution for Drive-Test samples.

Ported from v1's `_rsrpMatchServingCell` (bts_monitor.html ~7617): a
sample's serving cell is identified in the .trp / template data by its
physical-layer id (PCI for LTE, BCCH+BSIC for GSM, Scrambling Code for
UMTS), and that id is matched to a `Sector` row of the same id whose
parent `Site` is the nearest one within a distance cap. The match writes
`serving_site_id / serving_cell_name / serving_sector /
serving_local_cell_id / serving_dist_km` onto each sample (columns that
have existed on DriveTestSample since Phase 4a but were never populated
until now).

Runs at upload time — the internal write paths call `attach_serving_cells`
on each coerced batch before the COPY insert, the same incremental
per-batch shape `_nearby_site_ids` already uses. A whole session has only
~8-20 distinct serving cells, so this is a handful of small `Sector`
lookups per batch, not per-sample work.

Requires `Sector` rows carrying `pci` / `bcch` / `bsic` /
`scrambling_code` and a parent `Site` with lat/lng — i.e. the site
directory must be imported. With no sector data every sample is simply
left unattributed (serving_* stays NULL); nothing errors.
"""
import math
from collections import defaultdict

from .models import Sector

# Same 15 km ceiling v1 used for LTE. A real serving link is almost always
# well under this; the cap exists to reject a spurious same-id match on
# the far side of the country when the true serving sector isn't in the
# directory at all.
MATCH_MAX_KM = 15.0


def _haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _sample_key(tech, row):
    """The physical-cell id used to match this sample's serving cell,
    per tech. Returns None when the row lacks it (that sample stays
    unattributed)."""
    if tech == '4G':
        return row.get('pci')
    if tech == '2G':
        b, s = row.get('bcch'), row.get('bsic')
        return (b, s) if b is not None and s is not None else None
    if tech == '3G':
        return row.get('scrambling_code')
    return None


def _candidate_sectors(tech, keys):
    """All `Sector` rows (with parent site coords) whose id matches ANY of
    `keys` — one query for the whole batch, not one per cell."""
    qs = Sector.objects.select_related('site')
    if tech == '4G':
        qs = qs.filter(pci__in=[k for k in keys if k is not None])
    elif tech == '2G':
        bcchs = {k[0] for k in keys}
        bsics = {k[1] for k in keys}
        qs = qs.filter(bcch__in=bcchs, bsic__in=bsics)
    elif tech == '3G':
        qs = qs.filter(scrambling_code__in=[k for k in keys if k is not None])
    else:
        return []
    out = []
    for sec in qs:
        site = sec.site
        if site is None or site.lat is None or site.lng is None:
            continue
        out.append(sec)
    return out


def _match_for_key(tech, key, centroid, candidates):
    """Nearest same-id sector's site to `centroid`, within MATCH_MAX_KM.
    `candidates` is the pre-fetched batch-wide list."""
    clat, clng = centroid
    best, best_km = None, MATCH_MAX_KM
    for sec in candidates:
        if tech == '4G' and sec.pci != key:
            continue
        if tech == '2G' and (sec.bcch, sec.bsic) != key:
            continue
        if tech == '3G' and sec.scrambling_code != key:
            continue
        d = _haversine_km(clat, clng, sec.site.lat, sec.site.lng)
        if d < best_km:
            best, best_km = sec, d
    if best is None:
        return None
    return {
        'serving_site_id': best.site_id,
        'serving_site_name': (best.site.name or best.site_id),
        'serving_cell_name': (best.cell_name or None),
        'serving_sector': (best.sector or None),
        'serving_local_cell_id': best.local_cell_id,
        'site_lat': best.site.lat,
        'site_lng': best.site.lng,
    }


def attach_serving_cells(rows, tech):
    """Mutates `rows` (list of coerced sample dicts) in place: stamps the
    `serving_*` fields on every row whose serving cell resolves to a
    `Sector`. `serving_dist_km` is that row's own GPS distance to the
    matched site (it varies along the drive within one cell). Rows that
    don't resolve keep their NULL serving_* values. No-op when there is
    no sector data at all."""
    if not rows:
        return
    by_key = defaultdict(list)
    for i, r in enumerate(rows):
        k = _sample_key(tech, r)
        if k is not None and r.get('lat') is not None and r.get('lng') is not None:
            by_key[k].append(i)
    if not by_key:
        return
    candidates = _candidate_sectors(tech, by_key.keys())
    if not candidates:
        return
    for key, idxs in by_key.items():
        clat = sum(rows[i]['lat'] for i in idxs) / len(idxs)
        clng = sum(rows[i]['lng'] for i in idxs) / len(idxs)
        m = _match_for_key(tech, key, (clat, clng), candidates)
        if m is None:
            continue
        for i in idxs:
            r = rows[i]
            r['serving_site_id'] = m['serving_site_id']
            r['serving_site_name'] = m['serving_site_name']
            r['serving_cell_name'] = m['serving_cell_name']
            r['serving_sector'] = m['serving_sector']
            r['serving_local_cell_id'] = m['serving_local_cell_id']
            r['serving_dist_km'] = round(
                _haversine_km(r['lat'], r['lng'], m['site_lat'], m['site_lng']), 3
            )
