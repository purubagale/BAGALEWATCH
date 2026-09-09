# LiveSiteSyncConfig (2026-09-07) -- see that model's docstring
# (core/models.py) for why this reverses the 2026-08-26
# "credentials stay .env-only" decision: an in-app config UI for the
# Live Site Sync page, now that NetBox is the real source being wired
# in. api_key is plaintext (recoverable on purpose -- this app uses it
# outbound, unlike TelemetryIngestKey/ApiKey's one-way hashes).

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0050_subscriber_imsi'),
    ]

    operations = [
        migrations.CreateModel(
            name='LiveSiteSyncConfig',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False)),
                ('api_url', models.CharField(blank=True, default='', max_length=500)),
                ('api_key', models.CharField(blank=True, default='', max_length=500)),
                ('auth_scheme', models.CharField(
                    choices=[('Bearer', 'Bearer <token>'), ('Token', 'Token <token> (NetBox)')],
                    default='Bearer', max_length=10,
                )),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_live_site_sync_config',
            },
        ),
    ]
