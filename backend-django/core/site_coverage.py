"""Where a site's sectors were actually received (2026-10-13).

The wedges on a site's map are a diagram: a direction from the site list
and a width and length that are the same for every sector on a band. This
module gives the measured picture to set beside it: every stored reading
whose serving cell was matched to this site, gathered into small squares
on the ground and summed up per sector.

Two sources:

  * drive-test readings (DriveTestSample), for anyone who can open the site;
  * phone readings (TelemetrySample), for admin and superadmin only, as on
    the other pages that show phone data. They are averaged per square, and
    no device is named or counted.

A reading counts for the sector it was matched to (core/dt_serving_cell.py).
One that could not be matched to a site is not here at all, so an empty
answer means "no matched readings", not "no coverage".

Per sector the answer also says how well the readings agree with the
stored azimuth: the share that lie where the sector points, and the
direction the readings centre on. It is a check for an engineer to read,
never a correction: nothing here changes an azimuth or a tilt. Three kinds
of reading are drawn but left out of that check, because they say nothing
about direction:

  * within BESIDE_SITE_KM of the site, where side and back lobes serve;
  * weaker than the technology's WEAK level, which is not service;
  * uncertain, where another site uses the same id and neither distance
    nor direction settles which of the two served the reading.

    GET /api/v2/sites/<site id>/measured-coverage/[?session=<drive test id>]
"""
import math
from collections import defaultdict

from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .dt_serving_cell import (
    BESIDE_SITE_KM, FACING_DEG, MATCH_MAX_KM, _bearing_deg, _candidate_key, _candidate_sectors, _haversine_km,
    angle_off, cell_identity, choose_sector,
)
from .models import DriveTestSession, Sector, SectorConfigChange, Site, TelemetrySample
from .telemetry import TELEMETRY_MATCH_MAX_KM, _scope_by_operator
from .telemetry_level import sample_level

# One square is about 55 m on a side.
GRID_DEG = 0.0005
MAX_SQUARES = 4000
MAX_PHONE_READINGS = 20000
# Below this a reading is not counted in the direction check.
WEAK_DBM = {'4G': -110.0, '3G': -105.0, '2G': -100.0}
# The check is reported only on this many readings, and flagged when the
# readings centre this far from the stored azimuth.
DIRECTION_MIN_READINGS = 100
DIRECTION_FLAG_DEG = 30.0

_DT_SQUARES_SQL = f"""
    SELECT COALESCE(serving_cell_name, ''), COALESCE(serving_sector, ''),
           round(lat / {GRID_DEG})::int, round(lng / {GRID_DEG})::int,
           avg(rsrp), count(*), count(cell_id), min(cell_id), max(cell_id)
    FROM v2_dt_samples
    WHERE serving_site_id = %s AND lat IS NOT NULL AND lng IS NOT NULL AND cell_role <> 'neighbor' __SESSION__
    GROUP BY 1, 2, 3, 4
"""
_DT_REACH_SQL = """
    SELECT COALESCE(serving_cell_name, ''), COALESCE(serving_sector, ''), count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY serving_dist_km),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY serving_dist_km),
           max(serving_dist_km)
    FROM v2_dt_samples
    WHERE serving_site_id = %s AND serving_dist_km IS NOT NULL AND cell_role <> 'neighbor' __SESSION__
    GROUP BY 1, 2
"""
_DT_SESSIONS_SQL = """
    SELECT session_id, count(*) FROM v2_dt_samples
    WHERE serving_site_id = %s AND cell_role <> 'neighbor' GROUP BY 1
"""


def _percentile(sorted_values, share):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * share))]


def _r(value, digits=2):
    return None if value is None else round(float(value), digits)


def direction_check(azimuth, bearings):
    """`bearings` is a list of (bearing in degrees, readings). Returns the
    share lying within FACING_DEG of `azimuth`, the direction the readings
    centre on, and how far that is from the azimuth; or None when there
    are too few readings or no azimuth."""
    total = sum(n for _b, n in bearings)
    if azimuth is None or total < DIRECTION_MIN_READINGS:
        return None
    inside = sum(n for b, n in bearings if angle_off(b, azimuth) <= FACING_DEG)
    x = sum(n * math.sin(math.radians(b)) for b, n in bearings)
    y = sum(n * math.cos(math.radians(b)) for b, n in bearings)
    # Readings spread all round the site have no centre worth naming.
    spread_out = math.hypot(x, y) / total < 0.3
    centre = None if spread_out else (math.degrees(math.atan2(x, y)) + 360.0) % 360.0
    off = None if centre is None else angle_off(centre, azimuth)
    return {
        'readings': total,
        'in_direction_pct': int(round(100.0 * inside / total)),
        'centre_deg': None if centre is None else int(round(centre)),
        'off_azimuth_deg': None if off is None else int(round(off)),
        'differs': bool(off is not None and off > DIRECTION_FLAG_DEG) or (centre is None and inside / total < 0.5),
    }


