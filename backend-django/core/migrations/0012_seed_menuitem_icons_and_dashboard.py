# Data migration — backfills icon/description on the 15 MenuItem rows
# seeded by 0010, and adds a new "Dashboard" row (2026-08-08 follow-up:
# "left panel for menu and submenu (icon display with detail on hover)...
# after login, display dashboard should be like this"). Dashboard becomes
# order=0 (first in the sidebar, ABOVE Sites Topology) — see
# RootRedirect in App.tsx, which now sends a freshly-logged-in user to
# /dashboard instead of /sites.
#
# Icons are plain emoji (see MenuItem.icon's docstring for why — zero
# extra assets/dependencies), one per item, chosen for quick visual
# recognition in the collapsed sidebar rail rather than literal accuracy.
# Descriptions are the one-line detail shown on sidebar hover and reused
# as a Dashboard shortcut card's body text.
#
# `RunPython` with a reverse no-op, same convention as 0008/0010 — only
# forward-seeds/updates existing rows, matched by `path` (stable across
# this migration since 0010 already fixed every path).
from django.db import migrations

# path -> (icon, description)
ICONS = {
    '/sites': ('🗺️', 'Site map, sidebar tree, and per-site KPI detail'),
    '/sla': ('📶', 'SLA compliance tracker by region'),
    '/nta': ('✅', 'NTA compliance reporting'),
    '/monthly-report': ('📅', 'Monthly KPI summary report'),
    '/scatter': ('📈', 'KPI scatter plot explorer'),
    '/kpi-trend': ('📊', 'KPI trend over time'),
    '/rf-audit': ('🛠️', 'RF configuration audit'),
    '/dt-data-manager': ('🚗', 'Drive-test session upload, coverage maps, and history'),
    '/thresholds': ('🎚️', 'KPI threshold configuration'),
    '/tree-admin': ('🌳', 'Custom province/district tree structure'),
    '/backup': ('💾', 'Export/restore site data, scoped Excel export'),
    '/dt-bands': ('🎨', 'Drive-test coverage band colors'),
    '/users': ('👥', 'User accounts'),
    '/permissions': ('🔐', 'Role permission matrix'),
    '/menu-admin': ('🧭', 'Top menu structure — add, edit, delete, and reorder'),
}


def seed_icons_and_dashboard(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for path, (icon, description) in ICONS.items():
        MenuItem.objects.filter(path=path).update(icon=icon, description=description)

    if not MenuItem.objects.filter(path='/dashboard').exists():
        MenuItem.objects.create(
            label='Dashboard', link_type='route', path='/dashboard',
            access='all', permission_key='', order=0,
            icon='🏠', description='Your customizable home screen — summary stats and shortcuts',
        )


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0011_menuitem_description_menuitem_icon'),
    ]

    operations = [
        migrations.RunPython(seed_icons_and_dashboard, migrations.RunPython.noop),
    ]
