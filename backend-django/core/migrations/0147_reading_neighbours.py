from django.db import migrations, models


class Migration(migrations.Migration):
    """The other cells heard with a phone reading (2026-10-27,
    core/neighbour_cells.py). Nullable: older readings have none."""

    dependencies = [
        ('core', '0146_reading_bandwidth'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='neighbours',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
