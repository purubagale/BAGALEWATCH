# Rough area (~500 m square) on scheduled readings (2026-10-29).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0153_scheduled_readings'),
    ]

    operations = [
        migrations.AddField(
            model_name='scheduledreading',
            name='area_lat',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='scheduledreading',
            name='area_lng',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
