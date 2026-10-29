from django.db import migrations, models


class Migration(migrations.Migration):
    """Screening of phone readings on arrival (2026-10-29,
    core/ingest_guard.py): signed by a registered phone or not, and a flag
    for a reading that jumped impossibly far or came too often. Older
    readings have neither (null and '')."""

    dependencies = [
        ('core', '0155_speed_loaded_latency'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='signed',
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='flag',
            field=models.CharField(blank=True, default='', max_length=8),
        ),
    ]
