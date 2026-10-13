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

A reading counts for the sector it was matched to at upload
(core/dt_serving_cell.py). One that could not be matched to a site is not
here at all, so an empty answer means "no matched readings", not "no
coverage".

    GET /api/v2/sites/<site id>/measured-coverage/
"""
from collections import defaultdict

from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Sector, Site, TelemetrySample
from .telemetry import _scope_by_operator
from .telemetry_level import sample_level

# One square is about 55 m on a side.
GRID_DEG = 0.0005
MAX_SQUARES = 4000
MAX_PHONE_READINGS = 20000

_DT_SQUARES_SQL = f"""
    SELECT COALESCE(serving_cell_name, ''), COALESCE(serving_sector, ''),
           round(lat / {GRID_DEG})::int, round(lng / {GRID_DEG})::int,
           avg(rsrp), count(*)
    FROM v2_dt_samples
    WHERE serving_site_id = %s AND lat IS NOT NULL AND lng IS NOT NULL AND cell_role <> 'neighbor'
    GROUP BY 1, 2, 3, 4
"""
_DT_REACH_SQL = """
    SELECT COALESCE(serving_cell_name, ''), COALESCE(serving_sector, ''), count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY serving_dist_km),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY serving_dist_km),
           max(serving_dist_km)
    FROM v2_dt_samples
    WHERE serving_site_id = %s AND serving_dist_km IS NOT NULL AND cell_role <> 'neighbor'
    GROUP BY 1, 2
"""


def _percentile(sorted_values, share):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * share))]


def _r(value, digits=2):
    return None if value is None else round(float(value), digits)


class SiteMeasuredCoverageView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, site_id):
        site = get_object_or_404(Site, pk=site_id)
        directory = {}
        for s in Sector.objects.filter(site=site).values('cell_name', 'sector', 'tech', 'azimuth'):
            directory[(s['cell_name'] or '').strip().lower()] = s

        squares = []
        per_sector = defaultdict(lambda: {'drive_test': 0, 'phone': 0, 'p50_km': None, 'p90_km': None, 'max_km': None})

        def key_of(cell_name, sector):
            return (cell_name or '').strip() or (sector or '').strip() or 'unknown'

        with connection.cursor() as cursor:
            cursor.execute(_DT_SQUARES_SQL, [site.pk])
            for cell_name, sector, glat, glng, level, n in cursor.fetchall():
                squares.append({
                    'key': key_of(cell_name, sector), 'source': 'drive_test',
                    'lat': round(glat * GRID_DEG, 5), 'lng': round(glng * GRID_DEG, 5),
                    'level': _r(level, 1), 'n': n,
                })
            cursor.execute(_DT_REACH_SQL, [site.pk])
            for cell_name, sector, n, p50, p90, far in cursor.fetchall():
                entry = per_sector[key_of(cell_name, sector)]
                entry.update(drive_test=n, p50_km=_r(p50), p90_km=_r(p90), max_km=_r(far))
                entry.setdefault('sector', sector)

        phone_included = request.user.role in ('admin', 'superadmin')
        if phone_included:
            rows = _scope_by_operator(
                TelemetrySample.objects.filter(serving_site_id=site.pk, lat__isnull=False, lng__isnull=False),
                request.user,
            ).values_list('serving_cell_name', 'serving_sector', 'lat', 'lng', 'network_type',
                          'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'serving_dist_km')[:MAX_PHONE_READINGS]
            grid = defaultdict(lambda: [0, 0.0, 0])        # count, level sum, level count
            distances = defaultdict(list)
            for cell_name, sector, lat, lng, net, rsrp, rscp, rssi, dist in rows.iterator(chunk_size=5000):
                key = key_of(cell_name, sector)
                cell = grid[(key, round(lat / GRID_DEG), round(lng / GRID_DEG))]
                cell[0] += 1
                level = sample_level(net, rsrp, rscp, rssi)
                if level is not None:
                    cell[1] += level
                    cell[2] += 1
                if dist is not None:
                    distances[key].append(dist)
                per_sector[key]['phone'] += 1
            for (key, glat, glng), (n, total, counted) in grid.items():
                squares.append({
                    'key': key, 'source': 'phone',
                    'lat': round(glat * GRID_DEG, 5), 'lng': round(glng * GRID_DEG, 5),
                    'level': _r(total / counted, 1) if counted else None, 'n': n,
                })
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

        sectors = []
        for key, entry in per_sector.items():
            known = directory.get(key.lower())
            sectors.append({
                'key': key,
                'cell_name': known['cell_name'] if known else '',
                'sector': (known['sector'] if known else entry.get('sector')) or '',
                'tech': known['tech'] if known else '',
                'azimuth': known['azimuth'] if known else None,
                'drive_test_readings': entry['drive_test'],
                'phone_readings': entry['phone'],
                'p50_km': entry['p50_km'], 'p90_km': entry['p90_km'], 'max_km': entry['max_km'],
            })
        sectors.sort(key=lambda s: -(s['drive_test_readings'] + s['phone_readings']))
        return Response({
            'site': site.pk, 'square_m': 55, 'sectors': sectors, 'squares': squares,
            'truncated': truncated, 'phone_readings_included': phone_included,
        })
