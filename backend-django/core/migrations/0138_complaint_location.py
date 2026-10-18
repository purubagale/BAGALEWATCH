# Exact positions for the customer's own complaint (2026-10-16): a switch on
# the Security page, off by default, with the report age and the time window.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0137_attack_alerts'),
    ]

    operations = [
        migrations.AddField(
            model_name='securitysettings',
            name='complaint_location_access',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='complaint_location_days',
            field=models.PositiveSmallIntegerField(default=7),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='complaint_location_hours',
            field=models.PositiveSmallIntegerField(default=3),
        ),
    ]
