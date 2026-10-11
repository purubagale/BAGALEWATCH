# Data migration (2026-10-08) -- adds "Registered Devices" as a new
# superadmin-only MenuItem, so core/device_trace.py's new
# RegisteredDeviceListView has a way to actually be reached from the
# sidebar. Same seeding convention as 0108_seed_device_location_trace_
# menuitem.py -- path kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts's '/registered-devices'
# entry and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 187 -- right after Device Location Trace (186, migration 0108).
from django.db import migrations

PATH = '/r7t2wm'

ITEM = dict(
    label='Registered Devices', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=187, icon='📱',
    description='Every phone registered for NTC trace requests (DeviceCredential)',
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
        ('core', '0109_backfill_subscriberlastlocation_msisdn'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
