# Data migration (2026-10-01) -- seeds the 4 builtin Role rows that
# already exist as User.ROLE_CHOICES literals (core/models.py). These are
# marked is_builtin=True so RoleViewSet/RoleSerializer refuse to rename or
# delete them -- every one of the 3 DRF permission classes
# (IsAdminOrSuperadmin/IsSuperadminOnly/IsRescueOperator) and
# own_access_ok()'s MenuItem access-tier checks hardcode these exact
# literal strings, so renaming/deleting one here would silently strip
# privilege from every user who held it.
#
# Idempotent (get_or_create) and reversible (RunPython with a matching
# reverse that only deletes these 4 names) -- same convention as every
# other seed migration in this app (e.g. 0034_seed_menupermission_defaults.py).
from django.db import migrations

BUILTIN_ROLES = [
    ('superadmin', 'Superadmin'),
    ('admin', 'Admin'),
    ('viewer', 'Viewer'),
    ('rescue_operator', 'Rescue Operator'),
]


def seed_roles(apps, schema_editor):
    Role = apps.get_model('core', 'Role')
    for name, label in BUILTIN_ROLES:
        Role.objects.get_or_create(name=name, defaults={'label': label, 'is_builtin': True})


def remove_roles(apps, schema_editor):
    Role = apps.get_model('core', 'Role')
    Role.objects.filter(name__in=[name for name, _ in BUILTIN_ROLES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0076_role_user_roles_menuitemrolevisibility'),
    ]

    operations = [
        migrations.RunPython(seed_roles, remove_roles),
    ]
