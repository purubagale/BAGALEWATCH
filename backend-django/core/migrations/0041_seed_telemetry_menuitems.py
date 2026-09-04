# Data migration — adds "Telemetry Coverage" and "Telemetry Admin" as two
# new top-level MenuItems (2026-08-31), so the crowdsourced-telemetry
# pages (frontend-react/src/pages/TelemetryCoveragePage.tsx and
# TelemetryAdminPage.tsx) have a way to be reached from the sidebar.
#
# Same convention as every seed migration since 0028: created directly at
# the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts (OPAQUE_PATHS entries for
# '/telemetry-coverage' and '/telemetry-admin') and MenuAdminPage.tsx's
# KNOWN_ROUTES list.
#
# Access split mirrors the endpoints in core/telemetry_admin.py:
#   * Coverage  — access='admin'      (IsAdminOrSuperadmin) — a read-only
#     map, same tier as Live Site Sync's status view.
#   * Admin     — access='superadmin' (IsSuperadminOnly)    — mints/revokes
#     ingest credentials, same tier as API Access / Users / Permissions.
#
# order 174 / 176 — right after Live Site Sync (172), before About (180):
# the superadmin technical/integration cluster, not the SLA/NTA/KPI
# reporting cluster.
from django.db import migrations

COVERAGE_PATH = '/t7m2kq'
ADMIN_PATH = '/t4v9cx'

ITEMS = [
    dict(
        label='Telemetry Coverage', link_type='route', path=COVERAGE_PATH,
        access='admin', permission_key='', order=174, icon='📡',
        description='Crowdsourced-telemetry coverage map (geohash-binned RSRP / RSRQ / SINR)',
    ),
    dict(
        label='Telemetry Admin', link_type='route', path=ADMIN_PATH,
        access='superadmin', permission_key='', order=176, icon='🛰️',
        description='Ingest keys and volume overview for the crowdsourced-telemetry pilot',
    ),
]


def seed_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for item in ITEMS:
        if not MenuItem.objects.filter(path=item['path']).exists():
            MenuItem.objects.create(**item)


def remove_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path__in=[COVERAGE_PATH, ADMIN_PATH]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0040_telemetry'),
    ]

    operations = [
        migrations.RunPython(seed_menu_items, remove_menu_items),
    ]
