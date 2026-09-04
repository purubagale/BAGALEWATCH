# Data migration (2026-09-03) -- adds "Rescue Lookup" and "Rescue Policy"
# as two new top-level MenuItems, so the backend's already-complete
# opt-in rescue-location lane (core/rescue.py: RescueEnrollView,
# RescueLookupView, RescueConsentPolicyView) has a way to actually be
# reached from the sidebar. Until now nothing in the frontend called
# RescueLookupView or RescueConsentPolicyView at all -- "the plumbing
# exists, but there is genuinely no way today to search a number" (see
# frontend-react/src/pages/RescueLookupPage.tsx and RescuePolicyPage.tsx).
#
# Also carries the AlterField for MenuItem.access's new ACCESS_RESCUE
# choice (models.py) -- choices are an application-level validation
# detail, not a DB constraint, so this doesn't change the actual column,
# but keeps the migration state in sync with models.py to avoid the exact
# kind of drift 0047's own comment warned about.
#
# Same convention as every seed migration since 0028: created directly at
# the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts (OPAQUE_PATHS entries for
# '/rescue-lookup' and '/rescue-policy') and MenuAdminPage.tsx's
# KNOWN_ROUTES list.
#
# Access split mirrors core/rescue.py's own permission classes exactly:
#   * Rescue Lookup — access='rescue' (the new ACCESS_RESCUE tier added in
#     this same change, models.py's MenuItem -- role in (rescue_operator,
#     superadmin), matching IsRescueOperator).
#   * Rescue Policy — access='superadmin' (IsSuperadminOnly) -- declaring
#     an emergency override is a bigger blast radius than a single lookup,
#     same reasoning as RescueConsentPolicyView's own docstring.
#
# order 178 / 179 -- right after Telemetry DT Sessions (177, migration
# 0044_seed_telemetry_dt_session_menuitem.py) and before About (180): same
# superadmin/technical cluster as the rest of the telemetry-adjacent items.
#
# (Originally written as 177/178, on the assumption 176/Telemetry Admin
# was the last item taken in this cluster -- audit found 2026-09-04 that
# 0044 had already claimed 177 for Telemetry DT Sessions, so this would
# have seeded a duplicate `order` value. `order` has no DB uniqueness
# constraint (see models.py's MenuItem.order -- a plain IntegerField), so
# this would not have failed, only produced a sidebar sort tie between
# Telemetry DT Sessions and Rescue Lookup. Bumped both values by 1 to
# close the gap instead.)
from django.db import migrations, models

LOOKUP_PATH = '/r5t8mq'
POLICY_PATH = '/r2p6ky'

ITEMS = [
    dict(
        label='Rescue Lookup', link_type='route', path=LOOKUP_PATH,
        access='rescue', permission_key='', order=178, icon='🆘',
        description='Search a last-known location by phone number, for verified rescue operators only',
    ),
    dict(
        label='Rescue Policy', link_type='route', path=POLICY_PATH,
        access='superadmin', permission_key='', order=179, icon='⚠️',
        description='Declare a time-boxed emergency override of the rescue-lookup consent requirement',
    ),
]


def seed_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for item in ITEMS:
        if not MenuItem.objects.filter(path=item['path']).exists():
            MenuItem.objects.create(**item)


def remove_menu_items(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path__in=[LOOKUP_PATH, POLICY_PATH]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0048_telemetry_gsm_wcdma_signal_fields'),
    ]

    operations = [
        migrations.AlterField(
            model_name='menuitem',
            name='access',
            field=models.CharField(
                choices=[
                    ('all', 'Any signed-in user'),
                    ('permission', 'Governed by Permissions matrix'),
                    ('admin', 'Admin + superadmin only'),
                    ('superadmin', 'Superadmin only'),
                    ('rescue', 'Rescue operator + superadmin only'),
                ],
                default='all',
                max_length=12,
            ),
        ),
        migrations.RunPython(seed_menu_items, remove_menu_items),
    ]
