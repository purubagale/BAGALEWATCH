# Narrow DriveTestSample's 8 RF-signal float columns from `double
# precision` (8 bytes) to `real` (4 bytes). Hand-written rather than
# `makemigrations`-generated so it touches ONLY these columns and nothing
# else in the in-flight model state on this branch.
#
# WHY: v2_dt_samples is by far the largest table (tens of thousands of
# rows per uploaded session, growing with every upload). RSRP/RSRQ/SINR/
# RSCP/EcNo/RxQual and the throughput/serving-distance readings are all
# modem-quantised to 1/16 dB or 0.5 dB — comfortably inside `real`'s ~7
# significant digits — so no coverage-plot value or band threshold
# changes. lat/lng are deliberately left as `double precision` (real GPS
# precision) and are not touched here.
#
# COST/LOCKING: each `ALTER COLUMN ... TYPE real USING col::real` rewrites
# the table under an ACCESS EXCLUSIVE lock. Instant at current volume;
# if this ever has to run against a table with millions of rows, run it
# in a low-traffic window (or split per-column with brief pauses) — the
# operations are independent and individually re-runnable.

import core.models
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0038_seed_live_site_sync_menuitem'),
    ]

    operations = [
        migrations.AlterField(
            model_name='drivetestsample',
            name='rsrp',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='rsrq',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='sinr',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='dl',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='serving_dist_km',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='rx_qual',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='rscp',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='drivetestsample',
            name='ecno',
            field=core.models.SignalFloatField(blank=True, null=True),
        ),
    ]
