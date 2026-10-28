# Outdoors / inside a building / in a vehicle per drive-test reading
# (2026-10-28), set on the web for a stretch of a session; empty means the
# session's own place (drive, walk outdoors, walk indoors) applies.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0148_diagnosis_for_admins'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsample',
            name='environment',
            field=models.CharField(blank=True, max_length=10, null=True),
        ),
    ]
