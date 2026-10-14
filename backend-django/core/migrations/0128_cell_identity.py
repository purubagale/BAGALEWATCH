# Matching a reading to its sector by the cell's own identity (2026-10-13).
# `Sector.enodeb_id` comes from the LTE engineering parameter file;
# `DriveTestSample.cell_id` is what the log says the serving cell was. See
# core/dt_serving_cell.py. Columns only: existing rows stay empty until the
# engineering file is imported again and a log is uploaded again.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0127_dt_sample_serving_site_index'),
    ]

    operations = [
        migrations.AddField(
            model_name='sector',
            name='enodeb_id',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name='sector',
            index=models.Index(fields=['enodeb_id', 'local_cell_id'], name='v2_sector_cell_identity_idx'),
        ),
        migrations.AddField(
            model_name='drivetestsample',
            name='cell_id',
            field=models.BigIntegerField(blank=True, null=True),
        ),
    ]
