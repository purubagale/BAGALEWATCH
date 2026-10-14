# Drive-test retention (2026-10-14, core/dt_retention.py): session purpose,
# Keep pin, file fingerprint, source location and readings removed; the
# settings row, dry runs and the pruning record; and the superadmin
# "Drive-Test Retention" MenuItem. The menu path is kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts and MenuAdminPage.tsx's
# KNOWN_ROUTES list.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

PATH = '/d5r8vt'

ITEM = dict(
    label='Drive-Test Retention', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=192, icon='🗄️',
    description='Decide how long full drive-test readings are kept, check a dry run and approve it',
)


def seed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if not MenuItem.objects.filter(path=PATH).exists():
        MenuItem.objects.create(**ITEM)


def unseed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0130_dt_plot_squares'),
    ]

    operations = [
        migrations.AddField(
            model_name='dtplotsquare',
            name='detail_removed',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='drivetestsession',
            name='file_hash',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
        migrations.AddField(
            model_name='drivetestsession',
            name='keep',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='drivetestsession',
            name='purpose',
            field=models.CharField(choices=[('yearly', 'Yearly (NTA)'), ('complaint', 'Complaint'), ('optimization', 'Optimization'), ('other', 'Other')], default='other', max_length=12),
        ),
        migrations.AddField(
            model_name='drivetestsession',
            name='readings_pruned',
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name='drivetestsession',
            name='source_location',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.CreateModel(
            name='DtPruneRun',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('status', models.CharField(choices=[('planned', 'Planned'), ('approved', 'Approved'), ('running', 'Running'), ('done', 'Done'), ('failed', 'Failed'), ('discarded', 'Discarded')], default='planned', max_length=10)),
                ('settings_snapshot', models.JSONField(default=dict)),
                ('plan', models.JSONField(default=list)),
                ('readings_to_remove', models.BigIntegerField(default=0)),
                ('sessions_reduced', models.IntegerField(default=0)),
                ('sessions_erased', models.IntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('approved_at', models.DateTimeField(blank=True, null=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('error', models.TextField(blank=True, default='')),
                ('approved_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_dt_prune_run',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='DtPruneRecord',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('session_id_value', models.IntegerField()),
                ('session_name', models.CharField(blank=True, default='', max_length=255)),
                ('tech', models.CharField(blank=True, default='', max_length=10)),
                ('drive_date', models.DateField(blank=True, null=True)),
                ('purpose', models.CharField(blank=True, default='', max_length=12)),
                ('action', models.CharField(choices=[('reduced', 'Readings reduced to summary'), ('erased', 'Session erased')], max_length=8)),
                ('readings_removed', models.IntegerField(default=0)),
                ('squares_reduced', models.IntegerField(default=0)),
                ('approved_by_name', models.CharField(blank=True, default='', max_length=150)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('run', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='records', to='core.dtprunerun')),
            ],
            options={
                'db_table': 'v2_dt_prune_record',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='DtRetentionSettings',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('enabled', models.BooleanField(default=False)),
                ('yearly_keep', models.PositiveSmallIntegerField(default=2)),
                ('per_square_keep', models.PositiveSmallIntegerField(default=2)),
                ('detail_months', models.PositiveSmallIntegerField(default=24)),
                ('summary_years', models.PositiveSmallIntegerField(default=5)),
                ('min_readings', models.PositiveSmallIntegerField(default=3)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_dt_retention_settings',
            },
        ),
        migrations.RunPython(seed, unseed),
    ]
