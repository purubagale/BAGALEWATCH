# Loaded latency on phone speed tests and problem reports (2026-10-29).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0154_scheduled_reading_area'),
    ]

    operations = [
        migrations.AddField(model_name='telemetryspeedresult', name='latency_down_ms',
                            field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name='telemetryspeedresult', name='latency_up_ms',
                            field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name='problemreport', name='latency_down_ms',
                            field=models.FloatField(blank=True, null=True)),
        migrations.AddField(model_name='problemreport', name='latency_up_ms',
                            field=models.FloatField(blank=True, null=True)),
    ]
