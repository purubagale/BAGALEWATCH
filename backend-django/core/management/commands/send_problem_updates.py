"""
python manage.py send_problem_updates [--loop] [--interval-seconds N]

Sends waiting status updates on problem reports to the linked systems that
sent them, and tries failed ones again on their schedule
(core/problem_notify.py send_due).

`--loop` runs forever, `--interval-seconds` apart (default 60). Started by
run_maintenance with the other background jobs. A failed pass is logged
and tried again at the next interval.
"""
import time

from django.core.management.base import BaseCommand

from core.problem_notify import send_due


class Command(BaseCommand):
    help = 'Send waiting problem-report updates to linked systems (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-seconds.')
        parser.add_argument('--interval-seconds', type=float, default=60,
                            help='Seconds between passes under --loop (default 60).')

    def _run_once(self):
        done = send_due()
        if done:
            self.stdout.write(f'Sent or tried {done} problem-report update(s).')

    def handle(self, *args, **o):
        if not o['loop']:
            self._run_once()
            return

        seconds = o['interval_seconds']
        self.stdout.write(f'send_problem_updates: looping every {seconds:g} s (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once()
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'send_problem_updates pass failed: {exc!r}'))
            time.sleep(seconds)
