"""
python manage.py roll_telemetry_bins [--loop] [--interval-minutes N] [--lag-minutes N] [--dry-run]

Incremental coverage-bin rollup — the fix for "the Coverage map can never
reflect live/fresh data," which was true by design before this command
existed: prune_telemetry.py only aggregates a whole monthly partition
once its ENTIRE range is past TELEMETRY_RETENTION_DAYS (90 by default),
so a sample uploaded five minutes ago wouldn't show up on the Coverage
map until the month it landed in aged out months later.

This command runs far more often (minutes, via the new
`telemetry-bin-roller` compose service — see docker-compose.yml) and
merges recent raw rows into TelemetryCoverageBin WITHOUT dropping
anything. Raw retention / partition-dropping stays prune_telemetry's job
alone; this only ever INSERTs/weight-merges into the bin table, using the
exact same aggregation shape as prune_telemetry._AGGREGATE_SQL, just
scoped by a received_at window instead of "this whole partition."

── Why this can't double-count with prune_telemetry ───────────────────
TelemetryRollState (core/models.py, a singleton row) tracks a single
watermark: the received_at up to which rows have ALREADY been merged
into TelemetryCoverageBin by this command. Each pass aggregates
`(watermark, cutoff]`, where `cutoff = now() - lag_minutes` — the lag
gives in-flight COPY inserts (core/telemetry.py's bulk_insert_samples)
time to land before a window is considered "closed," since a row whose
received_at falls inside an already-rolled window would otherwise never
be picked up by either job. The INSERT and the watermark advance happen
in the SAME transaction, so a crash mid-pass simply leaves the watermark
where it was — the next pass picks up from the same true last-rolled
point, never skipping a row and never re-counting one.

prune_telemetry.py's own aggregation filters to `received_at >
watermark` for exactly this reason (see its _AGGREGATE_SQL). By the time
a partition is old enough to prune, this command will have already
rolled every row in it many times over (this runs in minutes/hours;
retention is 90 days by default), so prune's pass over that partition
aggregates zero *new* rows in the ordinary case and just drops the
already-merged table — TelemetryCoverageBin's numbers don't move again,
only the raw partition disappears. If this command has never run (fresh
deploy) or fell behind, the watermark is simply older/absent and
prune_telemetry correctly aggregates everything itself, exactly like it
always has.
"""
import time
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connection, transaction
from django.utils import timezone

from core.models import TelemetryRollState

# Same weighted-merge ON CONFLICT shape as prune_telemetry._AGGREGATE_SQL
# (keep the two in sync if the aggregation logic ever changes), scoped by
# a received_at window across the whole partitioned parent table —
# Postgres routes this across whichever monthly partitions the window
# touches on its own, no partition-name bookkeeping needed here.
_ROLL_SQL = """
INSERT INTO v2_telemetry_coverage_bins AS b
  (geohash, network_type, mnc, region, center_lat, center_lng,
   sample_count, device_count, rsrp_mean, rsrp_p10, rsrp_min,
   rsrq_mean, sinr_mean, first_ts, last_ts, updated_at)
SELECT
  gh,
  network_type,
  mnc,
  COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(region, '')), ''),
  ST_Y(ST_PointFromGeoHash(gh)),
  ST_X(ST_PointFromGeoHash(gh)),
  count(*),
  count(DISTINCT device_id),
  avg(rsrp_dbm),
  percentile_cont(0.1) WITHIN GROUP (ORDER BY rsrp_dbm),
  min(rsrp_dbm),
  avg(rsrq_db),
  avg(sinr_db),
  min(ts),
  max(ts),
  now()
FROM (
  SELECT ST_GeoHash(location::geometry, 7) AS gh,
         network_type, mnc, device_id, region, rsrp_dbm, rsrq_db, sinr_db, ts
  FROM v2_telemetry_samples
  WHERE location IS NOT NULL
    AND received_at > COALESCE(%(since)s, '-infinity'::timestamptz)
    AND received_at <= %(until)s
) s
-- 2026-09-02: grouped by mnc too — keep in sync with
-- prune_telemetry._AGGREGATE_SQL (same reasoning noted there).
GROUP BY gh, network_type, mnc
ON CONFLICT (geohash, network_type, mnc) DO UPDATE SET
  sample_count = b.sample_count + EXCLUDED.sample_count,
  device_count = b.device_count + EXCLUDED.device_count,
  rsrp_mean = CASE
      WHEN b.rsrp_mean IS NULL THEN EXCLUDED.rsrp_mean
      WHEN EXCLUDED.rsrp_mean IS NULL THEN b.rsrp_mean
      ELSE (b.rsrp_mean * b.sample_count + EXCLUDED.rsrp_mean * EXCLUDED.sample_count)
           / NULLIF(b.sample_count + EXCLUDED.sample_count, 0) END,
  rsrp_p10 = CASE
      WHEN b.rsrp_p10 IS NULL THEN EXCLUDED.rsrp_p10
      WHEN EXCLUDED.rsrp_p10 IS NULL THEN b.rsrp_p10
      ELSE (b.rsrp_p10 * b.sample_count + EXCLUDED.rsrp_p10 * EXCLUDED.sample_count)
           / NULLIF(b.sample_count + EXCLUDED.sample_count, 0) END,
  rsrp_min = LEAST(b.rsrp_min, EXCLUDED.rsrp_min),
  rsrq_mean = CASE
      WHEN b.rsrq_mean IS NULL THEN EXCLUDED.rsrq_mean
      WHEN EXCLUDED.rsrq_mean IS NULL THEN b.rsrq_mean
      ELSE (b.rsrq_mean * b.sample_count + EXCLUDED.rsrq_mean * EXCLUDED.sample_count)
           / NULLIF(b.sample_count + EXCLUDED.sample_count, 0) END,
  sinr_mean = CASE
      WHEN b.sinr_mean IS NULL THEN EXCLUDED.sinr_mean
      WHEN EXCLUDED.sinr_mean IS NULL THEN b.sinr_mean
      ELSE (b.sinr_mean * b.sample_count + EXCLUDED.sinr_mean * EXCLUDED.sample_count)
           / NULLIF(b.sample_count + EXCLUDED.sample_count, 0) END,
  first_ts = LEAST(b.first_ts, EXCLUDED.first_ts),
  last_ts  = GREATEST(b.last_ts, EXCLUDED.last_ts),
  region   = COALESCE(NULLIF(b.region, ''), EXCLUDED.region),
  updated_at = now();
"""

