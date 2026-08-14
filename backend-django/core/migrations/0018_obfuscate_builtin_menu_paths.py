# Data migration — renames the built-in (seeded) MenuItem rows' `path`
# from descriptive slugs (e.g. '/sla') to opaque, non-descriptive tokens
# (2026-08-08 request: "secure the dynamic path url of the inside system
# page so that no one can see the actual path"). Per the accompanying
# security review: a URL is always visible to whoever is looking at their
# own browser's address bar, so this is explicitly COSMETIC, not real
# access control — real protection here is the server-side auth/
# permission checks on every API call, which are unaffected by what the
# frontend route happens to be named (see RUNBOOK.md's "Login-page
# security hardening" section for the full writeup, and AskUserQuestion
# confirmation that the user wanted this in addition to, not instead of,
# real access-control hardening).
#
# ADDITIVE, NOT A BREAKING RENAME: App.tsx keeps the OLD descriptive path
# mounted too, as a plain redirect to the new opaque one — any existing
# bookmark or shared link still works, it just immediately redirects.
# Going forward, the sidebar/dashboard/breadcrumb only ever generate the
# new opaque links, since they're built from MenuItem.path directly.
#
# Scope: ONLY the 15 top-level items confirmed (via a full src/ grep
# audit) to have NO hardcoded path references anywhere outside App.tsx /
# Layout.tsx / DashboardPage.tsx / MenuAdminPage.tsx's generic
# menu-rendering code. `/sites` was deliberately EXCLUDED — it has 9
# scattered hardcoded `/sites/${id}` references across
# AdvancedSiteSearchModal.tsx, SidebarTree.tsx, TopologyMap.tsx,
# ScatterPlotPage.tsx, SiteDetailPage.tsx, and SitesPage.tsx; renaming it
# would require finding and updating every one of those with real risk of
# missing one and silently breaking navigation on this app's
# highest-traffic page. `/dashboard` and `/login` were excluded as
# special-cased, non-"system feature" routes.
#
# THE TOKEN MAPPING BELOW MUST STAY IN SYNC with the identical mapping in
# frontend-react/src/App.tsx (route registration) and
# frontend-react/src/pages/MenuAdminPage.tsx (KNOWN_ROUTES datalist) — see
# the "KEEP IN SYNC" comment in both those files.
from django.db import migrations

PATH_RENAMES = {
    '/sla': '/p3k7q2',
    '/nta': '/x9f1lz',
    '/monthly-report': '/h4t8vn',
    '/scatter': '/b6r0wc',
    '/kpi-trend': '/q2n5je',
    '/rf-audit': '/z8m3ky',
    '/dt-data-manager': '/w7h1sd',
    '/thresholds': '/k5c9bf',
    '/tree-admin': '/r2v6mt',
    '/backup': '/f9j4qs',
    '/dt-bands': '/t3n7hy',
    '/users': '/d8k2wr',
    '/permissions': '/y5b1qx',
    '/menu-admin': '/c4h9lt',
    '/branding': '/j6r3fp',
}


def obfuscate_paths(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for old_path, new_path in PATH_RENAMES.items():
        # Best-effort / idempotent, same convention as 0015's seed
        # migration: if a row with the old path doesn't exist (already
        # renamed, or a superadmin customized it away from the seeded
        # default before this migration ran), just skip it rather than
        # erroring.
        MenuItem.objects.filter(path=old_path).update(path=new_path)


def restore_paths(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for old_path, new_path in PATH_RENAMES.items():
        MenuItem.objects.filter(path=new_path).update(path=old_path)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0017_brandingsettings_login_button_text_and_more'),
    ]

    operations = [
        migrations.RunPython(obfuscate_paths, restore_paths),
    ]
