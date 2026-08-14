# Data migration — adds a "Branding" MenuItem (2026-08-08 follow-up:
# "also add feature to customize logo and name") so the new
# BrandingPage.tsx has a way to be reached from the sidebar at all — the
# nav is fully DB-driven now (see 0010_seed_menuitem_defaults.py), so
# even this settings page needs its own row, same as Menu Admin did.
# Superadmin-only, matching every other app-wide-setting page
# (Permissions, Menu Admin, Users).
#
# `RunPython` with a reverse no-op, same convention as every other seed
# migration in this app.
from django.db import migrations


def seed_branding_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path='/branding').exists():
        return
    MenuItem.objects.create(
        label='Branding', link_type='route', path='/branding',
        access='superadmin', permission_key='', order=160,
        icon='🏷️', description='Customize the app logo and name',
    )


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0014_brandingsettings'),
    ]

    operations = [
        migrations.RunPython(seed_branding_menu_item, migrations.RunPython.noop),
    ]
