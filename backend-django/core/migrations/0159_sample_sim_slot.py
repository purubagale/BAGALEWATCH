from django.db import migrations, models


class Migration(migrations.Migration):
    """Which SIM slot a reading came from on a two-SIM phone (2026-10-31)."""

    dependencies = [
        ('core', '0158_sample_position_source'),
    ]

    operations = [
        migrations.AddField(model_name='telemetrysample', name='sim_slot',
                            field=models.SmallIntegerField(blank=True, null=True)),
    ]
