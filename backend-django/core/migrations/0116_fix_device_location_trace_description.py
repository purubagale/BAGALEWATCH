# Data migration (2026-10-10) -- corrects the "Device Location Trace"
# MenuItem description seeded by 0108. It said "no case reference required",
# but since 2026-10-08 core/device_lookup.py needs a case reference and an
# active emergency for every search. Only the seeded text is replaced, so a
# description a superadmin has edited in Menu Admin is left alone.
from django.db import migrations

PATH = '/r9y3nk'

OLD = 'Resolve a phone number or IMEI to a device\'s latest telemetry position, no case reference required'
NEW = (
    'Resolve a phone number or IMEI to a device\'s latest position. '
    'Needs an active emergency and a case reference'
)


def fix(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, description=OLD).update(description=NEW)


def unfix(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, description=NEW).update(description=OLD)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0115_backfill_subscriber_device'),
    ]

    operations = [
        migrations.RunPython(fix, unfix),
    ]
