"""
python manage.py take_kpi_snapshot

Daily KPI snapshot job — the real-data counterpart to v1's disabled
saveDailySnapshot() (bts_monitor.html ~12203). v1's own code comment says
"Daily snapshot interval removed (no live feed)" — that function is never
actually called, so v1's KPI Trend almost always falls back to a
Math.random()-fabricated trend line instead of real history. Per this
project's "never fabricate data" rule and an explicit user decision
(2026-07-28), v2 populates real history instead: this command copies each
site's current KPI values into a KpiSnapshot row for today.

Idempotent by design (update_or_create on site+date) — safe to re-run the
same day without creating duplicate/inflated history. Intended to run
once a day; this stack has no built-in scheduler container yet (that's
Phase 6 real-time infra), so schedule it externally for now, e.g. Windows
Task Scheduler or cron running:
    docker compose exec django python manage.py take_kpi_snapshot
See docs/RUNBOOK.md for the exact setup.

--date YYYY-MM-DD backfills a specific date instead of today — for
quickly clearing KPI Trend's 3-snapshot minimum during manual testing
without waiting 3 real days. Still records real current KPI values, just
filed under an earlier date.
"""
import datetime

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.models import KpiSnapshot, Site

# Matches v1's DAILY_KPI_KEYS (bts_monitor.html ~12184), snake_case to
# match Site's own field names instead of v1's camelCase.
DAILY_KPI_FIELDS = [
    'rrc', 'erab', 'call_setup', 'call_drop', 'svc_drop', 'intra_ho',
    'inter_ho', 'inter_rat', 'ip_thru', 'ip_lat', 'prb', 'bearer_util',
    'lic_util', 'cell_avail', 'rssi', 'load',
]


class Command(BaseCommand):
    help = 'Take a daily KPI snapshot of every site, for real KPI Trend history.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--date', default=None,
            help=(
                'YYYY-MM-DD to record the snapshot under (default: today). '
                'For backfilling test data only — e.g. run this 3x with '
                '3 different past dates to clear KPI Trend\'s '
                'MIN_SNAPSHOTS_FOR_TREND threshold immediately instead of '
                'waiting 3 real days. Real KPI values are always used, '
                'just filed under an earlier date — this never fabricates '
                'KPI numbers, only the date they\'re recorded against.'
            ),
        )

    def handle(self, *args, **options):
        if options['date']:
            try:
                today = datetime.date.fromisoformat(options['date'])
            except ValueError:
                raise CommandError('--date must be in YYYY-MM-DD format.')
        else:
            today = timezone.localdate()
        created = updated = 0
        for site in Site.objects.all().iterator():
            values = {f: getattr(site, f) for f in DAILY_KPI_FIELDS}
            _, was_created = KpiSnapshot.objects.update_or_create(
                site=site, date=today, defaults=values,
            )
            if was_created:
                created += 1
            else:
                updated += 1
        self.stdout.write(self.style.SUCCESS(
            f'KPI snapshot for {today}: {created} created, {updated} updated.'
        ))
