# Rescue-location beacon (SubscriberLastLocation + RescueLocationAccessLog),
# the continuous coverage-bin rollup watermark (TelemetryRollState), scoped
# live drive-test sessions (TelemetryDriveTestSession), and the new
# 'rescue_operator' User role — see core/models.py's "Rescue-location
# beacon" / "Continuous coverage-bin rollup" / "Scoped drive-test sessions"
# section comments for the full design rationale behind each.
#
# All four are plain (non-partitioned) tables — unlike migration 0040's
# v2_telemetry_samples, nothing here needs SeparateDatabaseAndState.

import django.contrib.gis.db.models.fields
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import core.models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0042_menuitem_path_unique'),
    ]

    operations = [
        migrations.AlterField(
            model_name='user',
            name='role',
            field=models.CharField(
                choices=[
                    ('superadmin', 'Superadmin'),
                    ('admin', 'Admin'),
                    ('viewer', 'Viewer'),
                    ('rescue_operator', 'Rescue Operator'),
                ],
                default='viewer',
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name='SubscriberLastLocation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('device_id', models.CharField(db_index=True, max_length=64, unique=True)),
                ('msisdn', models.CharField(blank=True, db_index=True, max_length=20, null=True)),
                ('last_lat', models.FloatField(blank=True, null=True)),
                ('last_lng', models.FloatField(blank=True, null=True)),
                ('last_location', django.contrib.gis.db.models.fields.PointField(blank=True, geography=True, null=True, srid=4326)),
                ('last_accuracy_m', core.models.SignalFloatField(blank=True, null=True)),
                ('last_source', models.CharField(choices=[('gps', 'GPS fix'), ('network', 'Network-based location'), ('cell', 'Serving-cell fallback (no fix)')], default='gps', max_length=10)),
                ('last_seen_ts', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('rescue_consent', models.BooleanField(default=False)),
                ('rescue_consent_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'v2_subscriber_last_location',
            },
        ),
        migrations.AddIndex(
            model_name='subscriberlastlocation',
            index=models.Index(fields=['rescue_consent', 'last_seen_ts'], name='v2_sll_consent_seen_idx'),
        ),
        migrations.CreateModel(
            name='RescueLocationAccessLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('msisdn_queried', models.CharField(max_length=20)),
                ('case_reference', models.CharField(max_length=100)),
                ('found', models.BooleanField(default=False)),
                ('queried_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('looked_up_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='rescue_lookups', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_rescue_access_log',
                'ordering': ['-queried_at'],
            },
        ),
        migrations.CreateModel(
            name='TelemetryRollState',
            fields=[
                ('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False)),
                ('last_rolled_at', models.DateTimeField(blank=True, null=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'v2_telemetry_roll_state',
            },
        ),
        migrations.CreateModel(
            name='TelemetryDriveTestSession',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('device_ids', models.JSONField(default=list)),
                ('area_min_lat', models.FloatField(blank=True, null=True)),
                ('area_max_lat', models.FloatField(blank=True, null=True)),
                ('area_min_lng', models.FloatField(blank=True, null=True)),
                ('area_max_lng', models.FloatField(blank=True, null=True)),
                ('status', models.CharField(choices=[('active', 'Active'), ('ended', 'Ended')], default='active', max_length=10)),
                ('started_at', models.DateTimeField(auto_now_add=True)),
                ('ended_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='telemetry_dt_sessions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_telemetry_dt_sessions',
                'ordering': ['-started_at'],
            },
        ),
    ]
