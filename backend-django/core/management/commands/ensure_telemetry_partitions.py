"""
python manage.py ensure_telemetry_partitions [--ahead 3]

Creates the monthly RANGE partitions of v2_telemetry_samples for the
current month and the next `--ahead` months, if they don't already
exist. Idempotent. Meant to run daily (cron / a loop container) so a
partition always exists before rows for that month arrive — the DEFAULT
partition is only a safety net, not where data should normally land.

Uses the `telemetry_ensure_partition(date)` plpgsql helper created in
migration 0040.
"""
from django.core.management.base import BaseCommand
from django.db import connection
from django.utils import timezone


class Command(BaseCommand):
    help = 'Create upcoming monthly partitions for v2_telemetry_samples.'

    def add_arguments(self, parser):
        parser.add_argument('--ahead', type=int, default=3, help='How many months ahead to pre-create (default 3).')

    def handle(self, *args, **o):
        today = timezone.now().date().replace(day=1)
        made = []
        with connection.cursor() as cur:
            for i in range(0, o['ahead'] + 1):
                # add i months
                y, m = today.year, today.month + i
                y += (m - 1) // 12
                m = (m - 1) % 12 + 1
                month = today.replace(year=y, month=m)
                cur.execute('SELECT telemetry_ensure_partition(%s)', [month])
                made.append(month.strftime('%Y-%m'))
        self.stdout.write(self.style.SUCCESS(f'Ensured partitions: {", ".join(made)}'))
