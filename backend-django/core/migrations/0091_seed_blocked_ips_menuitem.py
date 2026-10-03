# Data migration — adds "Blocked IPs" as a real MenuItem child of the
# "App Data Mgmt" parent (2026-10-02, Phase E2 -- "can we block the ip, if
# mistakenly blocked, superadmin can unblock"). Same group and reasoning
# as 0075_seed_access_log_menuitem.py's own "Access Log" entry, which this
# sits right next to -- same investigation this feature's enforcement
# half belongs beside its detection half.
#
# access='superadmin' -- matches BlockedIPListView/BlockedIPUnblockView's
# own gate (core/ip_block.py).
#
# order 156 -- right after Access Log (155, migration
# 0075_seed_access_log_menuitem.py), same parent group.
from django.db import migrations

PATH = '/b3n7qz'

ITEM = dict(
    label='Blocked IPs', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=156, icon='🚫',
    description='IPs auto-blocked after repeated failed local logins, or manually blocked -- unblock a false positive here',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=PATH).exists():
        return
    parent = MenuItem.objects.filter(label='App Data Mgmt', parent__isnull=True).first()
    MenuItem.objects.create(parent=parent, **ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0090_blocked_ip'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