_COUNT_SQL = """
SELECT count(*) FROM v2_telemetry_samples
WHERE location IS NOT NULL
  AND received_at > COALESCE(%(since)s, '-infinity'::timestamptz)
  AND received_at <= %(until)s
"""


class Command(BaseCommand):
    help = 'Incrementally roll recent raw telemetry samples into TelemetryCoverageBin (aggregate only, never drops).'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true', help='Run forever, every --interval-minutes.')
        parser.add_argument('--interval-minutes', type=int, default=None,
                            help='Minutes between passes under --loop (default TELEMETRY_BIN_ROLL_INTERVAL_MINUTES).')
        parser.add_argument('--lag-minutes', type=int, default=None,
                            help='Safety gap before "now" so in-flight inserts land before their window closes '
                                 '(default TELEMETRY_BIN_ROLL_LAG_MINUTES).')
        parser.add_argument('--dry-run', action='store_true')

    def _run_once(self, lag_minutes, dry_run):
        state, _ = TelemetryRollState.objects.get_or_create(pk=1)
        since = state.last_rolled_at
        until = timezone.now() - timedelta(minutes=lag_minutes)
        if since is not None and since >= until:
            self.stdout.write('roll_telemetry_bins: nothing new yet (lag window not elapsed).')
            return

        if dry_run:
            with connection.cursor() as cur:
                cur.execute(_COUNT_SQL, {'since': since, 'until': until})
                n = cur.fetchone()[0]
            self.stdout.write(f'[dry-run] would roll {n} row(s) received in ({since}, {until}] into coverage bins.')
            return

        with transaction.atomic():
            with connection.cursor() as cur:
                cur.execute(_ROLL_SQL, {'since': since, 'until': until})
                merged = cur.rowcount
            # Watermark advance is inside the same transaction as the
            # INSERT above — see this module's docstring on why that's
            # what makes a mid-pass crash safe rather than a silent gap.
            TelemetryRollState.objects.filter(pk=1).update(last_rolled_at=until)

        self.stdout.write(self.style.SUCCESS(
            f'roll_telemetry_bins: merged into {merged} bin row(s) for ({since}, {until}]; watermark -> {until}.'
        ))

    def handle(self, *args, **o):
        lag = o['lag_minutes'] if o['lag_minutes'] is not None else getattr(settings, 'TELEMETRY_BIN_ROLL_LAG_MINUTES', 5)

        if not o['loop']:
            self._run_once(lag, o['dry_run'])
            return

        interval = o['interval_minutes'] if o['interval_minutes'] is not None else getattr(
            settings, 'TELEMETRY_BIN_ROLL_INTERVAL_MINUTES', 60
        )
        self.stdout.write(f'roll_telemetry_bins: looping every {interval}m (Ctrl+C to stop)…')
        while True:
            try:
                self._run_once(lag, o['dry_run'])
            except Exception as exc:  # noqa: BLE001 — must never crash-loop; log and retry next pass
                self.stderr.write(self.style.ERROR(f'roll_telemetry_bins pass failed: {exc!r}'))
            time.sleep(interval * 60)
