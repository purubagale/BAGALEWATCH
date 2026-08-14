# Schema migration — adds 4 free-text Sector columns (2026-08-09 follow-
# up: "need to store all those data also" — Carrier, Site Band, Cell
# Active Status, and a per-tech "Site Existence" flag, all real columns
# from the user's actual 3G/2G Sector Data source files that had nowhere
# to go before this). See Sector.carrier/site_band/cell_active_status/
# site_existence's docstring in models.py for why these stay plain text
# rather than a boolean/enum — the real value vocabulary isn't something
# to guess at.
#
# Plain AddField x4, no data migration needed — existing rows just get
# '' (blank=True/default='') in all four new columns, matching every
# other short text field on this model.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0021_sector_lat_sector_lng'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='carrier',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='sector',
            name='site_band',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='sector',
            name='cell_active_status',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='sector',
            name='site_existence',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
    ]
