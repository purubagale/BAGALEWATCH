# Data migration (2026-10-08) -- adds "Area Sample" as a MenuItem for
# core/area_sample.py's on-demand area sample. Same seeding convention as
# 0110_seed_registered_devices_menuitem.py: path kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts's '/area-sample' entry and
# MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# access='admin' -- admin and superadmin, matching the view's own
# IsAdminOrSuperadmin and the Telemetry Drive Test page next to it.
from django.db import migrations

PATH = '/a4s7pq'

ITEM = dict(
    label='Area Sample', link_type='route', path=PATH,
    access='admin', permission_key='', order=188, icon='📡',
    description='Ask the devices sharing in an area for a fresh signal reading',
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
        ('core', '0111_area_sample'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
