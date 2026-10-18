"""Serving-cell -> site attribution for Drive-Test samples.

Ported from v1's `_rsrpMatchServingCell` (bts_monitor.html ~7617): a
sample's serving cell is identified in the .trp / template data by its
physical-layer id (PCI for LTE, BCCH+BSIC for GSM, Scrambling Code for
UMTS), and that id is matched to a `Sector` row of the same id within a
distance cap. Where several sites use the id, `choose_sector` decides:
distance first, direction where distance does not settle it. The match writes
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


# How a reading is given to one of several sites that use the same id
# (2026-10-13). Distance comes first and is a hard limit; direction only
# refines the choice where distance does not settle it.
#
#   1. Only a site within the distance cap is a candidate at all.
#   2. The nearest candidate is taken on distance alone when the reading is
#      right beside it (side and back lobes serve there, so direction says
#      nothing), or when it is clearly nearer than the next one.
#   3. Otherwise distance is not enough. Among the candidates that are
#      about as near, the one whose sector points at the reading is taken.
#   4. If none of them points at it, or more than one does, the nearest is
#      kept and the choice is reported as uncertain.
#
# Before this the nearest site to the centre of a whole upload batch was
# given every reading on that id, so one site collected readings taken
# beside another site with the same PCI.
CLEAR_DISTANCE_RATIO = 0.6   # "clearly nearer": at most this share of the next candidate's distance
BESIDE_SITE_KM = 0.3         # this close to a site, distance alone decides
FACING_DEG = 60.0            # a sector points at a reading within this angle of its azimuth


def _bearing_deg(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_off(a, b):
    """Smallest angle between two compass directions, 0 to 180."""
    d = abs(a - b) % 360.0
    return 360.0 - d if d > 180.0 else d


def choose_sector(lat, lng, sectors, max_km=MATCH_MAX_KM):
    """The sector that served a reading at (lat, lng), out of `sectors`
    that all carry the reading's id. Returns (sector, km, uncertain), or
    (None, None, False) when no site is within `max_km`."""
    lat_window = max_km / 111.0     # one degree of latitude is about 111 km
    per_site = {}
    for sec in sectors:
        site = sec.site
        if abs(site.lat - lat) > lat_window:
            continue
        d = _haversine_km(lat, lng, site.lat, site.lng)
        if d > max_km:
            continue
        off = None
        if sec.azimuth is not None:
            off = angle_off(_bearing_deg(site.lat, site.lng, lat, lng), sec.azimuth)
        held = per_site.get(sec.site_id)
        # Two sectors of one site on the same id: keep the one that points at the reading.
        if held is None or (off is not None and (held[2] is None or off < held[2])):
            per_site[sec.site_id] = (d, sec, off)
    if not per_site:
        return None, None, False
    ranked = sorted(per_site.values(), key=lambda c: c[0])
    d1, nearest, _off = ranked[0]
    if len(ranked) == 1:
        return nearest, d1, False
    if d1 <= BESIDE_SITE_KM or d1 <= CLEAR_DISTANCE_RATIO * ranked[1][0]:
        return nearest, d1, False
    about_as_near = [c for c in ranked if c[0] * CLEAR_DISTANCE_RATIO < d1 or c[1] is nearest]
    facing = [c for c in about_as_near if c[2] is not None and c[2] <= FACING_DEG]
    if len(facing) == 1:
        return facing[0][1], facing[0][0], False
    return nearest, d1, True


def _candidate_key(tech, sec):
    """The same id `_sample_key` produces for a sample, read off a Sector."""
    if tech == '4G':
        return sec.pci
    if tech == '2G':
        return (sec.bcch, sec.bsic)
    if tech == '3G':
        return sec.scrambling_code
    return None


# A reading that names its cell is matched to that cell, whatever else
# shares its PCI (2026-10-13). On 4G the identity is eNodeB ID x 256 + cell
# ID; the eNodeB ID comes from the LTE engineering parameter file and the
# cell ID is the sector's local cell ID. The distance is still checked, far
# more loosely than for a PCI match, so that a wrong number in the site
# list cannot place a reading on the other side of the country.
EXACT_MAX_KM = 40.0


def cell_identity(enodeb_id, local_cell_id):
    """The 4G cell identity of a sector, or None when either part is missing."""
    if enodeb_id is None or local_cell_id is None or not 0 <= local_cell_id <= 255:
        return None
    return enodeb_id * 256 + local_cell_id


def _row_cell_identity(row):
    try:
        value = int(row.get('cell_id'))
    except (TypeError, ValueError):
        return None
    return value if value > 255 else None


# NTC numbers an eNodeB as a region digit followed by the site number
# (2026-10-19, the user's rule, checked on the local site list): eNodeB 1856
# is KTM856, 3172 is CDR172. Used when the site list has no eNodeB ID for a
# sector (about 4,000 of 24,000 4G sectors).
ENB_REGION = {1: 'KTM', 2: 'EDR', 3: 'CDR', 4: 'WDR', 5: 'MWDR', 6: 'FWDR'}


def site_of_enodeb(enodeb_id):
    """The site ID an eNodeB number stands for, or None."""
    if enodeb_id is None or not 1000 <= enodeb_id <= 6999:
        return None
    return f'{ENB_REGION[enodeb_id // 1000]}{enodeb_id % 1000:03d}'


def _placed(sec):
    return sec.site is not None and sec.site.lat is not None and sec.site.lng is not None


def sectors_by_cell_identity(identities):
    """{cell identity: Sector} for the 4G sectors that carry one of
    `identities`: by the sector's eNodeB ID, else by the site the eNodeB
    number stands for and the sector's local cell ID."""
    enodebs = {i >> 8 for i in identities}
    if not enodebs:
        return {}
    out = {}
    for sec in (Sector.objects.select_related('site')
                .filter(tech='4G', enodeb_id__in=enodebs, local_cell_id__isnull=False)):
        identity = cell_identity(sec.enodeb_id, sec.local_cell_id)
        if identity in identities and _placed(sec):
            out[identity] = sec
    missing = {i for i in identities if i not in out}
    by_site = {}
    for i in missing:
        site_id = site_of_enodeb(i >> 8)
        if site_id:
            by_site.setdefault(site_id, set()).add(i)
    if by_site:
        for sec in (Sector.objects.select_related('site')
                    .filter(tech='4G', site_id__in=by_site, local_cell_id__isnull=False)):
            for i in by_site[sec.site_id]:
                if (i & 0xFF) == sec.local_cell_id and _placed(sec):
                    out.setdefault(i, sec)
    return out


