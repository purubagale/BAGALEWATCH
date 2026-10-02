# Data migration (2026-10-01) -- adds "Manage Roles", "Assign Roles", and
# "Menu Visibility" as real MenuItem children of the "App Data Mgmt"
# parent, next to Users/Permissions/Menu Admin -- the same superadmin-only
# account-management cluster, same reasoning as
# 0072_seed_telemetry_live_samples_menuitem.py's own comment for why the
# parent is looked up by label with a top-level fallback rather than a
# hardcoded path (this group's own parent was never migration-created in
# the first place, only ever built through MenuAdminPage's UI).
#
# access='superadmin' on all three, matching their two most sensitive
# siblings (Permissions, Menu Admin) -- creating/renaming/deleting roles,
# reassigning who holds them, and overriding menu visibility are all
# exactly the kind of account-management actions this app already
# reserves for superadmin everywhere else.
#
# Same convention as every seed migration since 0028: created directly at
# the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts and MenuAdminPage.tsx's
# KNOWN_ROUTES list.
#
# orders 160/161/162 -- right after Access Log (155), still inside App
# Data Mgmt.
from django.db import migrations

ITEMS = [
    dict(
        label='Manage Roles', link_type='route', path='/q4m8rz',
        access='superadmin', permission_key='', order=160, icon='🏷️',
        description='Create, rename, and delete custom roles',
    ),
    dict(
        label='Assign Roles', link_type='route', path='/v6p2nt',
        access='superadmin', permission_key='', order=161, icon='🧑‍🤝‍🧑',
        description='Grant or revoke roles for a user',
    ),
    dict(
        label='Menu Visibility', link_type='route', path='/h3k9wq',
        access='superadmin', permission_key='', order=162, icon='🧭',
        description='Per-role overrides for which sidebar items a role can see',
    ),
]


def seed_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    parent = MenuItem.objects.filter(label='App Data Mgmt', parent__isnull=True).first()
    for item in ITEMS:
        if not MenuItem.objects.filter(path=item['path']).exists():
            MenuItem.objects.create(parent=parent, **item)


def remove_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path__in=[item['path'] for item in ITEMS]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0078_backfill_user_roles'),
    ]

    operations = [
        migrations.RunPython(seed_menu_items, remove_menu_items),
    ]
