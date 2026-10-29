"""
python manage.py fetch_cell_kpis [--date YYYY-MM-DD] [--loop] [--interval-seconds N]

Fetches the per-cell network KPIs of one day from the source set on the Live
Site Sync page (core/cell_kpi.py fetch) and stores them.

Once: fetches --date (default yesterday, Nepal time) now. `--loop` (started
by run_maintenance) checks every --interval-seconds (default 900) whether
yesterday is due: after the page's fetch hour, not yet fetched, and at least
30 minutes after a failed try. Nothing happens while the source is off.
"""
import time
from datetime import date

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.cell_kpi import due, fetch
from core.models import CellKpiSourceSettings


class Command(BaseCommand):
    help = 'Fetch per-cell network KPIs (once, or --loop on the daily schedule).'

    def add_arguments(self, parser):
        parser.add_argument('--date', help='Day to fetch, YYYY-MM-DD (default yesterday).')
        parser.add_argument('--loop', action='store_true', help='Run forever on the daily schedule.')
        parser.add_argument('--interval-seconds', type=float, default=900,
                            help='Seconds between schedule checks under --loop (default 900).')

    def _report(self, result):
        if result.get('ok'):
            self.stdout.write(f"Cell KPIs {result['date']}: {result.get('rows', 0)} rows, "
                              f"{result.get('unmatched', 0)} not matched, {result.get('rejected', 0)} refused.")
        else:
            self.stderr.write(f"Cell KPIs {result['date']}: {result.get('error')}")

    def _run_once(self):
        row = CellKpiSourceSettings.load()
        day = due(row)
        if day is None:
            return
        CellKpiSourceSettings.objects.filter(pk=1).update(running_since=timezone.now())
        self._report(fetch(day, row))

    def handle(self, *args, **o):
        if not o['loop']:
            day = date.fromisoformat(o['date']) if o.get('date') else None
            self._report(fetch(day))
            return
        seconds = o['interval_seconds']
        self.stdout.write(f'fetch_cell_kpis: checking every {seconds:g} s (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once()
            except Exception as exc:  # noqa: BLE001 -- must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'fetch_cell_kpis pass failed: {exc!r}'))
            time.sleep(seconds)
