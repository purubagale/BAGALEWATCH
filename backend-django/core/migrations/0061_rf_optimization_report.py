# Hand-authored migration (2026-09-15), following this repo's established
# convention for hand-writing a migration when a live container isn't
# available to run a real `makemigrations` against (see 0054/0057/0060's
# own comments for the same situation). Adds the vendor RNO report
# importer's three new tables (RfOptimizationReport, RfReportAttachment,
# SectorConfigChange) plus one new nullable FK on the existing Issue
# table (`source_report`) -- see each model's docstring in core/models.py
# for the full feature this supports.
#
# `id` fields are `models.BigAutoField(...)`, matching this app's
# DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField' setting -- same
# lesson as 0055's root cause (an earlier hand-written migration copied
# an older migration's literal `models.AutoField(...)` PK style instead
# of matching that setting).
#
# Every `models.Index(...)` below carries an explicit `name=`, computed
# by running the real `Index.set_name_with_model()` algorithm against
# Django==5.2.16 (matching requirements.txt) in an isolated throwaway
# model with the same db_table/column names -- not hand-guessed. An
# earlier version of this file (and of 0057_issue.py) left these
# unnamed on the theory that Django resolves the name deterministically
# at apply time the same way it does for a live model's Meta.indexes.
# That theory is wrong for a *migration operation*: ModelState.__init__
# requires every Index passed through CreateModel's options to already
# carry a `.name` -- it has no live model class to call
# `set_name_with_model()` against, so an unnamed Index here raises
# `ValueError: Indexes passed to ModelState require a name attribute`
# on every `migrate` (confirmed against a real container 2026-09-15,
# same failure 0057_issue.py hit first).
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward against a live container with the real Django
# 5.2.16 model state, exactly like was done to verify/correct 0053-0060
# earlier this month -- a hand-authored migration in this repo has been
# wrong before (0053's missing column, 0054/0052's wrong PK type, 0056's
# never-migrated table) and should not be trusted blind just because it
# parses and looks plausible.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import core.models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0060_drivetestsample_cqi'),
    ]

    operations = [
        migrations.CreateModel(
            name='RfOptimizationReport',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('lot_name', models.CharField(max_length=100)),
                ('title', models.CharField(blank=True, default='', max_length=255)),
                ('vendor', models.CharField(blank=True, default='', max_length=255)),
                ('period_covered', models.CharField(blank=True, default='', max_length=100)),
                ('notes', models.TextField(blank=True, default='')),
                ('imported_at', models.DateTimeField(auto_now_add=True)),
                ('imported_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='rf_report_imports', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_rf_optimization_reports',
                'ordering': ['-imported_at'],
            },
        ),
        migrations.CreateModel(
            name='RfReportAttachment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('file', models.FileField(max_length=500, upload_to=core.models.rf_report_attachment_upload_path)),
                ('original_filename', models.CharField(blank=True, default='', max_length=255)),
                ('category', models.CharField(
                    choices=[('source', 'Source report'), ('mom', 'Minutes of Meeting'), ('other', 'Other')],
                    default='other', max_length=10,
                )),
                ('size_bytes', models.BigIntegerField(blank=True, null=True)),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
                ('report', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='attachments', to='core.rfoptimizationreport',
                )),
                ('uploaded_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='rf_report_attachments', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_rf_report_attachments',
                'ordering': ['-uploaded_at'],
                'indexes': [models.Index(fields=['report'], name='v2_rf_repor_report__bf5c9a_idx')],
            },
        ),
        migrations.CreateModel(
            name='SectorConfigChange',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('sn', models.IntegerField(blank=True, null=True)),
                ('cell_name', models.CharField(blank=True, default='', max_length=255)),
                ('before_change', models.CharField(blank=True, default='', max_length=255)),
                ('after_change', models.CharField(blank=True, default='', max_length=255)),
                ('result', models.CharField(blank=True, default='', max_length=255)),
                ('antenna_type', models.CharField(blank=True, default='', max_length=255)),
                ('antenna_shared_with', models.CharField(blank=True, default='', max_length=255)),
                ('raw_row', models.JSONField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('report', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='antenna_changes', to='core.rfoptimizationreport',
                )),
                ('sector', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='config_changes', to='core.sector',
                )),
            ],
            options={
                'db_table': 'v2_sector_config_changes',
                'ordering': ['report', 'sn'],
                'indexes': [
                    models.Index(fields=['report'], name='v2_sector_c_report__8a2f09_idx'),
                    models.Index(fields=['sector'], name='v2_sector_c_sector__55a6eb_idx'),
                ],
            },
        ),
        migrations.AddField(
            model_name='issue',
            name='source_report',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name='recommendation_issues', to='core.rfoptimizationreport',
            ),
        ),
    ]
