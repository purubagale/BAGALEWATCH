# Hand-authored data migration (2026-09-15) -- adds "RF Reports" as a new
# top-level MenuItem, so frontend-react/src/pages/RfReportsPage.tsx (the
# vendor RNO report importer) has a way to be reached from the sidebar.
# Same convention as every seed migration since 0028 -- created directly
# at the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts's OPAQUE_PATHS entry for
# '/rf-reports' and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# access=ACCESS_ADMIN ('admin' -- "Admin + superadmin only") rather than
# 'all' or 'permission' -- every write action on this feature
# (parse-preview/confirm-import/attachment upload, see
# RfOptimizationReportViewSet.get_permissions in core/rf_reports.py) is
# already admin/superadmin-only, and the list surfaces uploaded vendor
# documents/MOM attachments that aren't meant for every viewer role to
# browse the way the read-open Issues list is -- 'admin' gives both
# roles the menu entry immediately with no extra Permissions-matrix
# setup step, unlike 'permission' which needs a superadmin to grant it
# per-role before anyone can even see the link.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward, same as every migration in this file's own
# dependency chain asks for.
from django.db import migrations

PATH = '/g3q7nx'

ITEM = dict(
    label='RF Reports', link_type='route', path=PATH,
    access='admin', permission_key='', order=182, icon='📄',
    description='Vendor Radio Network Optimization report import (antenna change log, recommendations, MOM attachments)',
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
        ('core', '0061_rf_optimization_report'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
