# Data migration — seeds MenuItem with the 14 nav entries that were
# hardcoded directly in Layout.tsx's JSX before this feature (2026-08-08,
# "add feature to add, update, delete top menu with submenu feature
# also"), transcribed exactly (same label, same path, same gating) so
# switching the header nav over to being DB-driven doesn't change what
# any existing user currently sees. None of these get a parent — no
# existing nav item had a submenu before this feature; submenus are a
# net-new capability an admin opts into later via the new Menu admin
# page. See MenuItem's docstring in models.py for what each `access`
# value means.
#
# `RunPython` with a reverse no-op (`migrations.RunPython.noop`), same
# convention as 0008_seed_dtband_defaults.py — nothing meaningful to
# "undo" beyond deleting the rows.
from django.db import migrations

# (label, link_type, path, access, permission_key, order)
DEFAULT_ITEMS = [
    ('Sites Topology', 'route', '/sites', 'all', '', 10),
    ('SLA', 'route', '/sla', 'permission', 'sla', 20),
    ('NTA', 'route', '/nta', 'permission', 'nta', 30),
    ('Monthly', 'route', '/monthly-report', 'permission', 'monthly', 40),
    ('Scatter', 'route', '/scatter', 'permission', 'scatter', 50),
    ('KPI Trend', 'route', '/kpi-trend', 'permission', 'kpitrend', 60),
    ('RF Audit', 'route', '/rf-audit', 'permission', 'rfaudit', 70),
    ('DT Data Manager', 'route', '/dt-data-manager', 'permission', 'rsrpmgr', 80),
    ('Thresholds', 'route', '/thresholds', 'permission', 'thresholds', 90),
    ('Tree', 'route', '/tree-admin', 'permission', 'tree', 100),
    ('Backup', 'route', '/backup', 'permission', 'backup', 110),
    ('Band Colors', 'route', '/dt-bands', 'admin', '', 120),
    ('Users', 'route', '/users', 'admin', '', 130),
    ('Permissions', 'route', '/permissions', 'superadmin', '', 140),
    # The new Menu admin page itself (2026-08-08) — seeded here too, same
    # reasoning as every other item: the nav is now fully DB-driven, so
    # even the page that manages MenuItem rows needs its own row to
    # appear in the header. Superadmin-only, matching who can manage
    # Users/Permissions.
    ('Menu Admin', 'route', '/menu-admin', 'superadmin', '', 150),
]


def seed_defaults(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    # Idempotent guard, matching 0008's convention — if this migration is
    # ever re-run against a DB that already has rows, don't duplicate them.
    if MenuItem.objects.exists():
        return
    MenuItem.objects.bulk_create([
        MenuItem(
            label=label, link_type=link_type, path=path,
            access=access, permission_key=permission_key, order=order,
        )
        for label, link_type, path, access, permission_key, order in DEFAULT_ITEMS
    ])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0009_menuitem'),
    ]

    operations = [
        migrations.RunPython(seed_defaults, migrations.RunPython.noop),
    ]
