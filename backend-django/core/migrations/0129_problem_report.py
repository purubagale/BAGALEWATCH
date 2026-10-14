# Problem reports (2026-10-14, core/problem_report.py): the ProblemReport
# table, packet loss on speed results, and the "Problem Reports" MenuItem.
# The menu path is kept in sync with frontend-react/src/constants/opaqueRoutes.ts
# and MenuAdminPage.tsx's KNOWN_ROUTES list. access='admin': admin and
# superadmin, matching the review endpoints.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

PATH = '/r4q7cx'

ITEM = dict(
    label='Problem Reports', link_type='route', path=PATH,
    access='admin', permission_key='', order=191, icon='📣',
    description='Problems reported from the mobile app or entered from complaints, with a check of the measurements around each one',
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
        ('core', '0128_cell_identity'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetryspeedresult',
            name='packet_loss_pct',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name='ProblemReport',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('source', models.CharField(choices=[('app', 'Mobile app'), ('staff', 'Entered by staff')], max_length=8)),
                ('category', models.CharField(choices=[('no_signal', 'No signal'), ('slow_data', 'Slow data'), ('call_drop', 'Call drops'), ('stuck_2g3g', 'Stuck on 2G/3G'), ('other', 'Other')], max_length=12)),
                ('note', models.TextField(blank=True, default='')),
                ('happened_at', models.DateTimeField()),
                ('lat', models.FloatField()),
                ('lng', models.FloatField()),
                ('network_type', models.CharField(blank=True, default='', max_length=12)),
                ('band', models.CharField(blank=True, default='', max_length=24)),
                ('pci', models.IntegerField(blank=True, null=True)),
                ('cell_id', models.BigIntegerField(blank=True, null=True)),
                ('level_dbm', models.SmallIntegerField(blank=True, null=True)),
                ('rsrq_db', models.SmallIntegerField(blank=True, null=True)),
                ('sinr_db', models.SmallIntegerField(blank=True, null=True)),
                ('download_mbps', models.FloatField(blank=True, null=True)),
                ('upload_mbps', models.FloatField(blank=True, null=True)),
                ('ping_ms', models.FloatField(blank=True, null=True)),
                ('jitter_ms', models.FloatField(blank=True, null=True)),
                ('packet_loss_pct', models.FloatField(blank=True, null=True)),
                ('phone_model', models.CharField(blank=True, default='', max_length=80)),
                ('android_version', models.CharField(blank=True, default='', max_length=16)),
                ('app_version', models.CharField(blank=True, default='', max_length=40)),
                ('status', models.CharField(choices=[('new', 'New'), ('checked', 'Checked'), ('closed', 'Closed')], default='new', max_length=8)),
                ('engineer_note', models.TextField(blank=True, default='')),
                ('checked_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('checked_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='problem_reports_checked', to=settings.AUTH_USER_MODEL)),
                ('device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='problem_reports', to='core.devicecredential')),
                ('entered_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='problem_reports_entered', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_problem_report',
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['status', 'created_at'], name='v2_problem_status_idx')],
            },
        ),
        migrations.RunPython(seed, unseed),
    ]
