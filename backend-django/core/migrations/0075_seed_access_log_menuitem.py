# Data migration — adds "Access Log" as a real MenuItem child of the
# "App Data Mgmt" parent (2026-10-01, "create one menu item to display
# current log or history of the application with user or any
# unauthentic access tried in the application"). Lets
# frontend-react/src/pages/AccessLogPage.tsx be reached from the sidebar,
# next to Users/Permissions/Menu Admin -- the same group this
# superadmin-only account-management cluster already lives in.
#
# access='superadmin' -- matches AuthEventLogListView's own gate
# (core/auth_log.py) and this group's two most sensitive siblings
# (Permissions, Menu Admin): this is the exact feed a brute-force/
# enumeration investigation would read.
#
# The "App Data Mgmt" parent group was itself seeded by an earlier
# migration as a real top-level MenuItem (unlike "Telemetry", which per
# 0072's own comment was only ever created by hand through MenuAdminPage's
# UI) -- looked up by label with a top-level fallback anyway, same
# defensive convention as 0072, in case a superadmin has since renamed or
# removed it on a given install.
#
# Same convention as every seed migration since 0028: created directly at
# the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts ('/access-log') and
# MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 155 -- right after Menu Admin (150), before Branding (unordered
# in this group but numerically higher), still inside App Data Mgmt.
from django.db import migrations

PATH = '/a3x9lq'

ITEM = dict(
    label='Access Log', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=155, icon='🛡️',
    description='Login/access audit trail -- every sign-in attempt, local or SSO, successful or not',
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
        ('core', '0074_auth_event_log'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
