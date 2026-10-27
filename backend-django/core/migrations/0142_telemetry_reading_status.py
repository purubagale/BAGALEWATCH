# 2026-10-26. Why a phone reading has or lacks a cell: the service state,
# why the cell list was empty, flight mode and the SIM state, sent by app
# builds from this date (SDK collector/RadioStatus.kt). All nullable, so
# readings stored before stay as they are and are judged from their network
# and position instead (core/telemetry_status.py). v2_telemetry_samples is
# partitioned; ADD COLUMN on the parent reaches every partition.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0141_subscriber_diagnosis_menu'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample', name='service_state',
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='cell_info_status',
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='airplane_mode',
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='sim_state',
            field=models.CharField(blank=True, max_length=10, null=True),
        ),
    ]
