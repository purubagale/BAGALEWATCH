# Hand-authored migration (2026-09-15), following this repo's established
# convention for hand-writing a migration when a live container isn't
# available to run a real `makemigrations` against (see 0054/0057's own
# comments for the same situation). `DriveTestSample.cqi` (models.py) is
# a brand-new nullable column -- LTE-only 3GPP Channel Quality Indicator,
# 0-15, higher is better -- added to the Drive-Test Data Manager pipeline
# alongside the existing rsrp/rsrq/sinr/pci 4G fields. Single AddField,
# no data migration needed (existing rows just get NULL, same as any
# other nullable column added after the fact).
#
# Depends on 0059_telemetry_cqi rather than 0058 directly: that migration
# (a separate, unrelated CQI addition to the crowdsourced Telemetry
# pipeline -- TelemetrySample.cqi / TelemetryCoverageBin.cqi_mean) was
# also hand-authored against the same 0058 base around the same time.
# Chaining after it here instead of forking from 0058 a second time
# keeps this repo's migration history linear and avoids a "Conflicting
# migrations" merge being needed later -- the two touch entirely
# different models (DriveTestSample vs TelemetrySample/
# TelemetryCoverageBin) so there is no real ordering dependency, only a
# bookkeeping one.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward against a live container with the real Django
# 5.2.16 model state, exactly like was done to verify/correct 0053-0057
# earlier this month -- a hand-authored migration in this repo has been
# wrong before (0053's missing column, 0054/0052's wrong PK type, 0056's
# never-migrated table) and should not be trusted blind just because it
# parses and looks plausible.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0059_telemetry_cqi'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsample',
            name='cqi',
            field=models.SmallIntegerField(null=True, blank=True),
        ),
    ]
