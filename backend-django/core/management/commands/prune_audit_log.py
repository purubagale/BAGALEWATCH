"""
python manage.py prune_audit_log [--older-than-days 30] [--dry-run] [--loop] [--interval-hours N]

Retention for the Audit Log (2026-10-01, "should store upto 1 month log
cap. after that dump older") -- deletes AuthEventLog AND AuditEvent rows
older than the cutoff, together, on the same schedule. Unlike
prune_telemetry.py's partition-aggregate-then-drop dance, neither table
here is partitioned -- this is just a plain `queryset.filter(...).delete()`
per table, the same shape prune_telemetry.py already uses for its
non-partitioned TelemetryBatch ledger.

`--loop` runs forever, `--interval-hours` apart (default 24h) -- combined
into this one command rather than split into a separate "_maintenance"
wrapper the way telemetry's prune/partition-roll pair is, since there's
only one step here, not two to orchestrate. This is what the
`audit-log-maintenance` compose service runs, so retention is enforced in
the pipeline rather than left to someone remembering to run it by hand --
same reasoning as telemetry_maintenance.py's own module docstring.

Default retention is settings.AUDIT_LOG_RETENTION_DAYS (30). A single
failed pass under --loop logs and waits for the next interval rather than
crash-looping.
"""
import time
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from core.models import AuditEvent, AuthEventLog


class Command(BaseCommand):
    help = 'Delete AuthEventLog/AuditEvent rows older than the retention cutoff (once, or --loop).'

    def add_arguments(self, parser):
        parser.add_argument('--older-than-days', type=int, default=None)
        parser.add_argument('--dry-run', action='store_true')
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-hours.')
        parser.add_argument('--interval-hours', type=int, default=24,
                             help='Hours between passes under --loop (default 24).')

    def _run_once(self, days, dry):
        cutoff = timezone.now() - timedelta(days=days)
        old_access = AuthEventLog.objects.filter(created_at__lt=cutoff)
        old_audit = AuditEvent.objects.filter(created_at__lt=cutoff)
        access_count = old_access.count()
        audit_count = old_audit.count()
        if not dry:
            old_access.delete()
            old_audit.delete()
        verb = 'Would remove' if dry else 'Removed'
        self.stdout.write(self.style.SUCCESS(
            f'{verb} {access_count} access-log row(s) and {audit_count} audit-event row(s). '
            f'Retention: {days} days (cutoff {cutoff.date()}).'
        ))

    def handle(self, *args, **o):
        days = o['older_than_days'] or getattr(settings, 'AUDIT_LOG_RETENTION_DAYS', 30)
        if not o['loop']:
            self._run_once(days, o['dry_run'])
            return

        hours = o['interval_hours']
        self.stdout.write(f'prune_audit_log: looping every {hours}h (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once(days, o['dry_run'])
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'prune_audit_log pass failed: {exc!r}'))
            time.sleep(hours * 3600)
