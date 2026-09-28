# Hand-authored data migration (2026-09-23) -- adds "DT Plot Catalog" as a
# new top-level MenuItem, so frontend-react/src/pages/DtPlotCatalogPage.tsx
# (the static reference table for the 2.4.1-2.4.38 drive-test report
# checklist -- see frontend-react/src/lib/dtPlotCatalog.ts's own docstring)
# has a way to be reached from the sidebar. Same convention as every seed
# migration since 0028 -- created directly at the final opaque path, kept
# in sync with frontend-react/src/constants/opaqueRoutes.ts's OPAQUE_PATHS
# entry for '/dt-plot-catalog' and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# access='all' (any signed-in user) -- this is a pure read-only reference
# page (no write action anywhere on it), same tier as Issues/DT Session
# History: any engineer should be able to see what's already plottable.
#
# order=183 -- after RF Reports (182, migration 0062_seed_rf_reports_menuitem.py).
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward, same as every other hand-authored migration in this
# app asks for.
from django.db import migrations

PATH = '/k9d4wr'

ITEM = dict(
    label='DT Plot Catalog', link_type='route', path=PATH,
    access='all', permission_key='', order=183, icon='📊',
    description='Which drive-test report plots (PCI/Band/RSRP/RSRQ/SINR/CQI/throughput/HOSR/VoLTE/ViLTE) are already available',
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
        ('core', '0066_activity_report_link'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
