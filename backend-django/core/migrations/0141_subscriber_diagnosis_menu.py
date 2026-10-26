# 2026-10-24. The "Subscriber Profile" menu item is now the "Subscriber
# Network Diagnosis Dashboard" (asked by the user). Only a row that still
# holds the seeded label or description is changed, so a superadmin's own
# wording stays.
from django.db import migrations

PATH = '/s7p2nd'
OLD_LABEL = 'Subscriber Profile'
NEW_LABEL = 'Subscriber Network Diagnosis Dashboard'
OLD_DESC = 'Everything stored about one mobile number: phones, sessions, tests and reports, for solving a customer problem'
NEW_DESC = 'Diagnose one mobile number: its phones, signal, sessions, tests and complaints, for solving a customer problem'


def forward(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, label=OLD_LABEL).update(label=NEW_LABEL)
    MenuItem.objects.filter(path=PATH, description=OLD_DESC).update(description=NEW_DESC)


def backward(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH, label=NEW_LABEL).update(label=OLD_LABEL)
    MenuItem.objects.filter(path=PATH, description=NEW_DESC).update(description=OLD_DESC)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0140_dt_session_samples_total'),
    ]

    operations = [
        migrations.RunPython(forward, backward),
    ]
