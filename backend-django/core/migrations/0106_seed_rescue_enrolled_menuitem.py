# Data migration (2026-10-07) -- adds "Rescue Enrolled Devices" as a new
# superadmin-only MenuItem, so core/rescue.py's new RescueEnrolledListView
# (see that view's own docstring for why it's a deliberate, provisional
# exception to Rescue Lookup's "never browse/list" rule, not a quiet
# reinterpretation of it) has a way to actually be reached from the
# sidebar. Same seeding convention as 0049_rescue_menu_items.py --
# path kept in sync with frontend-react/src/constants/opaqueRoutes.ts's
# '/rescue-enrolled' entry and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 185 -- right after VoLTE Quality (184, migration
# 0096_telemetry_cqi_derived.py's own seed, going by the highest order
# value already in use at the time this was written).
from django.db import migrations

PATH = '/r8x4ml'

ITEM = dict(
    label='Rescue Enrolled Devices', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=185, icon='📋',
    description='Provisional superadmin-only list of every device currently opted in to the Rescue Location beacon',
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
        ('core', '0105_telemetrydrivetestsession_max_duration_minutes'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
