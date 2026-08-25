# Data migration (2026-08-25, "before going to live, update user permission
# with the latest updates also"). Root cause of the same day's Permissions-
# page crash (see PermissionsMatrixView.get()'s own comment): MenuPermission
# has NEVER had a seed migration, unlike MenuItem (0010_seed_menuitem_
# defaults). Every row only ever came from a superadmin manually visiting
# the Permissions page and clicking Save — so any install where that never
# happened (a fresh DB, or specifically this app's live/staging deploy) has
# ZERO rows, meaning every permission-gated menu is invisible to admin/
# viewer by default (isAllowed() treats "no row" as "not allowed").
#
# Values below are transcribed exactly from v1's DEFAULT_PERMS in
# bagalewatch_api.py (not invented here) — PermissionsMatrixView's own
# docstring already says v2 "matches v1's /api/v1/permissions contract
# exactly", so this migration is just giving that contract the same DEFAULT_
# PERMS v1 always seeded a fresh install with. One key is deliberately
# dropped: v1's 'topology' — the standalone Topology nav item it gated was
# retired 2026-08-05 and folded into 'sites' (see PermissionsPage.tsx's own
# comment on CRUD_MENU_KEYS), so there is no v2 menu left for that key to
# gate.
#
# Backfill-only, per (role, menu_key) combo — NOT "only if the table is
# totally empty" — mirroring v1's own _initialize_db() backfill branch
# exactly (see bagalewatch_api.py: "Backfill any (role, menu_key) combo with
# zero rows at all... Never touches a combo that already has rows, so
# deliberately-customized grants are left untouched"). This matters because
# a partially-configured install (e.g. an admin who saved custom grants for
# some menus already) must not have those overwritten — only combos with
# NO rows at all get the default.
from django.db import migrations


def _crud(read=False, write=False, update=False, delete=False):
    return {'read': read, 'write': write, 'update': update, 'delete': delete}


CRUD_MENUS = ('sites', 'rsrpmgr', 'tree', 'thresholds', 'datasource', 'backup', 'kpireports')

DEFAULT_PERMS = {
    'admin': {
        'sites':      _crud(True, True, True, True),
        'rsrpmgr':    _crud(True, True, True, True),
        'reports': True, 'rfaudit': True, 'kpitrend': True,
        'kpireports': _crud(True, True, True, True),
        'nta': True, 'monthly': True, 'scatter': True,
        'tree':       _crud(True, True, True, True),
        # Thresholds/Data Source/Backup default OFF for admin, matching v1
        # exactly — a superadmin has to explicitly grant them.
        'thresholds': _crud(False, False, False, False),
        'datasource': _crud(False, False, False, False),
        'backup':     _crud(False, False, False, False),
        'sla': True,
    },
    'viewer': {
        'sites':      _crud(False, False, False, False),
        'rsrpmgr':    _crud(True, False, False, False),
        'reports': True, 'rfaudit': False, 'kpitrend': True,
        'kpireports': _crud(True, False, False, False),
        'nta': True, 'monthly': True, 'scatter': False,
        'tree':       _crud(False, False, False, False),
        'thresholds': _crud(False, False, False, False),
        'datasource': _crud(False, False, False, False),
        'backup':     _crud(False, False, False, False),
        'sla': True,
    },
}


def seed_menu_permission_defaults(apps, schema_editor):
    MenuPermission = apps.get_model('core', 'MenuPermission')
    existing = set(
        MenuPermission.objects.values_list('role', 'menu_key').distinct()
    )
    to_create = []
    for role, perms in DEFAULT_PERMS.items():
        for menu_key, value in perms.items():
            if (role, menu_key) in existing:
                continue
            if menu_key in CRUD_MENUS:
                for action, allowed in value.items():
                    to_create.append(MenuPermission(role=role, menu_key=menu_key, action=action, allowed=allowed))
            else:
                to_create.append(MenuPermission(role=role, menu_key=menu_key, action='read', allowed=value))
    if to_create:
        MenuPermission.objects.bulk_create(to_create)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0033_brandingsettings_idle_timeout_minutes'),
    ]

    operations = [
        migrations.RunPython(seed_menu_permission_defaults, migrations.RunPython.noop),
    ]
