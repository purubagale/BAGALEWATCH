# Security audit follow-up (2026-10-15): two-factor login required for the
# superadmin and admin roles only, "verified numbers only" in the lookups,
# and the time a registered phone proved its number by SMS code
# (core/number_verify.py, core/sms.py). Also the superadmin "Security"
# page's menu item, beside Blocked IPs. The menu path is kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts and MenuAdminPage.tsx.
from django.db import migrations, models

PATH = '/s9k4tq'
ITEM = dict(
    label='Security', link_type='route', path=PATH,
    access='superadmin', permission_key='', order=157, icon='🛡️',
    description='Two-factor login, phone number verification by SMS, and the protection settings in effect',
)


def seed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if MenuItem.objects.filter(path=PATH).exists():
        return
    parent = MenuItem.objects.filter(label='App Data Mgmt', parent__isnull=True).first()
    MenuItem.objects.create(parent=parent, **ITEM)


def unseed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0135_problem_links'),
    ]

    operations = [
        migrations.AddField(
            model_name='securitysettings',
            name='mfa_required_admins',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='securitysettings',
            name='phone_verification_required',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='devicecredential',
            name='msisdn_verified_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(seed, unseed),
    ]
