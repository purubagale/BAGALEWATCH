"""
clear_sites (2026-09-07).

Deletes every Site (and, via Sector's on_delete=CASCADE, every Sector)
so the app can be brought back to "before the old Excel/.netwatch data
was ever imported" and then repopulated cleanly from the Live Site
Directory sync -- requested explicitly: "now i need fresh application
with no site details data... then start live sync of site details and
store them in database."

Deliberately requires --confirm: this is a real, irreversible delete of
whatever is currently in Site/Sector (4,966 rows at the time this was
written, entirely from an old .netwatch restore, per the investigation
that led here -- see core/backup.py's BackupImportView docstring). If
you want a safety net first, export a `.netwatch` backup from the
Backup & Restore page before running this -- NOT as a way to restore
sites later (that flow no longer re-creates sites at all, on purpose,
see backup.py), but so the old data physically still exists somewhere
if you ever need to look something up.

After this, the normal next step is a real (non-dry-run) sync:
    python manage.py clear_sites --confirm
    python manage.py sync_live_sites
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Sector, Site


class Command(BaseCommand):
    help = (
        'Deletes ALL Site and Sector rows, returning the app to a clean slate before any '
        'Excel/.netwatch import -- so it can be repopulated purely from the Live Site '
        'Directory sync. Irreversible. Requires --confirm.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--confirm', action='store_true',
            help='Required. Without it, this command does nothing but report the current counts.',
        )

    def handle(self, *args, **options):
        site_count = Site.objects.count()
        sector_count = Sector.objects.count()

        if not options['confirm']:
            self.stdout.write(
                f'Would delete {site_count} site(s) and {sector_count} sector(s). '
                f'Nothing was deleted -- re-run with --confirm to actually do it.'
            )
            return

        with transaction.atomic():
            # Sector first for a clear count even though Site's CASCADE
            # would take them anyway -- makes the reported numbers exact
            # regardless of FK ordering.
            Sector.objects.all().delete()
            Site.objects.all().delete()

        self.stdout.write(self.style.SUCCESS(
            f'Deleted {site_count} site(s) and {sector_count} sector(s). '
            f"Run 'python manage.py sync_live_sites' next to repopulate from the live source."
        ))
