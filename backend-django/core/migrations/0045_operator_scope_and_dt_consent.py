# Operator-scoped data access + optional drive-test participation consent
# (2026-09-02) — see core/models.py's "Operator data-access scope" comment
# on User, the `mnc`/`mcc`/`last_mnc`/`last_mcc` field comments on
# TelemetryCoverageBin/SubscriberLastLocation, TelemetryDriveTestSession's
# `require_consent` comment, and the new TelemetryDriveTestConsent model's
# docstring for the full design rationale behind each piece here.
#
# Three independent, additive changes, each already isolated to specific
# call sites in core/telemetry.py, core/telemetry_admin.py and
# core/rescue.py:
#   1. User.operator_mncs — an MNC allowlist restricting which telecom
#      operator(s)' data a scoped account can see; empty (default) means
#      unrestricted, for NTA/government/superadmin accounts.
#   2. mnc/mcc columns on TelemetryCoverageBin (+ widened unique
#      constraint) and SubscriberLastLocation, so operator scoping can
#      apply to the aggregated coverage map and to rescue lookups, not
#      just raw samples (which already had mnc/mcc from migration 0040).
#   3. TelemetryDriveTestSession.require_consent + the new
#      TelemetryDriveTestConsent model — an optional per-session gate so
#      an admin can require a rider's own opt-in before their samples are
#      included in a drive-test/coverage session's results.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0044_seed_telemetry_dt_session_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='operator_mncs',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='subscriberlastlocation',
            name='last_mnc',
            field=models.CharField(blank=True, default='', max_length=6),
        ),
        migrations.AddField(
            model_name='subscriberlastlocation',
            name='last_mcc',
            field=models.CharField(blank=True, default='', max_length=6),
        ),
        migrations.AddField(
            model_name='telemetrycoveragebin',
            name='mnc',
            field=models.CharField(blank=True, default='', max_length=6),
        ),
        migrations.RemoveConstraint(
            model_name='telemetrycoveragebin',
            name='uniq_telemetry_bin',
        ),
        migrations.AddConstraint(
            model_name='telemetrycoveragebin',
            constraint=models.UniqueConstraint(
                fields=['geohash', 'network_type', 'mnc'], name='uniq_telemetry_bin_mnc'
            ),
        ),
        migrations.AddField(
            model_name='telemetrydrivetestsession',
            name='require_consent',
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name='TelemetryDriveTestConsent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('device_id', models.CharField(db_index=True, max_length=64, unique=True)),
                ('consent', models.BooleanField(default=False)),
                ('consented_at', models.DateTimeField(blank=True, null=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'v2_telemetry_dt_consent',
            },
        ),
    ]
