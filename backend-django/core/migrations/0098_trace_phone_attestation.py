# Trace consent and duration (2026-10-04).
# Adds phone_consent_at: an operator's phone-call attestation no longer
# ACCEPTS a request; the device must still tap Accept. Also moves the default
# trace duration to 120 minutes (from 60, set by 0094).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0097_telemetry_drive_session'),
    ]

    operations = [
        migrations.AddField(
            model_name='tracerequest',
            name='phone_consent_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='tracerequest',
            name='ttl_minutes',
            field=models.PositiveIntegerField(default=120),
        ),
    ]
