# LTE CQI estimated from SINR, stored per telemetry sample (2026-10-04).
# A separate column from `cqi`: `cqi` stays for a device-reported value,
# `cqi_derived` holds the server's SINR-based estimate for LTE rows.
# Columns only; existing rows stay NULL.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0095_telemetry_serving_cell'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='cqi_derived',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
    ]
