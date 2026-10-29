# Radio values for the predicted coverage on the site map (2026-10-28).

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0150_cell_kpis'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='CoveragePredictionSettings',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('bands', models.JSONField(blank=True, default=dict)),
                ('environment', models.CharField(default='suburban', max_length=12)),
                ('rx_height_m', models.FloatField(default=1.5)),
                ('default_height_m', models.FloatField(default=25)),
                ('default_tilt_deg', models.FloatField(default=4)),
                ('offset_db', models.FloatField(default=0)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_coverage_prediction_settings',
            },
        ),
    ]
