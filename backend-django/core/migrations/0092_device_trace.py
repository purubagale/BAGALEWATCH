# Device-bound, consent-gated tracing (2026-10-04). Hand-written to match
# core/models.py's DeviceCredential / TraceRequest / TraceLocationSample,
# because the Docker daemon was not running when this was written. Verify
# with `python manage.py makemigrations --check --dry-run` after rebuilding
# the django image -- it must report "No changes detected".

import uuid

import django.contrib.gis.db.models.fields
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('core', '0091_seed_blocked_ips_menuitem'),
    ]

    operations = [
        migrations.CreateModel(
            name='DeviceCredential',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('device_hash', models.CharField(max_length=32, unique=True)),
                ('public_key_pem', models.TextField()),
                ('msisdn', models.CharField(blank=True, db_index=True, default='', max_length=24)),
                ('fcm_token', models.CharField(blank=True, default='', max_length=512)),
                ('app_version', models.CharField(blank=True, default='', max_length=40)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_seen_at', models.DateTimeField(blank=True, null=True)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'db_table': 'v2_device_credential',
            },
        ),
        migrations.CreateModel(
            name='TraceRequest',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('msisdn', models.CharField(max_length=24)),
                ('case_reference', models.CharField(max_length=200)),
                ('status', models.CharField(choices=[('PENDING', 'Pending'), ('ACCEPTED', 'Accepted'), ('REJECTED', 'Rejected'), ('EXPIRED', 'Expired'), ('CANCELLED', 'Cancelled'), ('REVOKED', 'Revoked by user')], default='PENDING', max_length=12)),
                ('consent_method', models.CharField(blank=True, default='', max_length=16)),
                ('consent_at', models.DateTimeField(blank=True, null=True)),
                ('phone_consent_ref', models.CharField(blank=True, default='', max_length=200)),
                ('policy_mode', models.CharField(blank=True, default='', max_length=16)),
                ('ttl_minutes', models.PositiveIntegerField(default=120)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('ended_at', models.DateTimeField(blank=True, null=True)),
                ('consent_recorded_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('device', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='trace_requests', to='core.devicecredential')),
                ('requested_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_trace_request',
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['device', 'status'], name='v2_trace_dev_status_idx')],
            },
        ),
        migrations.CreateModel(
            name='TraceLocationSample',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('ts', models.DateTimeField()),
                ('lat', models.FloatField()),
                ('lng', models.FloatField()),
                ('location', django.contrib.gis.db.models.fields.PointField(blank=True, geography=True, null=True, spatial_index=True, srid=4326)),
                ('accuracy_m', models.FloatField(blank=True, null=True)),
                ('received_at', models.DateTimeField(auto_now_add=True)),
                ('trace', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='samples', to='core.tracerequest')),
            ],
            options={
                'db_table': 'v2_trace_location_sample',
                'indexes': [models.Index(fields=['trace', 'ts'], name='v2_trace_sample_ts_idx')],
            },
        ),
    ]
