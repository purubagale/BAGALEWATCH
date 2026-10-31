from django.db import migrations, models


class Migration(migrations.Migration):
    """A reading whose spot was marked by hand on the map (2026-10-30)."""

    dependencies = [
        ('core', '0157_scheduled_reading_position'),
    ]

    operations = [
        migrations.AddField(model_name='telemetrysample', name='position_source',
                            field=models.CharField(blank=True, max_length=10, null=True)),
    ]
