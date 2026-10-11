# Data migration (2026-10-11) -- adds "Site Photos" as a MenuItem for the
# review page of core/site_photo.py. Same seeding convention as
# 0112_seed_area_sample_menuitem.py: path kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts and MenuAdminPage.tsx's
# KNOWN_ROUTES list.
#
# access='admin' -- admin and superadmin, matching the review endpoints.
from django.db import migrations

PATH = '/p6h2sv'

ITEM = dict(
    label='Site Photos', link_type='route', path=PATH,
    access='admin', permission_key='', order=189, icon='📷',
    description='Review the photos staff take at sites with the mobile app',
)


def seed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if not MenuItem.objects.filter(path=PATH).exists():
        MenuItem.objects.create(**ITEM)


def unseed(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0118_sitephoto'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
