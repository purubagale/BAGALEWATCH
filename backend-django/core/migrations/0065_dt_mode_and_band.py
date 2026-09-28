# DriveTestSession.mode + DriveTestSample.band (2026-09-23 request: real
# drive tests for one site are a matrix of mode (Free Mode/band-lock) x
# phase x metric, and there was no way to tag which mode a session was
# driven in, nor which band a sample's serving cell was actually on -- see
# both fields' own docstrings in models.py.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0064_rf_report_attachment_compressed'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsession',
            name='mode',
            field=models.CharField(blank=True, default='', max_length=40),
        ),
        migrations.AddField(
            model_name='drivetestsample',
            name='band',
            field=models.CharField(blank=True, default='', max_length=10),
        ),
    ]