class SiteMeasuredCoverageView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, site_id):
        site = get_object_or_404(Site, pk=site_id)
        try:
            session_id = int(request.query_params['session']) if request.query_params.get('session') else None
        except ValueError:
            session_id = None
        session_sql = ' AND session_id = %s' if session_id else ''
        params = [site.pk] + ([session_id] if session_id else [])

        own = list(Sector.objects.filter(site=site).select_related('site'))
        directory = {(s.cell_name or '').strip().lower(): s for s in own}
        # Every sector, here or at another site, that shares an id with one of this site's.
        rivals = {}
        for tech in {s.tech for s in own}:
            keys = {_candidate_key(tech, s) for s in own if s.tech == tech}
            keys = {k for k in keys if k is not None and (not isinstance(k, tuple) or None not in k)}
            if not keys:
                continue
            for sec in _candidate_sectors(tech, keys):
                if sec.tech == tech:
                    rivals.setdefault((tech, _candidate_key(tech, sec)), []).append(sec)

        def uncertain_at(sector, lat, lng, max_km):
            """True when this reading's site cannot be told from another that uses the same id."""
            if sector is None:
                return False
            chosen, _km, unsure = choose_sector(
                lat, lng, rivals.get((sector.tech, _candidate_key(sector.tech, sector)), ()), max_km)
            return unsure or (chosen is not None and chosen.site_id != site.pk)

        squares = []
        per_sector = defaultdict(lambda: {
            'drive_test': 0, 'phone': 0, 'uncertain': 0, 'p50_km': None, 'p90_km': None, 'max_km': None,
            'bearings': [], 'sector': '',
        })

        def key_of(cell_name, sector):
            return (cell_name or '').strip() or (sector or '').strip() or 'unknown'

        def add_square(key, source, glat, glng, level, n, max_km, exact=False):
            lat, lng = round(glat * GRID_DEG, 5), round(glng * GRID_DEG, 5)
            sector = directory.get(key.lower())
            # `exact`: every reading in the square named this very cell.
            unsure = False if exact else uncertain_at(sector, lat, lng, max_km)
            squares.append({'key': key, 'source': source, 'lat': lat, 'lng': lng,
                            'level': _r(level, 1), 'n': n, 'uncertain': unsure})
            entry = per_sector[key]
            if unsure:
                entry['uncertain'] += n
                return
            if site.lat is None or site.lng is None or sector is None:
                return
            origin = (sector.lat or site.lat, sector.lng or site.lng)
            if _haversine_km(origin[0], origin[1], lat, lng) < BESIDE_SITE_KM:
                return
            if level is None or level < WEAK_DBM.get(sector.tech, -110.0):
                return
            entry['bearings'].append((_bearing_deg(origin[0], origin[1], lat, lng), n))

        with connection.cursor() as cursor:
            cursor.execute(_DT_SQUARES_SQL.replace('__SESSION__', session_sql), params)
            for cell_name, sector, glat, glng, level, n, named, low, high in cursor.fetchall():
                key = key_of(cell_name, sector)
                known = directory.get(key.lower())
                identity = cell_identity(known.enodeb_id, known.local_cell_id) if known else None
                exact = identity is not None and named == n and low == high == identity
                add_square(key, 'drive_test', glat, glng, level, n, MATCH_MAX_KM, exact=exact)
            cursor.execute(_DT_REACH_SQL.replace('__SESSION__', session_sql), params)
            for cell_name, sector, n, p50, p90, far in cursor.fetchall():
                entry = per_sector[key_of(cell_name, sector)]
                entry.update(drive_test=n, p50_km=_r(p50), p90_km=_r(p90), max_km=_r(far), sector=sector)
            cursor.execute(_DT_SESSIONS_SQL, [site.pk])
            counts = dict(cursor.fetchall())
        sessions = [
            {'id': s.id, 'name': s.name, 'date': s.date.isoformat() if s.date else '', 'readings': counts[s.id]}
            for s in DriveTestSession.objects.filter(id__in=counts).order_by('-date', '-id')
        ]

        # Phone readings belong to no drive test, so they are left out when one is chosen.
        phone_included = request.user.role in ('admin', 'superadmin') and not session_id
        if phone_included:
            rows = _scope_by_operator(
                TelemetrySample.objects.filter(serving_site_id=site.pk, lat__isnull=False, lng__isnull=False),
                request.user,
            ).values_list('serving_cell_name', 'serving_sector', 'lat', 'lng', 'network_type',
                          'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'serving_dist_km', 'cell_id')[:MAX_PHONE_READINGS]
            grid = defaultdict(lambda: [0, 0.0, 0, 0])     # count, level sum, level count, named this cell
            distances = defaultdict(list)
            for cell_name, sector, lat, lng, net, rsrp, rscp, rssi, dist, named in rows.iterator(chunk_size=5000):
                key = key_of(cell_name, sector)
                cell = grid[(key, round(lat / GRID_DEG), round(lng / GRID_DEG))]
                cell[0] += 1
                known = directory.get(key.lower())
                if known and named is not None and named == cell_identity(known.enodeb_id, known.local_cell_id):
                    cell[3] += 1
                level = sample_level(net, rsrp, rscp, rssi)
                if level is not None:
                    cell[1] += level
                    cell[2] += 1
                if dist is not None:
                    distances[key].append(dist)
                per_sector[key]['phone'] += 1
            for (key, glat, glng), (n, total, counted, named) in grid.items():
                add_square(key, 'phone', glat, glng, total / counted if counted else None, n,
                           TELEMETRY_MATCH_MAX_KM, exact=named == n)
            # A sector with no drive test takes its reach from the phone readings.
            for key, values in distances.items():
                entry = per_sector[key]
                if entry['p50_km'] is None:
                    values.sort()
                    entry.update(p50_km=_r(_percentile(values, 0.5)), p90_km=_r(_percentile(values, 0.9)),
                                 max_km=_r(values[-1]))

        truncated = len(squares) > MAX_SQUARES
        if truncated:
            # Keep the squares with the most readings behind them.
            squares.sort(key=lambda s: -s['n'])
            squares = squares[:MAX_SQUARES]

        # An antenna change is on record for these sectors. The record carries
        # no date that can be compared, so it is passed on as a caution only.
        changed = {}
        for c in (SectorConfigChange.objects.filter(sector__site=site)
                  .select_related('report').order_by('-created_at')):
            changed.setdefault(c.sector_id, {
                'report': c.report.title or c.report.lot_name, 'period': c.report.period_covered,
                'change': c.after_change,
            })

        sectors = []
        for key, entry in per_sector.items():
            known = directory.get(key.lower())
            others = sorted({
                sec.site_id for sec in rivals.get((known.tech, _candidate_key(known.tech, known)), ())
                if sec.site_id != site.pk and sec.site.lat is not None and site.lat is not None
                and _haversine_km(site.lat, site.lng, sec.site.lat, sec.site.lng) <= 2 * MATCH_MAX_KM
            }) if known else []
            sectors.append({
                'key': key,
                'cell_name': known.cell_name if known else '',
                'sector': (known.sector if known else entry['sector']) or '',
                'tech': known.tech if known else '',
                'azimuth': known.azimuth if known else None,
                'drive_test_readings': entry['drive_test'],
                'phone_readings': entry['phone'],
                'uncertain_readings': entry['uncertain'],
                'same_id_sites': others[:5],
                'p50_km': entry['p50_km'], 'p90_km': entry['p90_km'], 'max_km': entry['max_km'],
                'direction': direction_check(known.azimuth if known else None, entry['bearings']),
                'antenna_change': changed.get(known.pk) if known else None,
            })
        sectors.sort(key=lambda s: -(s['drive_test_readings'] + s['phone_readings']))
        return Response({
            'site': site.pk, 'square_m': 55, 'sectors': sectors, 'squares': squares,
            'truncated': truncated, 'phone_readings_included': phone_included,
            'sessions': sessions, 'session': session_id,
            'direction_rules': {
                'facing_deg': int(FACING_DEG), 'beside_site_m': int(BESIDE_SITE_KM * 1000),
                'min_readings': DIRECTION_MIN_READINGS, 'flag_deg': int(DIRECTION_FLAG_DEG),
            },
        })
