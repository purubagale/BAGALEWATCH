# Data migration (2026-10-12) -- recomputes cqi_mean on coverage bins after
# the RSRQ-based CQI estimate got a floor of 1 (core.cqi, rsrq_min_cqi).
# Before that a connected LTE reading at RSRQ -17 dB or worse counted as
# CQI 0 and pulled the bin average down. Only a bin whose raw samples are
# all still stored is recomputed: once retention has dropped part of them,
# an average over the rest would not be the bin's average any more, so
# such a bin keeps the value it has.
from django.db import migrations

from core.cqi import sample_cqi_sql

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


def recompute(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(_RECOMPUTE_SQL.replace('__CQI__', sample_cqi_sql()))


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0122_bin_level_mean'),
    ]

    operations = [
        migrations.RunPython(recompute, migrations.RunPython.noop),
    ]
