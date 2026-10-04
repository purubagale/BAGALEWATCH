# Drive-session grouping and start/stop markers for telemetry (2026-10-04).
# Widens trigger_reason to fit 'drive_start' / 'drive_stop' and adds
# drive_session_id, so a drive's fixes can be matched exactly rather than by
# time window alone.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0096_telemetry_cqi_derived'),
    ]

    operations = [
        migrations.AlterField(
            model_name='telemetrysample',
            name='trigger_reason',
            field=models.CharField(
                choices=[
                    ('periodic', 'Periodic'), ('handover', 'Handover'), ('manual', 'Manual'),
                    ('drive', 'Drive test'), ('drive_start', 'Drive start'), ('drive_stop', 'Drive stop'),
                ],
                default='periodic',
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='drive_session_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=36),
        ),
    ]
