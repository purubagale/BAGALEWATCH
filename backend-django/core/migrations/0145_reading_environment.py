# 2026-10-26. Outdoors, inside a building or in a vehicle: on phone readings
# (with who said so), on drive-test sessions (drive / walk outdoors / walk
# indoors) and on problem reports. All empty or null on existing rows.
# v2_telemetry_samples is partitioned; ADD COLUMN on the parent reaches every
# partition.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0144_speedtest_settings'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample', name='environment',
            field=models.CharField(blank=True, max_length=10, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample', name='environment_source',
            field=models.CharField(blank=True, max_length=10, null=True),
        ),
        migrations.AddField(
            model_name='drivetestsession', name='environment',
            field=models.CharField(blank=True, choices=[('drive', 'Drive (in a vehicle)'), ('walk_outdoor', 'Walk test outdoors'),
                                                        ('walk_indoor', 'Walk test inside a building')], default='', max_length=16),
        ),
        migrations.AddField(
            model_name='problemreport', name='environment',
            field=models.CharField(blank=True, default='', max_length=10),
        ),
    ]
