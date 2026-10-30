from django.db import migrations, models


class Migration(migrations.Migration):
    """Exact position on the time-of-day readings (2026-10-30, the user's
    decision): sent only with location "Allow all the time"."""

    dependencies = [
        ('core', '0156_reading_screening'),
    ]

    operations = [
        migrations.AddField(model_name='scheduledreading', name='lat', field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name='scheduledreading', name='lng', field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name='scheduledreading', name='gps_accuracy_m',
                            field=models.FloatField(blank=True, null=True)),
    ]
