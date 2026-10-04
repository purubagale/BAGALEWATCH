# Serving-cell identity and attribution for crowdsourced telemetry samples
# (2026-10-04). Adds the 2G/3G physical-layer identities the SDK now sends
# (scrambling_code, bcch, bsic) and the serving-cell attribution columns
# filled by core/dt_serving_cell.py at upload time. Columns only -- no
# existing row is rewritten, so historical samples stay NULL here.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0094_trace_ttl_default_60'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='scrambling_code',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='bcch',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='bsic',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='serving_site_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='serving_cell_name',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='serving_sector',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='serving_local_cell_id',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='serving_dist_km',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
