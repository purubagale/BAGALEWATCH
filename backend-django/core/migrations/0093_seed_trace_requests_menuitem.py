# Data migration -- adds "Trace Requests" as a top-level MenuItem (2026-10-04),
# the operator console for device-bound, consent-gated tracing
# (core/device_trace.py's TraceRequestListCreateView and siblings).
#
# access='rescue' -- the same tier as Rescue Lookup (0049), because
# TraceRequest creation is gated by IsRescueOperator, which admits
# rescue_operator and superadmin. Seeded top-level rather than under a
# parent, matching 0049's own placement of the rescue lane.
#
# order=180 -- right after Rescue Policy (179, migration 0049).
# Path is opaque; keep it in sync with frontend-react/src/constants/opaqueRoutes.ts
# and MenuAdminPage.tsx's KNOWN_ROUTES.
from django.db import migrations

PATH = '/t7ak2m'

ITEM = dict(
    label='Trace Requests', link_type='route', path=PATH,
    access='rescue', permission_key='', order=180, icon='📍',
    description='Request a consent-gated location trace from a registered device, and track its consent and status',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if not MenuItem.objects.filter(path=PATH).exists():
        MenuItem.objects.create(**ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0092_device_trace'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
