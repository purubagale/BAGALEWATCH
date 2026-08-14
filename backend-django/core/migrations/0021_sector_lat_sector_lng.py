# Schema migration — adds optional per-sector GPS override fields
# (2026-08-09 request: "sometimes same sites with multiple sectors may
# have different lat long location as sector expansion. manage this
# condition also in the system"). See Sector.lat/Sector.lng's docstring
# in models.py for the full reasoning — both null (every existing row,
# after this migration) means "inherits its parent Site's lat/lng",
# which every reader (Site Detail's mini-map, the main Sites map,
# exports) must treat as the fallback rather than as 0,0.
#
# Plain AddField, no data migration needed — existing rows just get
# NULL in both new columns, which is exactly the "no override" default.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0020_seed_dt_data_manager_submenus'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='lat',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='lng',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
