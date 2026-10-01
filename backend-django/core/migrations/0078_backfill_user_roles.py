# Data migration (2026-10-01) -- backfills every existing user's single
# `role` value into the new `roles` M2M, so Manage Roles/Assign Roles/the
# Permission Matrix see every real account's existing privilege tier from
# day one instead of starting with an empty roles list. Purely additive
# and safely re-runnable (`.add()` on an M2M is idempotent) -- no column
# is dropped or altered, `role` itself is untouched by this migration.
#
# Uses the historical `apps.get_model` versions of both models, per
# standard Django data-migration convention (same as every other
# RunPython migration in this app, e.g. 0072/0075/0077) -- note the
# `_sync_primary_role` signal receiver in core/models.py does NOT fire
# here, since it's registered against the real app's `User.roles.through`
# sender, not this migration's historical model; that's fine, since we're
# only ever adding a role that already matches the user's own current
# `role` value, so there's nothing for the signal to reconcile.
from django.db import migrations


def backfill(apps, schema_editor):
    User = apps.get_model('core', 'User')
    Role = apps.get_model('core', 'Role')
    roles_by_name = {r.name: r for r in Role.objects.all()}
    for user in User.objects.all():
        role = roles_by_name.get(user.role)
        if role is not None:
            user.roles.add(role)


def noop_reverse(apps, schema_editor):
    # Deliberately a no-op, not "clear every user's roles" -- a reverse
    # migration running after Assign Roles has been used for real would
    # otherwise destroy genuine admin decisions, not just undo this
    # migration's own backfill. Matches this app's existing convention
    # of a safe-no-op reverse wherever a true inverse would be destructive.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0077_seed_builtin_roles'),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
