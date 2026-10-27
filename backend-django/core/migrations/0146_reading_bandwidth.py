# 2026-10-27. Channel bandwidth of a phone reading, in kHz: the serving
# cell's, the sum over every carrier in use, and the number of carriers (see
# core/radio_band.py resolve_bandwidth). Null on existing rows: the app did
# not send it before. v2_telemetry_samples is partitioned; ADD COLUMN on the
# parent reaches every partition.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0145_reading_environment'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample', name='bandwidth_khz',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='total_bandwidth_khz',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='carrier_count',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
    ]
