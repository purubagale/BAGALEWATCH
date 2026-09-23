# Hand-authored migration (2026-09-15 follow-up: "allow system to save
# report (with size compressed) also with attachment if needed in
# future for full access"). Adds `is_compressed` to RfReportAttachment
# -- see that field's own comment in models.py. Every attachment upload
# from here on is gzip-compressed server-side
# (RfOptimizationReportViewSet.attachments in core/rf_reports.py);
# existing rows default to False (they were stored uncompressed, before
# this migration) and are still served correctly by the download
# endpoint, which only decompresses when this flag is set.
#
# Plain BooleanField, no index -- same as 0063, nothing here can repeat
# 0057/0061's unnamed-Index mistake.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward, same as every migration in this file's own
# dependency chain asks for.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0063_rf_optimization_report_network'),
    ]

    operations = [
        migrations.AddField(
            model_name='rfreportattachment',
            name='is_compressed',
            field=models.BooleanField(default=False),
        ),
    ]
