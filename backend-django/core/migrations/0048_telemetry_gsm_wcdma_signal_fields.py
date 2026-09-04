# Proper RAN-standard 2G/3G signal metrics (2026-09-03) -- RSRP/RSRQ/SINR
# are LTE/NR-only, and RSSI alone isn't what a RAN engineer expects for
# 2G/3G. Adds:
#   - rx_qual: GSM RxQual class (TS 45.008/27.007 8.5, 0-7).
#   - rscp_dbm / ecio_db: WCDMA RSCP and Ec/Io (Android 10+ / API 29 only;
#     null on older devices, same as any other unsupported field).
# See core/models.py's TelemetrySample and the SDK's CellSampleCollector.kt
# / Sample.kt for where these are captured and sent.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0047_drive_test_consent_config'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='rx_qual',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='rscp_dbm',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='ecio_db',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
    ]
