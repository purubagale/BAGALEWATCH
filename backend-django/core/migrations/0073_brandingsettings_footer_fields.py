# Hand-written (2026-09-30), same trivial AddField shape Django's own
# makemigrations would generate for two new CharFields -- no hand-guessed
# index name involved (that pitfall only applies to models.Index()), so
# this is safe to write by hand and run as-is. Adds the app-wide footer's
# customizable copyright/org line and optional "Developed By" credit --
# same blank-means-default convention as every other BrandingSettings text
# field (login_subtitle/login_disclaimer/etc, added in 0017/0026).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0072_seed_telemetry_live_samples_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='brandingsettings',
            name='footer_text',
            field=models.CharField(blank=True, default='', max_length=200),
        ),
        migrations.AddField(
            model_name='brandingsettings',
            name='footer_developed_by',
            field=models.CharField(blank=True, default='', max_length=200),
        ),
    ]
