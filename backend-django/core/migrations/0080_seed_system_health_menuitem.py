# Data migration -- adds "System Health" as a real MenuItem child of the
# "App Data Mgmt" parent (2026-10-01, "idea and plan" follow-up to the UTS
# reference screenshots). Lets
# frontend-react/src/pages/SystemHealthPage.tsx be reached from the
# sidebar, next to Users/Permissions/Menu Admin/Access Log -- the same
# group this superadmin-only diagnostics cluster already lives in.
#
# access='superadmin' -- matches SystemHealthView's own gate
# (core/views.py) and this group's other infra-revealing siblings
# (Access Log, API Access, Live Site Sync): this page shows live Redis/DB/
# disk state, not something an ordinary admin needs or should see.
#
# Same defensive parent lookup as every seed migration since 0028 (by
# label with a top-level fallback, in case a superadmin has since renamed
# or removed "App Data Mgmt" on a given install), and same
# created-directly-at-the-final-opaque-path convention -- kept in sync
# with frontend-react/src/constants/opaqueRoutes.ts ('/s7m3kx') and
# MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 165 -- right after Access Log (155) and the RBAC trio (160/161/
# 162), still inside App Data Mgmt.
from django.db import migrations

PATH = '/s7m3kx'

ITEM = dict(
    label='System Health', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=165, icon='📈',
    description='Live diagnostic dashboard -- database, Redis, disk headroom, and background sync status',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=PATH).exists():
        return
    parent = MenuItem.objects.filter(label='App Data Mgmt', parent__isnull=True).first()
    MenuItem.objects.create(parent=parent, **ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0079_seed_rbac_menuitems'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
