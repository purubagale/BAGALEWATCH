# Hand-authored data migration (2026-09-14) -- adds "Issues" as a new
# top-level MenuItem, so frontend-react/src/pages/IssuesPage.tsx (the
# Site/Sector Issue tracker's global list) has a way to be reached from
# the sidebar. Same convention as every seed migration since 0028 --
# created directly at the final opaque path, kept in sync with
# frontend-react/src/constants/opaqueRoutes.ts's OPAQUE_PATHS entry for
# '/issues' and MenuAdminPage.tsx's KNOWN_ROUTES list.
#
# access='all' (any signed-in user) -- matches IssueViewSet's own read
# tier (IsAuthenticated, no admin/superadmin gate -- see core/issues.py):
# any engineer should be able to open the Issues list, the same way
# Sites/DT Session History are visible to every role; only the
# create/update/destroy actions inside the page itself are further
# gated to admin/superadmin, same as those other pages.
#
# order=181 -- after Rescue Policy (179) and About (180, migration
# 0032_seed_about_menuitem.py). About's own comment calls order=180 "last"
# on the assumption nothing would be seeded after it; this migration
# breaks that assumption in the strict numeric-order sense, but `order`
# has no DB uniqueness/strict-ordering guarantee (see 0049's own comment
# on the same point) and a superadmin can freely re-order any item,
# About included, from the Menu Admin page at any time -- not worth
# renumbering an unrelated, already-shipped migration to preserve a
# comment's assumption.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward, same as 0057_issue.py asks for the Issue model
# itself.
from django.db import migrations

PATH = '/i8s4kw'

ITEM = dict(
    label='Issues', link_type='route', path=PATH,
    access='all', permission_key='', order=181, icon='🛠️',
    description='Site/sector issue tracker, linked to Optimization Activities',
)


def seed_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    if not MenuItem.objects.filter(path=PATH).exists():
        MenuItem.objects.create(**ITEM)


def remove_menu_item(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    MenuItem.objects.filter(path=PATH).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0057_issue'),
    ]

    operations = [
        migrations.RunPython(seed_menu_item, remove_menu_item),
    ]
