# Hand-authored migration (2026-09-26), same convention as 0061/0054/0057/
# 0060/0066 for when a live container isn't available to run a real
# `makemigrations` against. Two independent additions from the same
# request ("need to extract The Lot-Wise OSS KPI and worst cell
# optimization also" + "for 4G I found more parameters with data for
# sectors that are also need to be managed"):
#
# - RfKpiSummary / RfCellKpi (new tables) -- see both models' own
#   docstrings in models.py. Index names below were computed with the
#   real `Index.set_name_with_model()` algorithm (django.db.models.indexes,
#   django.db.backends.utils.names_digest) run standalone against the
#   exact table/column names, matching this repo's own established
#   practice (see 0061's docstring) rather than hand-guessed -- verified
#   by reproducing 0061's own already-known-correct
#   v2_sector_c_report__8a2f09_idx/v2_sector_c_sector__55a6eb_idx values
#   with the same computation before trusting it for these new ones.
# - Site.tower_type/tower_height_m/building_height/tower_height_tssr/
#   antenna_device/tower_remark (new columns on the existing Site table)
#   -- see Site's own docstring in models.py for the field list and what
#   was explicitly excluded (Property ID, Zone, Palika).
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0067_seed_dt_plot_catalog_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='site',
            name='tower_type',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='site',
            name='tower_height_m',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='site',
            name='building_height',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='site',
            name='tower_height_tssr',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.AddField(
            model_name='site',
            name='antenna_device',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='site',
            name='tower_remark',
            field=models.CharField(blank=True, default='', max_length=500),
        ),
        migrations.CreateModel(
            name='RfKpiSummary',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kpi_name', models.CharField(max_length=255)),
                ('target', models.CharField(blank=True, default='', max_length=255)),
                ('pre_value', models.CharField(blank=True, default='', max_length=255)),
                ('post_value', models.CharField(blank=True, default='', max_length=255)),
                ('remark', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('report', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='kpi_summaries', to='core.rfoptimizationreport',
                )),
            ],
            options={
                'db_table': 'v2_rf_kpi_summaries',
                'ordering': ['report', 'id'],
            },
        ),
        migrations.AddIndex(
            model_name='rfkpisummary',
            index=models.Index(fields=['report'], name='v2_rf_kpi_s_report__661e3a_idx'),
        ),
        migrations.CreateModel(
            name='RfCellKpi',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('enb_id', models.CharField(blank=True, default='', max_length=50)),
                ('enodeb_name', models.CharField(blank=True, default='', max_length=255)),
                ('cell_name', models.CharField(blank=True, default='', max_length=255)),
                ('metric_name', models.CharField(max_length=255)),
                ('pre_value', models.CharField(blank=True, default='', max_length=255)),
                ('post_value', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('report', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='cell_kpis', to='core.rfoptimizationreport',
                )),
                ('sector', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='worst_cell_kpis', to='core.sector',
                )),
            ],
            options={
                'db_table': 'v2_rf_cell_kpis',
                'ordering': ['report', 'metric_name', 'cell_name'],
            },
        ),
        migrations.AddIndex(
            model_name='rfcellkpi',
            index=models.Index(fields=['report'], name='v2_rf_cell__report__42d83f_idx'),
        ),
        migrations.AddIndex(
            model_name='rfcellkpi',
            index=models.Index(fields=['sector'], name='v2_rf_cell__sector__458a47_idx'),
        ),
    ]
