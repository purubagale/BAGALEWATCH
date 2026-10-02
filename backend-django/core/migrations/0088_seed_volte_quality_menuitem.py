# Data migration — adds "VoLTE Quality" as a real MenuItem child of the
# "Telemetry" parent (2026-10-02), same convention as
# 0072_seed_telemetry_live_samples_menuitem.py: a raw per-call dev/pilot
# list view (core/volte_quality.py's VolteQualityListView), not a general
# feature, so access='superadmin' and it's seeded directly rather than
# left as an unlisted URL -- per the explicit 2026-09-30 decision ("these
# link are seperately managed, so can be removed from that admin page")
# that this app's established pattern is a real seeded MenuItem, not a
# plain <a href> dev-tools shortcut, even for superadmin-only tooling.
#
# Same "Telemetry" parent lookup pattern as 0072 -- looked up by label,
# not a hardcoded path, since that group was never itself created by a
# migration (see 0072's own comment for the full reasoning). Falls back
# to a top-level item if no such group exists yet.
#
# order=184 -- after DT Plot Catalog (183, migration
# 0067_seed_dt_plot_catalog_menuitem.py), the highest order value in use
# as of this migration.
from django.db import migrations

PATH = '/w2k6tr'

ITEM = dict(
    label='VoLTE Quality', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=184, icon='📞',
    description='Raw VoLTE/VoNR call-quality samples with an estimated MOS, for verifying carrier-privileged test-device uploads',
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
        ('core', '0087_volte_call_sample'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
