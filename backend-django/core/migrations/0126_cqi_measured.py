# CQI, 2026-10-13. Two things that belong together.
#
# 1. `DriveTestSample.cqi_estimated`: marks a drive-test CQI that the upload
#    page filled in from SINR. Existing rows are marked here for every
#    session that came from a TEMS .trp log, since those logs carry no CQI
#    at all; a session from an Excel export keeps its CQI as measured.
#
# 2. The RSRQ step table of core/cqi.py was refitted to measured CQI (see
#    the note there), so the stored coverage-bin averages are recomputed,
#    the same way as in 0123 and 0124: only a bin whose raw samples are all
#    still stored.
from django.db import migrations, models

from core.cqi import sample_cqi_sql

_MARK_SQL = """
UPDATE v2_dt_samples AS d
SET cqi_estimated = true
FROM v2_dt_sessions AS s
WHERE d.session_id = s.id
  AND d.cqi IS NOT NULL
  AND (s.meta::text ILIKE '%%.trp%%' OR s.name ILIKE '%%trp%%')
"""

_RECOMPUTE_SQL = """
UPDATE v2_telemetry_coverage_bins AS b
SET cqi_mean = s.cqi_mean
FROM (
  SELECT ST_GeoHash(location::geometry, 7) AS gh, network_type, mnc,
         avg(__CQI__) AS cqi_mean, count(*) AS n
  FROM v2_telemetry_samples
  WHERE location IS NOT NULL
  GROUP BY 1, 2, 3
) AS s
WHERE b.geohash = s.gh
  AND b.network_type = s.network_type
  AND b.mnc IS NOT DISTINCT FROM s.mnc
  AND s.n >= b.sample_count
  AND s.cqi_mean IS NOT NULL
  AND b.cqi_mean IS DISTINCT FROM s.cqi_mean
"""


def mark_and_recompute(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(_MARK_SQL)
        cursor.execute(_RECOMPUTE_SQL.replace('__CQI__', sample_cqi_sql()))


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0125_telemetry_sample_band'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsample',
            name='cqi_estimated',
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(mark_and_recompute, migrations.RunPython.noop),
    ]
