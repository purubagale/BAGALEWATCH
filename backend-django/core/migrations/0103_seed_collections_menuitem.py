# Data migration -- adds "Collections" as a top-level MenuItem (2026-10-06): the
# session list for crowd drives, staff drives, operator traces and team drive tests
# (core/collection.py's CollectionSessionListView).
#
# access='admin' -- admin and superadmin. Device identity inside the list is shown
# only to users holding device.view_identity, enforced server-side.
#
# Path is opaque; keep it in sync with frontend-react/src/constants/opaqueRoutes.ts
# and MenuAdminPage.tsx's KNOWN_ROUTES.
from django.db import migrations

PATH = '/c5w8hn'
ITEM = dict(
    label='Collections', link_type='route', path=PATH,
    access='admin', permission_key='', order=181, icon='🗂️',
    description='Drives and traces collected from phones: crowd, staff, operator and team drive tests',
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
        ('core', '0102_collection_session_ended'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
