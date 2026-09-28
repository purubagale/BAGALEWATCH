# Hand-authored migration (2026-09-23), same convention as
# 0061/0054/0057/0060 for when a live container isn't available to run a
# real `makemigrations` against. OptimizationActivity.source_report +
# antenna_changes ("need to relate and manage vendor provided RNO
# report") -- a direct link from an optimization effort to the vendor
# report/antenna change-log rows it verifies, independent of the existing
# Issue.source_report/resolved_by_activity path (which only ever covers a
# RECOMMENDATION row, not the antenna change-log SectorConfigChange rows
# the same report also carries). See both fields' own docstrings on
# OptimizationActivity in models.py.
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0065_dt_mode_and_band'),
    ]

    operations = [
        migrations.AddField(
            model_name='optimizationactivity',
            name='source_report',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name='activities', to='core.rfoptimizationreport',
            ),
        ),
        migrations.AddField(
            model_name='optimizationactivity',
            name='antenna_changes',
            field=models.ManyToManyField(blank=True, related_name='verifying_activities', to='core.sectorconfigchange'),
        ),
    ]
