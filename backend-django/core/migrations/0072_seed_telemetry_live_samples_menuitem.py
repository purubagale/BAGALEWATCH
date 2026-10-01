# Data migration — adds "Live Samples" as a real MenuItem child of the
# "Telemetry" parent (2026-09-30, "manage live sample page seperately in
# menu inside telemetry with superadmin permission"). Until now
# frontend-react/src/pages/TelemetryLiveSamplesPage.tsx was only reachable
# via a plain <a href> button in TelemetryAdminPage.tsx's "Dev tools"
# section (see that page's own comment, and opaqueRoutes.ts's
# '/telemetry-live-samples' entry, which explicitly noted "deliberately
# has NO seeded MenuItem" up to now) — never listed in the sidebar at all.
#
# access='superadmin' matches the "Dev tools" section's own stated intent
# ("Superadmin-only, not linked from the main menu" -- the second half of
# that sentence is what this migration changes) and TelemetryLiveSamplesPage
# itself: a raw per-sample dev/pilot-testing view, not a feature an
# ordinary network-planning admin needs (unlike its sibling "Telemetry
# Drive Test", which is deliberately access='admin' -- see
# 0044_seed_telemetry_dt_session_menuitem.py's own comment for that
# distinction).
#
# The "Telemetry" parent group itself was NEVER created by a migration --
# 0041/0044 seeded "Telemetry Coverage"/"Telemetry Admin"/"Telemetry Drive
# Test" as three flat TOP-LEVEL items; grouping them under one "Telemetry"
# parent was done later by a superadmin directly through MenuAdminPage's
# own UI, which means it may or may not exist yet (and, if it does, at
# whatever opaque path that UI action happened to generate) on any given
# database -- looked up by label below, not a hardcoded path, for exactly
# that reason. Falls back to a top-level item if no such group exists
# anywhere yet, so this migration still does something useful on a fresh
# install or a live database where that manual reorg was never done,
# rather than silently skipping the way 0020/0028's child-seeders do for a
# parent they know was migration-created and could only be MISSING via
# deletion.
#
# Same convention as every seed migration since 0028: created directly at
# the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts ('/telemetry-live-samples')
# and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# order 178 -- after Telemetry Drive Test (177), whether nested under a
# Telemetry group or, on an environment without one, sitting alongside it
# at the top level.
from django.db import migrations

PATH = '/z3q8mn'

ITEM = dict(
    label='Live Samples', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=178, icon='🧪',
    description='Raw, per-sample view for verifying test-device telemetry uploads during development',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=PATH).exists():
        return
    parent = MenuItem.objects.filter(label='Telemetry', parent__isnull=True).first()
    MenuItem.objects.create(parent=parent, **ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0071_sector_rf_database_fields'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
