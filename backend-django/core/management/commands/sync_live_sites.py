"""
python manage.py sync_live_sites [--file PATH] [--loop] [--interval-seconds N]

One-shot by default: fetches the live Site Directory API (or reads a
local JSON file with --file, for testing this pipeline before the real
endpoint/credentials exist — see core/live_sites.py's module docstring)
and upserts every record into Site.

--loop runs it forever instead, sleeping --interval-seconds between
pulls (default from settings.LIVE_SITE_SYNC_INTERVAL_SECONDS) — this is
what docker-compose.yml's `site-sync` service runs, the "scheduled
automatically" side of syncing (LiveSiteSyncView in site_import.py is the
other, admin-triggered "Sync now" side; both call the same
sync_live_sites()). A single failed pull (network hiccup, API down) logs
and waits for the next interval rather than crashing the whole service —
this command is meant to run unattended for the container's entire
lifetime.
"""
import json
import time

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.live_sites import sync_live_sites


class Command(BaseCommand):
    help = 'Sync Site identity/location/on-air data from the live Site Directory API.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--file', default=None,
            help='Read a local JSON file (a list of site records) instead of calling the live API.',
        )
        parser.add_argument(
            '--loop', action='store_true',
            help='Run forever, syncing every --interval-seconds instead of once.',
        )
        parser.add_argument(
            '--interval-seconds', type=int, default=None,
            help='Seconds between syncs under --loop (default: LIVE_SITE_SYNC_INTERVAL_SECONDS).',
        )

    def _run_once(self, file_path):
        records = None
        if file_path:
            with open(file_path, encoding='utf-8') as f:
                records = json.load(f)
            if not isinstance(records, list):
                raise CommandError(f'{file_path} does not contain a JSON list.')
        result = sync_live_sites(records=records)
        self.stdout.write(self.style.SUCCESS(
            f"Synced: {result['created']} created, {result['updated']} updated, "
            f"{len(result['warnings'])} warning(s)."
        ))
        for warning in result['warnings']:
            self.stdout.write(self.style.WARNING(warning))
        return result

    def handle(self, *args, **options):
        if not options['loop']:
            self._run_once(options['file'])
            return

        interval = options['interval_seconds'] or settings.LIVE_SITE_SYNC_INTERVAL_SECONDS
        self.stdout.write(f'Looping every {interval}s (Ctrl+C to stop)...')
        while True:
            try:
                self._run_once(options['file'])
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next interval
                self.stderr.write(self.style.ERROR(f'Sync failed: {exc}'))
            time.sleep(interval)
