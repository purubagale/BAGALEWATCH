"""
python manage.py telemetry_maintenance [--loop] [--interval-hours N] [--dry-run]

The scheduled side of the crowdsourced-telemetry pipeline's data
governance. One pass does, in order:

  1. `ensure_telemetry_partitions` — make sure the current + next few
     monthly partitions of v2_telemetry_samples exist;
  2. `prune_telemetry` — aggregate every partition older than
     settings.TELEMETRY_RETENTION_DAYS into TelemetryCoverageBin and DROP
     it, and clear stale rows from the batch-idempotency ledger.

`--loop` runs it forever, `--interval-hours` apart (default
settings.TELEMETRY_MAINTENANCE_INTERVAL_HOURS = 24) — this is what the
`telemetry-maintenance` compose service runs, so retention is "enforced
in the pipeline, not left to a policy someone has to remember to run"
(network-planning brief, Data governance). A single failed pass logs and
waits for the next interval rather than crashing the service.
"""
import time

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Roll telemetry partitions forward and enforce retention (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-hours.')
        parser.add_argument('--interval-hours', type=int, default=None,
                            help='Hours between passes under --loop (default TELEMETRY_MAINTENANCE_INTERVAL_HOURS).')
        parser.add_argument('--dry-run', action='store_true', help='Pass through to prune_telemetry.')

    def _run_once(self, dry_run):
        call_command('ensure_telemetry_partitions', verbosity=self.verbosity)
        call_command('prune_telemetry', dry_run=dry_run, verbosity=self.verbosity)

    def handle(self, *args, **o):
        self.verbosity = o['verbosity']
        if not o['loop']:
            self._run_once(o['dry_run'])
            return

        hours = o['interval_hours'] or getattr(settings, 'TELEMETRY_MAINTENANCE_INTERVAL_HOURS', 24)
        self.stdout.write(f'telemetry_maintenance: looping every {hours}h (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once(o['dry_run'])
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'telemetry_maintenance pass failed: {exc!r}'))
            time.sleep(hours * 3600)
