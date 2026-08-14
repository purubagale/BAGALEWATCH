# Data migration — splits the "DT Data Manager" MenuItem's three former
# in-page tabs (Upload / Session History / Explore, all rendered by one
# monolithic DtDataManagerPage.tsx) into three real MenuItem children of
# that same row (2026-08-09 request: "manage upload, manage session and
# explore in different sub menu item for DT data manager not in
# different tab on same page").
#
# The existing "DT Data Manager" row (seeded by 0010, path renamed to
# '/w7h1sd' by 0018) is left completely untouched here — it keeps
# existing exactly as it is, still gated on access='permission'/
# permission_key='rsrpmgr'. Once it has these three children,
# MenuSectionGate.tsx on the frontend automatically shows them as an
# auto-generated section listing instead of rendering a page of its own
# (see App.tsx's route for '/dt-data-manager', which no longer imports a
# page component at all) — the exact same mechanism every other
# multi-child top-level item in this app already uses; no new frontend
# concept needed for this to work.
#
# The three children reuse the SAME permission_key='rsrpmgr' the parent
# already used — this deliberately does not require a superadmin to grant
# a new permission after upgrading; anyone who could already reach DT
# Data Manager can reach all three of its new children with no extra
# Permissions-page step. `access='permission'` was already the parent's
# access value pre-split, so this preserves exactly what admin/viewer
# could already see.
#
# `RunPython` with a reverse no-op, same convention as every other seed
# migration in this app (0008/0010/0015).
from django.db import migrations

# (label, path, icon, description, order)
CHILDREN = [
    ('Upload', '/n4v8gz', '⬆️', 'Upload a CSV/TXT/XLSX drive-test template', 10),
    ('Session History', '/s2h6mp', '🕓', 'Browse and compare saved drive-test sessions', 20),
    ('Explore', '/e7x3kt', '🧭', 'Search by coordinates, city, district, or Site ID', 30),
]


def seed_children(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    parent = MenuItem.objects.filter(path='/w7h1sd').first()
    if parent is None:
        # Best-effort / idempotent, same convention as 0015 — if the
        # parent row was renamed away from its seeded default or deleted
        # entirely before this migration ran, there's nothing sensible to
        # attach children to; skip rather than error.
        return
    for label, path, icon, description, order in CHILDREN:
        if MenuItem.objects.filter(path=path).exists():
            continue
        MenuItem.objects.create(
            label=label, link_type='route', path=path, parent=parent,
            order=order, access=parent.access, permission_key=parent.permission_key,
            icon=icon, description=description,
        )


def remove_children(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path__in=[path for _, path, _, _, _ in CHILDREN]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0019_obfuscate_dashboard_sites_paths'),
    ]

    operations = [
        migrations.RunPython(seed_children, remove_children),
    ]
