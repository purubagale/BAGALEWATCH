"""
python manage.py run_maintenance

Runs the background jobs in one process, one thread each:

    sync_live_sites        scheduled Live Site Directory sync
    telemetry_maintenance  partitions and retention of telemetry samples
    roll_telemetry_bins    coverage-bin roll-up
    prune_audit_log        audit-log and expired-token retention
    prune_site_photos      old rejected and unreviewed site photos
    apply_dt_retention     drive-test retention runs a superadmin approved
    classify_problem_reports  likely cause and site of new problem reports
    send_problem_updates   status updates to linked systems that sent reports

Each job is the existing command run with --loop, so its interval,
settings and behaviour are unchanged. entrypoint.sh starts this next to
gunicorn (2026-10-11). Before that each job was its own compose service,
and a deployment whose compose file left those services out (prod did)
ran none of them. One process instead of four also saves about 200 MB.

A job that raises is logged and started again after RESTART_DELAY_SECONDS;
the others keep running. Only one runner works per database (a
Postgres advisory lock); a second one waits.
"""
import threading
import time

from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.db import close_old_connections, connection

JOBS = ('sync_live_sites', 'telemetry_maintenance', 'roll_telemetry_bins', 'prune_audit_log', 'prune_site_photos',
        'apply_dt_retention', 'classify_problem_reports', 'send_problem_updates')
RESTART_DELAY_SECONDS = 60
# Arbitrary fixed number, only has to be the same in every runner.
LOCK_KEY = 20261011
LOCK_RETRY_SECONDS = 300
LOCK_CHECK_SECONDS = 60


class Command(BaseCommand):
    help = 'Run the maintenance loops in one process (started by entrypoint.sh).'

    def _run_job(self, name):
        while True:
            try:
                call_command(name, loop=True)
            except Exception as exc:  # noqa: BLE001 — one job's failure must never stop the others
                self.stderr.write(f'run_maintenance: {name} stopped: {exc}')
            close_old_connections()
            time.sleep(RESTART_DELAY_SECONDS)

    def _holds_lock(self):
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_try_advisory_lock(%s)', [LOCK_KEY])
            return cursor.fetchone()[0]

    def handle(self, *args, **options):
        # One runner per database. The coverage roll-up is not safe to run
        # twice at the same moment, and a second django container would
        # otherwise start a second set. The lock lives on this thread's
        # connection and Postgres drops it when the connection ends.
        while not self._holds_lock():
            self.stdout.write('run_maintenance: another runner holds the lock, waiting')
            time.sleep(LOCK_RETRY_SECONDS)

        self.stdout.write(f'run_maintenance: starting {", ".join(JOBS)}')
        for name in JOBS:
            threading.Thread(target=self._run_job, args=(name,), name=name, daemon=True).start()

        # Keep the lock's connection alive. If it is lost the lock is gone
        # too, so exit and let entrypoint.sh start a fresh runner.
        while True:
            time.sleep(LOCK_CHECK_SECONDS)
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1')
