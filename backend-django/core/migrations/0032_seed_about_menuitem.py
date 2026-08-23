# Data migration — adds "About" as a top-level MenuItem (2026-08-23, "need
# about page in menuitem also"), so AboutPage.tsx is reachable from the
# sidebar as well as from the version chip under the brand name.
#
# `access='all'` (ACCESS_ALL, "Any signed-in user") — NOT the permission
# matrix. Deliberate: ACCESS_PERMISSION is default-deny for admin/viewer
# until a superadmin grants a row on the Permissions page (see
# MenuItem.ACCESS_CHOICES' docstring in models.py), which for an About page
# would mean it silently doesn't appear for most of the org until someone
# notices. There is nothing to authorise here — it shows the build version
# and nothing else — so no MenuPermission rows are needed either.
#
# PATH IS NOT OBFUSCATED, unlike every other item seeded since 0028. The
# opaque-path convention exists to keep feature URLs from advertising what
# the system does; '/about' advertises nothing, and the page is already
# linked as '/about' from the sidebar version chip and registered as a
# static route in App.tsx. Giving it an opaque alias would mean two URLs for
# one page and an OPAQUE_PATHS entry that earns nothing. See the note added
# alongside OPAQUE_PATHS in frontend-react/src/constants/opaqueRoutes.ts.
#
# order=180 puts it after API Access (170), i.e. last — an About entry
# belongs at the bottom of the sidebar, not among the operational pages.
#
# `RunPython` with a reverse that deletes the row, same convention as every
# other seed migration here.
from django.db import migrations

ABOUT_PATH = '/about'


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=ABOUT_PATH).exists():
        return
    MenuItem.objects.create(
        label='About', link_type='route', path=ABOUT_PATH,
        access='all', permission_key='', order=180,
        icon='ℹ️', description='Application version and build information',
    )


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=ABOUT_PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0031_user_auth_source_user_sso_subject'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
