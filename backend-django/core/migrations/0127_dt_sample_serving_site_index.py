# Index on the serving site of a drive-test reading (2026-10-13), for the
# site page's measured coverage (core/site_coverage.py). The table is the
# largest in the application and had no way to find one site's readings
# without reading all of it.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0126_cqi_measured'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='drivetestsample',
            index=models.Index(fields=['serving_site_id'], name='v2_dt_samp_serving_site_idx'),
        ),
    ]
