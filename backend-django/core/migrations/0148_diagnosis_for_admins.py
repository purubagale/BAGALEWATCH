# 2026-10-27. The Subscriber Network Diagnosis Dashboard opens to admins too
# (the user's decision: NTC staff see every subscriber detail except the
# position). Only a menu item still on the seeded superadmin tier is changed,
# so a choice made on the Menu Visibility page is kept.
from django.db import migrations

PATH = '/s7p2nd'


def widen(apps, schema_editor):
    apps.get_model('core', 'MenuItem').objects.filter(path=PATH, access='superadmin').update(access='admin')


def narrow(apps, schema_editor):
    apps.get_model('core', 'MenuItem').objects.filter(path=PATH, access='admin').update(access='superadmin')


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0147_reading_neighbours'),
    ]

    operations = [
        migrations.RunPython(widen, narrow),
    ]