def sectors_of_sites(site_ids, tech='4G'):
    """{site ID: [Sector]} of one technology, for picking a sector by PCI."""
    out = {}
    for sec in Sector.objects.select_related('site').filter(tech=tech, site_id__in=site_ids):
        if _placed(sec):
            out.setdefault(sec.site_id, []).append(sec)
    return out


def _lac_ci(tech, row):
    """(LAC, CI) of a 2G/3G reading as the site list writes them, or None.
    A phone reports the full 3G cell ID (RNC x 65536 + CI); the list holds
    the 16-bit CI."""
    try:
        lac, ci = int(row.get('tac')), int(row.get('cell_id'))
    except (TypeError, ValueError):
        return None
    if lac <= 0 or ci <= 0:
        return None
    return (str(lac), str(ci & 0xFFFF if tech == '3G' else ci))


def sectors_by_lac_ci(tech, pairs):
    """{(LAC, CI): Sector} for 2G/3G sectors (2026-10-19). The CI alone
    repeats in every region (11431 is site 143 sector A in five of them);
    with the LAC it is unique."""
    if not pairs:
        return {}
    out = {}
    for sec in (Sector.objects.select_related('site')
                .filter(tech=tech, ci__in={c for _, c in pairs}, lac__in={l for l, _ in pairs})):
        key = (str(sec.lac).strip(), str(sec.ci).strip())
        if key in pairs and _placed(sec):
            out.setdefault(key, sec)
    return out


