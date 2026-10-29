# Registered phones asked for readings in an area, with consent, and a
# complaint's registered location (2026-10-29).
import django.db.models.deletion
from django.db import migrations, models
from django.db.models import F


def app_reports_registered_where_sent(apps, schema_editor):
    """A report from the app was sent from where the phone was."""
    ProblemReport = apps.get_model('core', 'ProblemReport')
    ProblemReport.objects.filter(source='app').update(reported_lat=F('lat'), reported_lng=F('lng'))


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0151_coverage_prediction'),
    ]

    operations = [
        migrations.AddField(
            model_name='areasamplerequest',
            name='registered_asked',
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name='tracerequest',
            name='area_request',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                    related_name='traces', to='core.areasamplerequest'),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='reported_lat',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='problemreport',
            name='reported_lng',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.RunPython(app_reports_registered_where_sent, migrations.RunPython.noop),
    ]
