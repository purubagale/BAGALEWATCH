# Data migration (2026-10-08) -- adds "Device Location Trace" as a new
# superadmin-only MenuItem, so core/device_lookup.py's
# DeviceLocationTraceView has a way to actually be reached from the
# sidebar. Same seeding convention as 0106_seed_rescue_enrolled_menuitem.py
# -- path kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts's '/device-location-trace'
# entry and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 186 -- right after Rescue Enrolled Devices (185, migration 0106).
from django.db import migrations

PATH = '/r9y3nk'

ITEM = dict(
    label='Device Location Trace', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=186, icon='🛰️',
    description='Resolve a phone number or IMEI to a device\'s latest telemetry position, no case reference required',
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
        ('core', '0107_deviceidentity_imei_lookup_devicelocationtracelog'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
