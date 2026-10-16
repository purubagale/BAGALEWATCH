# Problem Dashboard (2026-10-15, core/problem_report.py): each report keeps
# its check's main cause and the site it points at, so the dashboard can
# count and chart them without checking every report again. Reports already
# stored are classified the first time the dashboard is opened. Reports can
# also come from another NTC system through the external API (source
# 'external', its ticket number in external_ref). The menu
# item becomes "Problem Dashboard"; a label or description a superadmin has
# edited in Menu Admin is left alone.
import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models

PATH = '/r4q7cx'
OLD = ('Problem Reports',
       'Problems reported from the mobile app or entered from complaints, with a check of the measurements around each one')
NEW = ('Problem Dashboard',
       'Problems reported from the mobile app or entered from complaints: totals, causes, map, the sites with '
       'the most reports, and a check of each one')


def rename(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, label=OLD[0]).update(label=NEW[0])
    MenuItem.objects.filter(path=PATH, description=OLD[1]).update(description=NEW[1])


def unrename(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, label=NEW[0]).update(label=OLD[0])
    MenuItem.objects.filter(path=PATH, description=NEW[1]).update(description=OLD[1])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0133_speed_bearer_subscriber_profile'),
    ]

    operations = [
        migrations.AddField(
            model_name='problemreport',
            name='cause',
            field=models.CharField(blank=True, default='', max_length=24),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='site',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                    related_name='problem_reports', to='core.site'),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='site_by',
            field=models.CharField(blank=True, default='', max_length=8),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='sector',
            field=models.CharField(blank=True, default='', max_length=64),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='classified_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name='problemreport',
            index=models.Index(fields=['happened_at'], name='v2_problem_happened_idx'),
        ),
        # Reports sent by another NTC system (core/external_problem.py).
        migrations.AlterField(
            model_name='problemreport',
            name='source',
            field=models.CharField(choices=[('app', 'Mobile app'), ('staff', 'Entered by staff'),
                                            ('external', 'Other system')], max_length=8),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='external_system',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='external_ref',
            field=models.CharField(blank=True, default='', max_length=80),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='api_key',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                    related_name='problem_reports', to='core.apikey'),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='located_by',
            field=models.CharField(blank=True, default='point', max_length=8),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='updated_at',
            field=models.DateTimeField(auto_now=True, default=django.utils.timezone.now),
            preserve_default=False,
        ),
        migrations.AddIndex(
            model_name='problemreport',
            index=models.Index(fields=['external_system', 'updated_at'], name='v2_problem_ext_updated_idx'),
        ),
        migrations.AddConstraint(
            model_name='problemreport',
            constraint=models.UniqueConstraint(condition=models.Q(source='external'),
                                               fields=('external_system', 'external_ref'),
                                               name='v2_problem_external_ref_uniq'),
        ),
        migrations.RunPython(rename, unrename),
    ]
