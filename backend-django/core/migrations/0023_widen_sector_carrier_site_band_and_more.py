# Schema migration — widens carrier/site_band/cell_active_status/
# site_existence to max_length=255 (2026-08-10 real-world fix). The
# original 50/100-char caps from migration 0022 were guesses; a real
# 14,000-row 2G Sector Data upload hit Postgres's
# `StringDataRightTruncation: value too long for type character
# varying(50)` on the very first bulk_create — confirmed via a live
# traceback after adding proper LOGGING to settings.py (this endpoint
# writes with the ORM directly, bypassing SectorWriteSerializer's
# validation entirely, so an over-length value fails at the DB level,
# not as a clean 400). See Sector.carrier/site_band/cell_active_status/
# site_existence's docstring in models.py.
#
# Plain AlterField x4, no data migration needed — existing values are
# all well under 255 chars already (they fit in 50/100 before this).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0022_sector_carrier_site_band_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='sector',
            name='carrier',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AlterField(
            model_name='sector',
            name='site_band',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AlterField(
            model_name='sector',
            name='cell_active_status',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AlterField(
            model_name='sector',
            name='site_existence',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
