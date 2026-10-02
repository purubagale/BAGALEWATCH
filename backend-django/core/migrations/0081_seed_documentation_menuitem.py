# Data migration -- adds "Documentation" as a real, TOP-LEVEL MenuItem
# (2026-10-01, "idea and plan" follow-up to the UTS reference screenshots).
# Lets frontend-react/src/pages/DocumentationPage.tsx be reached from the
# sidebar.
#
# Deliberately NOT nested under "App Data Mgmt" (unlike this migration's
# first draft, and unlike this session's other recent additions there --
# Access Log, System Health, the RBAC trio): get_visible_menu_items()
# (core/views.py) only considers a child's OWN access check if its parent
# already passed its own -- "an item whose ancestor is hidden at ANY depth
# can't leak through" (see that function's docstring). "App Data Mgmt" is
# itself access='superadmin', so nesting an access='admin' item under it
# would make it invisible to a plain admin regardless of its own tier --
# confirmed as a real bug via a live menu-tree fetch as a test admin user
# before this migration was corrected, not a hypothetical. Documentation
# is also not semantically an "App Data Mgmt" action anyway (nothing here
# manages data) -- a top-level item alongside Dashboard/Sites
# Topology/Report/Telemetry is the better fit on both counts.
#
# access='admin' (admin + superadmin) -- this is read-only reference
# material, not a sensitive action, matching "Report" (the other
# access='admin' top-level item) rather than "App Data Mgmt"/"Setting"/
# "Telemetry" (all access='superadmin').
#
# Same created-directly-at-the-final-opaque-path convention as every seed
# migration since 0028 -- kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts ('/d9w4nr') and
# MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 170 -- between Telemetry (125) and About (180), the existing
# top-level order values.
from django.db import migrations

PATH = '/d9w4nr'

ITEM = dict(
    label='Documentation', link_type='route', path=PATH,
    access='admin', permission_key='', order=170, icon='📚',
    description='Architecture notes, audits, deployment guides, and decision records for this project',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=PATH).exists():
        return
    MenuItem.objects.create(parent=None, **ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0080_seed_system_health_menuitem'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
