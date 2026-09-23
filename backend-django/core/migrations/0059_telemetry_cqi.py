# Hand-authored migration (2026-09-15), following this repo's established
# convention for hand-writing a migration when a live container isn't
# available to run a real `makemigrations` against (see 0057's/0054's own
# comments for the same situation).
#
# Adds CQI (LTE Channel Quality Indicator, 3GPP standard 0-15 integer
# scale, higher is better, LTE/NR-only) end-to-end on the crowdsourced
# Telemetry pipeline: the raw per-sample column (TelemetrySample.cqi) and
# its rolled-up coverage-bin mean (TelemetryCoverageBin.cqi_mean). See
# core/models.py's TelemetrySample/TelemetryCoverageBin docstrings and
# field comments for what CQI is and why it's null until the separate
# Android SDK repo (Sample.kt) is updated to actually send it.
#
# Partitioning note: v2_telemetry_samples (TelemetrySample's table) is
# RANGE-partitioned by `received_at` (monthly, see migration 0040's own
# comment block and TelemetrySample's docstring). This is a PLAIN
# `AddField` migration with no SeparateDatabaseAndState/RunSQL, exactly
# like the precedent already set by migration 0048
# (0048_telemetry_gsm_wcdma_signal_fields.py), which added rx_qual/
# rscp_dbm/ecio_db to this same partitioned model the same way and has
# been running in production since 2026-09-03 -- native Postgres
# declarative partitioning propagates `ALTER TABLE ... ADD COLUMN` from a
# partitioned parent to every existing (and future) partition
# automatically, so no per-partition handling is needed here either.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward against a live container with the real Django 5.2.16
# model state -- a hand-authored migration in this repo has been wrong
# before (0053's missing column, 0054/0052's wrong PK type, 0056's
# never-migrated table) and should not be trusted blind just because it
# parses and looks plausible.
import core.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0058_seed_issues_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='cqi',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrycoveragebin',
            name='cqi_mean',
            # SignalFloatField (core/models.py), same custom `real` type
            # as rsrp_mean/rsrq_mean/sinr_mean on this same model.
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
    ]
