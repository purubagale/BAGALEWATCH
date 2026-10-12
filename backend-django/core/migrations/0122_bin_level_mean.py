# 2026-10-12 -- adds level_mean to the coverage bins and fills it in.
#
# A bin's rsrp_mean is empty for 3G and 2G, which report RSCP and RSSI
# instead, so those bins had no level and the coverage map drew them grey.
# level_mean is the mean of whichever level the bin's technology reports
# (core/telemetry_level.py). For 4G and 5G bins it equals rsrp_mean and is
# copied from it. For 3G and 2G bins it is recomputed from the raw samples
# still stored; a bin whose samples retention has already dropped stays
# empty.
from django.db import migrations

import core.models
from core.telemetry_level import LEVEL_SQL

_COPY_SQL = """
UPDATE v2_telemetry_coverage_bins
SET level_mean = rsrp_mean
WHERE level_mean IS NULL AND rsrp_mean IS NOT NULL AND network_type NOT IN ('UMTS', 'GSM')
"""

_BACKFILL_SQL = f"""
UPDATE v2_telemetry_coverage_bins AS b
SET level_mean = s.level_mean
FROM (
  SELECT ST_GeoHash(location::geometry, 7) AS gh, network_type, mnc, avg({LEVEL_SQL}) AS level_mean
  FROM v2_telemetry_samples
  WHERE location IS NOT NULL AND network_type IN ('UMTS', 'GSM')
  GROUP BY 1, 2, 3
) AS s
WHERE b.geohash = s.gh
  AND b.network_type = s.network_type
  AND b.mnc IS NOT DISTINCT FROM s.mnc
  AND b.level_mean IS NULL
  AND s.level_mean IS NOT NULL
"""


def backfill(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(_COPY_SQL)
        cursor.execute(_BACKFILL_SQL)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0121_backfill_bin_cqi'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrycoveragebin',
            name='level_mean',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
