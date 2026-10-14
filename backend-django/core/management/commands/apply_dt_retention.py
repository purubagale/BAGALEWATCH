"""
python manage.py apply_dt_retention [--loop] [--interval-seconds N]

Carries out drive-test retention runs a superadmin has approved
(core/dt_retention.py). It never plans or approves anything itself: with
no approved run it does nothing. `--loop` checks every --interval-seconds
(default 60); started by run_maintenance with the other background jobs.
"""
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from core.dt_retention import apply_approved_runs


class Command(BaseCommand):
    help = 'Carry out approved drive-test retention runs (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-seconds.')
        parser.add_argument('--interval-seconds', type=float, default=60,
                            help='Seconds between checks under --loop (default 60).')

    def handle(self, *args, **o):
        if not o['loop']:
            apply_approved_runs()
            return
        while True:
            try:
                apply_approved_runs()
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'apply_dt_retention pass failed: {exc!r}'))
            close_old_connections()
            time.sleep(o['interval_seconds'])
