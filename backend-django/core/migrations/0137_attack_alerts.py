# Attack alerts (2026-10-15, core/alerts.py): the Security page's alert
# switches and channels (email, SMS or both), extra recipients, and a mobile
# number on each user account for alerts by SMS.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0136_security_phase_g'),
    ]

    operations = [
        migrations.AddField(
            model_name='securitysettings',
            name='attack_alerts_enabled',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='alert_by_email',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='alert_by_sms',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='alert_extra_emails',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='alert_extra_numbers',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='user',
            name='mobile_number',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
    ]
