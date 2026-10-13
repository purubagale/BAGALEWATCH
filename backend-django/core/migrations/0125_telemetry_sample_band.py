# Operating band of a phone reading (2026-10-13). Adds the channel number
# the app now sends (arfcn) and the band worked out from it or reported by
# the phone (band, band_mhz) -- see core/radio_band.py.
#
# Readings stored before this carry no channel number, so their band stays
# empty, with one exception: a 2G reading already has its BCCH channel, and
# that is enough to tell 900 from 1800. Those rows are filled in here.
from django.db import migrations, models

from core.radio_band import gsm_mhz_sql


def backfill_gsm(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            'UPDATE v2_telemetry_samples SET band_mhz = ' + gsm_mhz_sql('bcch') +
            " WHERE network_type = 'GSM' AND bcch IS NOT NULL AND band_mhz IS NULL"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0124_recompute_bin_cqi_rsrq_table'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetrysample',
            name='arfcn',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='band',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='telemetrysample',
            name='band_mhz',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_gsm, migrations.RunPython.noop),
    ]
