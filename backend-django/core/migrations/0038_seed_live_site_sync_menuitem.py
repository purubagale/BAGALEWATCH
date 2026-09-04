# Data migration — adds "Live Site Sync" as a new top-level MenuItem
# (2026-08-26), so LiveSiteSyncPage.tsx has a way to be reached from the
# sidebar. Superadmin-only (`access='superadmin'`, `permission_key=''`),
# same tier as API Access/Users/Branding/Menu Admin — this page shows sync
# status and lets an admin trigger a manual sync of Site data from an
# external source, not something an admin/viewer role needs.
#
# Created directly at its final opaque path (the post-0028 convention —
# see 0030_seed_api_access_menuitem.py's own comment on this). Keep
# '/l9x4rq' in sync with frontend-react/src/constants/opaqueRoutes.ts's
# OPAQUE_PATHS entry for '/live-site-sync'.
#
# order=172 — right after API Access (170), before About (180): another
# superadmin technical/integration tool, not a reporting page, so it
# belongs in that cluster rather than among SLA/NTA/KPI Trend etc.
from django.db import migrations

LIVE_SITE_SYNC_PATH = '/l9x4rq'


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=LIVE_SITE_SYNC_PATH).exists():
        return
    MenuItem.objects.create(
        label='Live Site Sync', link_type='route', path=LIVE_SITE_SYNC_PATH,
        access='superadmin', permission_key='', order=172,
        icon='🔄', description='Status and manual trigger for the Live Site Directory sync',
    )


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=LIVE_SITE_SYNC_PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0037_livesitesyncstatus'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
