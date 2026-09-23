# Hand-authored migration (2026-09-15 follow-up: "Lot name and period
# covered and Network like Network II, Phase I, Lot 6 can be auto
# retrieved by using uploaded report"). Adds the new `network` field to
# RfOptimizationReport -- see that field's own comment in models.py for
# why it's separate from period_covered.
#
# Plain CharField, no index -- none of the 0057/0061 "unnamed Index
# breaks ModelState" lesson applies here, nothing to get wrong.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward, same as every migration in this file's own
# dependency chain asks for.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0062_seed_rf_reports_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='rfoptimizationreport',
            name='network',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
    ]
