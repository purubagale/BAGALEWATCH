# Schema migration — widens sector/tech from max_length=20 to 100, and
# cell_name from max_length=100 to 255 (2026-08-10 real-world fix, same
# live-traceback debugging session as migration 0023). A real 14,000-row
# 2G Sector Data upload hit Postgres's `StringDataRightTruncation: value
# too long for type character varying(20)` — the only two CharFields
# still capped at 20 after 0023 widened carrier/site_band/
# cell_active_status/site_existence. cell_name is widened pre-emptively
# alongside them (not from a confirmed overflow on that specific column)
# since the same real-world files have now overflowed two "should be
# short" column groups in a row. See Sector.cell_name/sector/tech's
# docstring in models.py.
#
# Plain AlterField x3, no data migration needed — existing values are
# all well under the new limits already (they fit in the old, narrower
# ones before this).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0023_widen_sector_carrier_site_band_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='sector',
            name='cell_name',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AlterField(
            model_name='sector',
            name='sector',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AlterField(
            model_name='sector',
            name='tech',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
    ]
