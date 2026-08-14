# Data migration — second pass of 0018's opaque-path renaming, covering
# the two routes 0018 deliberately left out (2026-08-08 same-day
# follow-up: "for drive test page url... opaque path is displayed but for
# dashboard, site topology, master data and setting, plain path is
# displayed. correct them also with no straight path").
#
# 0018's exclusion reasoning for `/sites` doesn't actually hold up on a
# closer look: the "9 scattered hardcoded `/sites/${id}` references" it
# cited are ALL to the `/sites/:id` DETAIL sub-route (a single site's own
# page), which this migration — and the matching frontend change —
# deliberately still does NOT touch. Only the bare `/sites` list/map
# route is renamed here, so none of those 9 references needed to change.
# `/dashboard` had no such excuse at all; it was just grouped in with
# `/login` under "special-cased, non-system route," which the user's
# follow-up request makes clear wasn't the distinction they wanted —
# `/login` stays excluded (a signed-out user needs to be able to find/
# guess it), `/dashboard` does not.
#
# THE TOKEN MAPPING BELOW MUST STAY IN SYNC with the identical mapping in
# frontend-react/src/constants/opaqueRoutes.ts and
# frontend-react/src/pages/MenuAdminPage.tsx (KNOWN_ROUTES datalist).
#
# Same ADDITIVE, idempotent, best-effort pattern as 0018 — see that
# migration's own docstring for the full explanation.
from django.db import migrations

PATH_RENAMES = {
    '/dashboard': '/m4h8qz',
    '/sites': '/e6t2pv',
}


def obfuscate_paths(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for old_path, new_path in PATH_RENAMES.items():
        MenuItem.objects.filter(path=old_path).update(path=new_path)


def restore_paths(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for old_path, new_path in PATH_RENAMES.items():
        MenuItem.objects.filter(path=new_path).update(path=old_path)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0018_obfuscate_builtin_menu_paths'),
    ]

    operations = [
        migrations.RunPython(obfuscate_paths, restore_paths),
    ]
