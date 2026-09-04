# Superadmin-editable drive-test consent MESSAGE (2026-09-02) — separate
# from TelemetryDriveTestConsent (the subscriber's answer). See
# core/models.py's DriveTestConsentConfig docstring and core/consent.py's
# DriveTestConsentMessageView / DriveTestConsentMessageAdminView.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

# Inlined literal, not a reference to core.models.DriveTestConsentConfig.
# DEFAULT_MESSAGE -- this is how Django's own migration writer serializes
# a string-constant field default (the resolved value, not a symbolic
# reference), and keeps this migration import-independent of models.py.
DEFAULT_MESSAGE = (
    "This app would like to include your device's network-quality "
    "readings in a drive-test coverage session. Nothing is shared "
    "unless you agree, and you can withdraw your consent at any time."
)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0046_rescue_policy_and_remote_optout'),
    ]

    operations = [
        migrations.CreateModel(
            name='DriveTestConsentConfig',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False)),
                ('message', models.TextField(blank=True, default=DEFAULT_MESSAGE)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_dt_consent_config',
            },
        ),
    ]
