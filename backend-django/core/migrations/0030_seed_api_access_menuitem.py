# Data migration — adds "API Access" as a new top-level MenuItem
# (2026-08-12, "add feature to create api to share certain data of system
# to other and to receive certain data from other system") so
# ApiAccessPage.tsx has a way to be reached from the sidebar. Superadmin-
# only (`access='superadmin'`, `permission_key=''`) — matches every other
# app-wide-setting page (Users, Permissions, Menu Admin, Branding, see
# 0015_seed_branding_menuitem.py) and the explicit user decision for this
# feature (AskUserQuestion, 2026-08-12: "Superadmin only, via a new admin
# page"). No MenuPermission rows needed for a `superadmin`-access item —
# that access level is checked directly against `User.role`, not the
# read/write/update/delete permission matrix (see MenuItem.ACCESS_CHOICES'
# docstring in models.py).
#
# Created directly at its final opaque path (matches the more recent
# 0028_seed_trp_analysis_submenu.py convention — a descriptive path first,
# then a later obfuscation migration — is only how the ORIGINAL 15 items
# from 0010 were handled; every item added since 0028's era gets seeded
# with its opaque path from day one). Keep '/n8w5qk' in sync with
# frontend-react/src/constants/opaqueRoutes.ts's OPAQUE_PATHS entry for
# '/api-access', same convention every other row in that map follows.
#
# `RunPython` with a reverse no-op, same convention as every other seed
# migration in this app.
from django.db import migrations

API_ACCESS_PATH = '/n8w5qk'


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=API_ACCESS_PATH).exists():
        return
    MenuItem.objects.create(
        label='API Access', link_type='route', path=API_ACCESS_PATH,
        access='superadmin', permission_key='', order=170,
        icon='🔑', description='Manage API keys for sharing/receiving data with other systems',
    )


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=API_ACCESS_PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0029_apikey'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
