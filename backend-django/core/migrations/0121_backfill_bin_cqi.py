# Data migration (2026-10-12) -- fills cqi_mean on the coverage bins that
# have none. Until this date the roll-ups averaged only the CQI a phone
# reports itself, which is almost always empty, so the Telemetry Coverage
# CQI map was grey although the sample tables showed estimated values. The
# roll-ups now average core.cqi.sample_cqi_sql(); this recomputes the
# existing bins from the raw samples still stored. A bin whose samples
# have already been dropped by retention stays empty: there is nothing
# left to compute it from. Bins that already hold a value are not touched.
from django.db import migrations

from core.cqi import sample_cqi_sql

_BACKFILL_SQL = """
UPDATE v2_telemetry_coverage_bins AS b
SET cqi_mean = s.cqi_mean
FROM (
  SELECT ST_GeoHash(location::geometry, 7) AS gh, network_type, mnc, avg(__CQI__) AS cqi_mean
  FROM v2_telemetry_samples
  WHERE location IS NOT NULL
  GROUP BY 1, 2, 3
) AS s
WHERE b.geohash = s.gh
  AND b.network_type = s.network_type
  AND b.mnc IS NOT DISTINCT FROM s.mnc
  AND b.cqi_mean IS NULL
  AND s.cqi_mean IS NOT NULL
"""


def backfill(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(_BACKFILL_SQL.replace('__CQI__', sample_cqi_sql()))


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0120_sitephoto_drive_session'),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
