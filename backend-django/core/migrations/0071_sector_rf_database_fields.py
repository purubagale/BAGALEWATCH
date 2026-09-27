# Hand-authored migration (2026-09-27), same convention as 0070/0069/0068/
# 0061/0054/0057/0060/0066 for when a live container isn't available to run
# a real `makemigrations` against. Ten new fields for the 2G/3G RF Database
# engineering-parameter import (sample/2g_3g_RF Database...xlsx) -- see
# each field's own comment in models.py, grouped just after
# Sector.site_existence.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0070_sector_max_tx_power_dbm'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='lac',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
        migrations.AddField(
            model_name='sector',
            name='ci',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
        migrations.AddField(
            model_name='sector',
            name='ncc',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='hsn',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='tch',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='sector',
            name='total_trx',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='activated_trx',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='cs_traffic',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='site_traffic',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='sector',
            name='dl_uarfcn',
            field=models.IntegerField(blank=True, null=True),
        ),
    ]
