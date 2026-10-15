# 2026-10-15. TelemetrySpeedResult.bearer: the connection a speed test used
# (mobile data or Wi-Fi). And the "Subscriber Profile" menu item
# (core/subscriber_profile.py, superadmin). The menu path is kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts and MenuAdminPage.tsx's
# KNOWN_ROUTES list.
from django.db import migrations, models

PATH = '/s7p2nd'

ITEM = dict(
    label='Subscriber Profile', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=193, icon='🪪',
    description='Everything stored about one mobile number: phones, sessions, tests and reports, for solving a customer problem',
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
        ('core', '0132_calls_and_sdk_link'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetryspeedresult',
            name='bearer',
            field=models.CharField(blank=True, choices=[('mobile', 'Mobile data'), ('wifi', 'Wi-Fi')], default='', max_length=8),
        ),
        migrations.RunPython(seed, unseed),
    ]
