"""
python manage.py prune_site_photos [--dry-run] [--loop] [--interval-hours N]

Removes site photos that will never be shown, with their stored files:
rejected ones after REJECTED_RETENTION_DAYS and ones nobody reviewed after
PENDING_RETENTION_DAYS (core/site_photo.py). Approved photos are kept.

`--loop` runs forever, `--interval-hours` apart (default 24h). Started by
run_maintenance with the other background jobs. A failed pass is logged
and tried again at the next interval.
"""
import time

from django.core.management.base import BaseCommand

from core.site_photo import PENDING_RETENTION_DAYS, REJECTED_RETENTION_DAYS, prune_old_photos


class Command(BaseCommand):
    help = 'Delete old rejected and unreviewed site photos (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='Count what would be removed; delete nothing.')
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-hours.')
        parser.add_argument('--interval-hours', type=float, default=24,
                            help='Hours between passes under --loop (default 24).')

    def _run_once(self, dry_run):
        rejected, pending = prune_old_photos(dry_run=dry_run)
        verb = 'Would remove' if dry_run else 'Removed'
        self.stdout.write(
            f'{verb} {rejected} rejected and {pending} unreviewed site photo(s). '
            f'Retention: {REJECTED_RETENTION_DAYS} and {PENDING_RETENTION_DAYS} days.'
        )

    def handle(self, *args, **o):
        if not o['loop']:
            self._run_once(o['dry_run'])
            return

        hours = o['interval_hours']
        self.stdout.write(f'prune_site_photos: looping every {hours}h (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once(o['dry_run'])
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'prune_site_photos pass failed: {exc!r}'))
            time.sleep(hours * 3600)
