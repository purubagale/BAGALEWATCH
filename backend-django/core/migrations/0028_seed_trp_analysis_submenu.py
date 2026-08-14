# Data migration — adds "TRP File Analysis" as a fourth child of the
# "DT Data Manager" MenuItem (2026-08-11 request: "Add this feature from
# v1 as trp file analysis in separate submenu in DT data Manager"). Same
# pattern 0020_seed_dt_data_manager_submenus.py already established for
# the Upload/Session History/Explore children — see that migration's own
# docstring for the full reasoning (MenuSectionGate auto-lists children,
# same permission_key='rsrpmgr' inherited from the parent so no new
# Permissions-page step is needed for anyone who could already reach DT
# Data Manager).
#
# This is a deep, separate, per-file diagnostic tool (decode every
# declared 4G/3G/2G radio field, not just the curated handful the
# session-upload path stores) — genuinely a sibling feature to Upload/
# History/Explore, not a mode of any of them, which is why it's its own
# child rather than a tab bolted onto an existing page (matches this
# project's own established preference, see the 2026-08-09 tab-to-
# submenu split this whole parent went through).
#
# `RunPython` with a reverse no-op, same convention as 0008/0010/0015/0020.
from django.db import migrations

TRP_ANALYSIS_PATH = '/v8k3nq'


def seed_child(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    parent = MenuItem.objects.filter(path='/w7h1sd').first()
    if parent is None:
        # Best-effort / idempotent, same convention as 0015/0020 — if the
        # parent row was renamed or deleted before this migration ran,
        # there's nothing sensible to attach this child to; skip rather
        # than error.
        return
    if MenuItem.objects.filter(path=TRP_ANALYSIS_PATH).exists():
        return
    MenuItem.objects.create(
        label='TRP File Analysis', link_type='route', path=TRP_ANALYSIS_PATH, parent=parent,
        order=40, access=parent.access, permission_key=parent.permission_key,
        icon='📡', description='Deep protocol-level .trp file diagnostics with export',
    )


def remove_child(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=TRP_ANALYSIS_PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0027_rename_v2_dt_sampl_lat_1a2b3c_idx_v2_dt_sampl_lat_1ab414_idx'),
    ]

    operations = [
        migrations.RunPython(seed_child, remove_child),
    ]
