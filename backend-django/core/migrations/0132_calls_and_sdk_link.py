# Calls as an ordinary app sees them (2026-10-14, core/call_context.py):
# voice network, duration, serving cell and level, no quality figures.
# Also DeviceCredential.sdk_device_hash: a registered phone's SDK device id,
# so its signed uploads keep the identity its shared-key uploads had.

import django.contrib.gis.db.models.fields
from django.db import migrations, models

CLEAN_WCDMA_SQL = """
UPDATE v2_telemetry_samples SET rscp_dbm = NULL
 WHERE network_type = 'UMTS' AND rscp_dbm IS NOT NULL AND (rscp_dbm > -25 OR rscp_dbm < -125);
UPDATE v2_telemetry_samples SET rssi_dbm = NULL
 WHERE network_type = 'UMTS' AND rssi_dbm IS NOT NULL AND (rssi_dbm > -25 OR rssi_dbm < -125);
UPDATE v2_telemetry_samples SET ecio_db = NULL
 WHERE network_type = 'UMTS' AND ecio_db IS NOT NULL
   AND (ecio_db > 0 OR ecio_db < -30 OR (ecio_db = 0 AND rscp_dbm IS NULL));
"""


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0131_dt_retention'),
    ]

    operations = [
        migrations.CreateModel(
            name='CallContextSample',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('device_id', models.CharField(db_index=True, max_length=64)),
                ('started_at', models.DateTimeField(db_index=True)),
                ('ended_at', models.DateTimeField()),
                ('received_at', models.DateTimeField()),
                ('duration_s', models.IntegerField(blank=True, null=True)),
                ('voice_network_start', models.CharField(blank=True, default='', max_length=12)),
                ('voice_network_end', models.CharField(blank=True, default='', max_length=12)),
                ('voice_networks', models.CharField(blank=True, default='', max_length=80)),
                ('data_network_before', models.CharField(blank=True, default='', max_length=12)),
                ('outcome', models.CharField(choices=[('volte', 'VoLTE / VoNR'), ('vowifi', 'Wi-Fi calling'), ('fallback', 'Fell back to 2G/3G'), ('legacy', '2G/3G, no 4G before the call'), ('unknown', 'Unknown')], db_index=True, default='unknown', max_length=10)),
                ('lat', models.FloatField(blank=True, null=True)),
                ('lng', models.FloatField(blank=True, null=True)),
                ('location', django.contrib.gis.db.models.fields.PointField(blank=True, geography=True, null=True, srid=4326)),
                ('network_type', models.CharField(blank=True, default='', max_length=12)),
                ('cell_id', models.BigIntegerField(blank=True, null=True)),
                ('pci', models.IntegerField(blank=True, null=True)),
                ('tac', models.IntegerField(blank=True, null=True)),
                ('mcc', models.CharField(blank=True, default='', max_length=6)),
                ('mnc', models.CharField(blank=True, default='', max_length=6)),
                ('level_dbm', models.IntegerField(blank=True, null=True)),
                ('end_lat', models.FloatField(blank=True, null=True)),
                ('end_lng', models.FloatField(blank=True, null=True)),
                ('end_network_type', models.CharField(blank=True, default='', max_length=12)),
                ('end_cell_id', models.BigIntegerField(blank=True, null=True)),
                ('end_pci', models.IntegerField(blank=True, null=True)),
                ('end_level_dbm', models.IntegerField(blank=True, null=True)),
            ],
            options={
                'db_table': 'v2_call_context_samples',
                'indexes': [models.Index(fields=['device_id', 'started_at'], name='v2_call_ctx_device_started_idx')],
            },
        ),
        migrations.AddField(
            model_name='devicecredential',
            name='sdk_device_hash',
            field=models.CharField(blank=True, db_index=True, default='', max_length=32),
        ),
        # 3G readings already stored with the modem's no-value codes (RSCP or
        # RSSI above -25 dBm, Ec/Io 0 with no usable level): cleared, the way
        # core.telemetry._wcdma_levels now clears them on arrival.
        migrations.RunSQL(CLEAN_WCDMA_SQL, migrations.RunSQL.noop),
    ]
