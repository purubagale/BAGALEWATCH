# Trace duration default changed from 120 to 60 minutes (2026-10-04).
# Default-only change: no column change beyond the stored default.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0093_seed_trace_requests_menuitem'),
    ]

    operations = [
        migrations.AlterField(
            model_name='tracerequest',
            name='ttl_minutes',
            field=models.PositiveIntegerField(default=60),
        ),
    ]