def attach_serving_cells(rows, tech, max_km=MATCH_MAX_KM, region_key=None):
    """Mutates `rows` (list of coerced sample dicts) in place: stamps the
    `serving_*` fields on every row whose serving cell resolves to a
    `Sector`, each row on its own position.

    A 4G row that carries the cell's own identity (`cell_id`) is matched to
    that cell exactly. Every other row is matched by its PCI (or BCCH and
    BSIC, or scrambling code) under `choose_sector`'s rule. Rows that do
    not resolve keep their NULL serving_* values. No-op when there is no
    sector data at all.

    `max_km` caps a PCI match (drive-test default 15 km; telemetry uses
    5 km). When `region_key` is given, the chosen site's province is also
    written to rows[i][region_key]."""
    if not rows:
        return

    def stamp(r, sec, km):
        site = sec.site
        r['serving_site_id'] = sec.site_id
        r['serving_site_name'] = site.name or sec.site_id
        r['serving_cell_name'] = sec.cell_name or None
        r['serving_sector'] = sec.sector or None
        r['serving_local_cell_id'] = sec.local_cell_id
        r['serving_dist_km'] = round(km, 3) if km is not None else None
        if region_key:
            r[region_key] = site.region or ''

    def km_to(r, sec):
        if r.get('lat') is None or r.get('lng') is None:
            return None
        return _haversine_km(r['lat'], r['lng'], sec.site.lat, sec.site.lng)

    # Exact matches first, with or without a position (2026-10-19): the 4G
    # cell identity (by eNodeB ID, else the site its number stands for, by
    # local cell ID, else by PCI within that site), and LAC + CI on 2G/3G.
    exact = {}
    if tech == '4G':
        by_identity = sectors_by_cell_identity({_row_cell_identity(r) for r in rows} - {None})
        derived = {}
        for i, r in enumerate(rows):
            ident = _row_cell_identity(r)
            if ident is None:
                continue
            if ident in by_identity:
                exact[i] = by_identity[ident]
            elif site_of_enodeb(ident >> 8) and r.get('pci') is not None:
                derived[i] = site_of_enodeb(ident >> 8)
        if derived:
            site_sectors = sectors_of_sites(set(derived.values()))
            for i, site_id in derived.items():
                same_pci = [s for s in site_sectors.get(site_id, ()) if s.pci == rows[i].get('pci')]
                # The list can hold one sector twice (site list row and
                # engineering-parameter row): one sector name is one match.
                if same_pci and len({s.sector for s in same_pci}) == 1:
                    exact[i] = max(same_pci, key=lambda s: (s.local_cell_id is not None, bool(s.cell_name)))
    elif tech in ('2G', '3G'):
        keys = {i: _lac_ci(tech, r) for i, r in enumerate(rows)}
        by_lac_ci = sectors_by_lac_ci(tech, set(keys.values()) - {None})
        exact = {i: by_lac_ci[k] for i, k in keys.items() if k in by_lac_ci}

    by_pci = []
    for i, r in enumerate(rows):
        sec = exact.get(i)
        if sec is not None:
            km = km_to(r, sec)
            if km is None or km <= EXACT_MAX_KM:
                stamp(r, sec, km)
                continue
        if r.get('lat') is not None and r.get('lng') is not None:
            by_pci.append(i)

    wanted = {i: _sample_key(tech, rows[i]) for i in by_pci}
    wanted = {i: k for i, k in wanted.items() if k is not None and (not isinstance(k, tuple) or None not in k)}
    if not wanted:
        return
    candidates = _candidate_sectors(tech, set(wanted.values()))
    if not candidates:
        return
    by_key = defaultdict(list)
    for sec in candidates:
        by_key[_candidate_key(tech, sec)].append(sec)

    # A drive takes many readings a few metres apart: the choice is made
    # once per id and spot of about 100 m, the distance per reading.
    chosen = {}
    for i, key in wanted.items():
        r = rows[i]
        spot = (key, round(r['lat'], 3), round(r['lng'], 3))
        if spot not in chosen:
            chosen[spot] = choose_sector(spot[1], spot[2], by_key.get(key, ()), max_km)[0]
        sec = chosen[spot]
        if sec is None:
            continue
        km = _haversine_km(r['lat'], r['lng'], sec.site.lat, sec.site.lng)
        if km <= max_km:
            stamp(r, sec, km)


def attach_serving_cells_per_sample(rows, tech, max_km, region_key=None):
    """Kept for the telemetry caller. Every reading is matched on its own
    position now, so this is the same as `attach_serving_cells`."""
    attach_serving_cells(rows, tech, max_km=max_km, region_key=region_key)
