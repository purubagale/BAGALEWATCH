# Hand-authored migration (2026-09-27), same convention as 0069/0068/0061/
# 0054/0057/0060/0066 for when a live container isn't available to run a
# real `makemigrations` against. One plain nullable FloatField for the real
# transmit-power data found in the sample RNO_Report_database.xlsx's
# "Maximum TX Power (dBm)" column -- see Sector.max_tx_power_dbm's own
# comment in models.py.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0069_sector_beamwidth_radius'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='max_tx_power_dbm',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
