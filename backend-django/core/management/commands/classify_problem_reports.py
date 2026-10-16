"""
python manage.py classify_problem_reports [--loop] [--interval-minutes N]

Works out the likely cause and site of problem reports that are new, or
were classified before the readings around their time had arrived
(core/problem_report.py classify_pending), for the Problem Dashboard.

`--loop` runs forever, `--interval-minutes` apart (default 2). Started by
run_maintenance with the other background jobs. A failed pass is logged
and tried again at the next interval.
"""
import time

from django.core.management.base import BaseCommand

from core.problem_report import classify_pending

PASS_SECONDS = 60


class Command(BaseCommand):
    help = 'Classify waiting problem reports for the dashboard (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-minutes.')
        parser.add_argument('--interval-minutes', type=float, default=2,
                            help='Minutes between passes under --loop (default 2).')

    def _run_once(self):
        done = classify_pending(PASS_SECONDS)
        if done:
            self.stdout.write(f'Classified {done} problem report(s).')

    def handle(self, *args, **o):
        if not o['loop']:
            self._run_once()
            return

        minutes = o['interval_minutes']
        self.stdout.write(f'classify_problem_reports: looping every {minutes} min (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once()
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'classify_problem_reports pass failed: {exc!r}'))
            time.sleep(minutes * 60)
