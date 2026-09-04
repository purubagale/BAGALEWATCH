# Data migration — adds "Telemetry Drive Test" as a new top-level
# MenuItem (2026-09-01), so frontend-react/src/pages/
# TelemetryDriveTestSessionsPage.tsx has a way to be reached from the
# sidebar. Same convention as 0041_seed_telemetry_menuitems.py — kept in
# sync with frontend-react/src/constants/opaqueRoutes.ts's OPAQUE_PATHS
# entry for '/telemetry-dt-sessions' and MenuAdminPage.tsx's KNOWN_ROUTES
# list.
#
# access='admin' (IsAdminOrSuperadmin) matches
# TelemetryDriveTestSessionListCreateView's permission tier in
# core/telemetry_admin.py — deliberately NOT superadmin-only, unlike
# Telemetry Admin (176): this feature is safe for an ordinary
# network-planning admin precisely because it's scoped to
# explicitly-enrolled devices, not "any recent sample from anyone" the
# way the raw Live Samples dev tool is (which stays unlisted/superadmin,
# see 0041's own comment).
#
# order 177 — between Telemetry Admin (176) and About (180).
from django.db import migrations

PATH = '/t6q9lp'

ITEM = dict(
    label='Telemetry Drive Test', link_type='route', path=PATH,
    access='admin', permission_key='', order=177, icon='🚗',
    description='Scoped live drive-test sessions over the crowdsourced-telemetry pipeline',
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
        ('core', '0043_rescue_and_dt_sessions'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
