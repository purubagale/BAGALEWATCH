# Hand-written (2026-08-11), same trivial AddField shape Django's own
# makemigrations would generate for a single new CharField — no
# hand-guessed index name involved here (that pitfall only applies to
# models.Index()), so this one is safe to write by hand and run as-is.
# Adds the "Internal system — Nepal Telecom 4G RAN O&M. All activities
# are monitored." disclaimer pill's customizable text, same
# blank-means-default convention as the other login_* fields added in
# 0017.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0025_drivetestsample_lat_lng_index'),
    ]

    operations = [
        migrations.AddField(
            model_name='brandingsettings',
            name='login_disclaimer',
            field=models.CharField(blank=True, default='', max_length=200),
        ),
    ]
