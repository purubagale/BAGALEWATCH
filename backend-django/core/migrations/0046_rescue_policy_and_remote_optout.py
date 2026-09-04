# Superadmin-controlled rescue-consent policy (mandatory/optional) and
# the remote opt-out request channel (2026-09-02) — see core/models.py's
# "Superadmin-controlled rescue-consent policy" / "Remote opt-out
# request" section comments, RescueConsentPolicy's docstring, and
# TelemetryRemoteOptOutRequest's docstring for the full design rationale.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0045_operator_scope_and_dt_consent'),
    ]

    operations = [
        migrations.AddField(
            model_name='rescuelocationaccesslog',
            name='policy_mode',
            field=models.CharField(blank=True, default='', max_length=10),
        ),
        migrations.CreateModel(
            name='RescueConsentPolicy',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False)),
                ('mode', models.CharField(
                    choices=[('mandatory', 'Mandatory (default)'), ('optional', 'Optional (emergency override)')],
                    default='mandatory', max_length=10,
                )),
                ('reason', models.CharField(blank=True, default='', max_length=255)),
                ('active_until', models.DateTimeField(blank=True, null=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('changed_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_rescue_consent_policy',
            },
        ),
        migrations.CreateModel(
            name='RescueConsentPolicyChangeLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('mode', models.CharField(max_length=10)),
                ('reason', models.CharField(blank=True, default='', max_length=255)),
                ('active_until', models.DateTimeField(blank=True, null=True)),
                ('changed_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('changed_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_rescue_consent_policy_log',
                'ordering': ['-changed_at'],
            },
        ),
        migrations.CreateModel(
            name='TelemetryRemoteOptOutRequest',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('device_id', models.CharField(db_index=True, max_length=64, unique=True)),
                ('requested_at', models.DateTimeField(auto_now_add=True)),
                ('reason', models.CharField(blank=True, default='', max_length=255)),
                ('fulfilled_at', models.DateTimeField(blank=True, null=True)),
                ('requested_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_telemetry_remote_optout_request',
            },
        ),
    ]
