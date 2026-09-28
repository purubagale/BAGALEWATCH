# Hand-authored migration (2026-09-27), same convention as 0068/0061/0054/
# 0057/0060/0066 for when a live container isn't available to run a real
# `makemigrations` against. Two plain nullable FloatFields for the antenna
# wedge visualization feature ("how can we use its [KML] data to show
# antenna orientation, azimuth, beam power in graphical representation") --
# see Sector.beamwidth/Sector.radius's own comment in models.py.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0068_rf_kpi_and_site_tower_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='beamwidth',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='radius',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
