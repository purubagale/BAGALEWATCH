"""
python manage.py prune_telemetry [--older-than-days 90] [--dry-run]

Retention for the crowdsourced telemetry store, enforced in the pipeline
(the brief makes this a hard requirement, not a policy someone runs by
hand). For every monthly partition of v2_telemetry_samples whose entire
range is older than the cutoff:

  1. roll its raw {position, signal} rows up into TelemetryCoverageBin
     (~150 m geohash-7 cells x network type: weighted-merged mean / p10 /
     min signal, sample & approx-device counts, time span) — kept
     indefinitely;
  2. DROP the partition — instant, no VACUUM debt.

Old TelemetryBatch idempotency-ledger rows are pruned to the same cutoff
(the SDK only ever retries within minutes, so days of history is ample).

Default retention is settings.TELEMETRY_RETENTION_DAYS (90). Meant to run
daily. The DEFAULT partition and the current/near-future month partitions
are never touched.

**2026-09-01 — coordinated with roll_telemetry_bins.py.** That command
now rolls recent raw samples into TelemetryCoverageBin every few minutes
(instead of this command being the only path, which meant a fresh sample
never appeared on the Coverage map until its whole month aged out). The
aggregation below is filtered to `received_at > <roll watermark>` so a
partition that roll_telemetry_bins has already merged doesn't get
double-counted here — by the time a partition is old enough to prune,
that watermark will normally already be past its entire range, so this
pass aggregates zero *new* rows and just drops the (already-merged)
table. See roll_telemetry_bins.py's module docstring for the full
correctness argument; TelemetryRollState is the shared bookkeeping row.
"""
import re
from datetime import datetime, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connection, transaction
from django.utils import timezone

from core.models import TelemetryBatch, TelemetryRollState

_PART_RE = re.compile(r'^v2_telemetry_samples_(\d{4})(\d{2})$')

# Fold one expired partition into the coverage bins. All group-by /
# percentile / weighted-merge work happens in Postgres.
_AGGREGATE_SQL = """
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
  FROM {part}
  WHERE location IS NOT NULL
    -- Skip whatever roll_telemetry_bins.py already merged (see this
    -- file's module docstring) — NULL watermark (that command has never
    -- run) means "aggregate everything," same as before it existed.
    AND received_at > COALESCE(%(watermark)s, '-infinity'::timestamptz)
) s
-- 2026-09-02: grouped by mnc too (was just gh, network_type) so
-- User.operator_mncs-scoped Coverage-map queries can filter bins by
-- operator — see TelemetryCoverageBin's `mnc` field comment for why
-- pre-existing bins (rolled up before this change) stay blank/mixed.
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


class Command(BaseCommand):
    help = 'Aggregate + drop expired telemetry partitions; prune the batch ledger.'

    def add_arguments(self, parser):
        parser.add_argument('--older-than-days', type=int, default=None)
        parser.add_argument('--dry-run', action='store_true')

    def handle(self, *args, **o):
        days = o['older_than_days'] or getattr(settings, 'TELEMETRY_RETENTION_DAYS', 90)
        cutoff = (timezone.now() - timedelta(days=days)).date()
        dry = o['dry_run']
        watermark = TelemetryRollState.objects.filter(pk=1).values_list('last_rolled_at', flat=True).first()

        with connection.cursor() as cur:
            cur.execute("""
                SELECT c.relname
                FROM pg_inherits i
                JOIN pg_class c   ON c.oid = i.inhrelid
                JOIN pg_class p   ON p.oid = i.inhparent
                WHERE p.relname = 'v2_telemetry_samples'
                ORDER BY c.relname
            """)
            parts = [r[0] for r in cur.fetchall()]

        pruned = kept = 0
        for part in parts:
            m = _PART_RE.match(part)
            if not m:  # v2_telemetry_samples_default, or anything unexpected
                kept += 1
                continue
            year, month = int(m.group(1)), int(m.group(2))
            # partition covers [month_start, next_month_start); prune only
            # once the WHOLE range is past the cutoff.
            nxt_y = year + (month // 12)
            nxt_m = month % 12 + 1
            part_end = datetime(nxt_y, nxt_m, 1).date()
            if part_end > cutoff:
                kept += 1
                continue

            if dry:
                with connection.cursor() as cur:
                    cur.execute(f'SELECT count(*) FROM {part}')
                    n = cur.fetchone()[0]
                self.stdout.write(f'[dry-run] would aggregate + drop {part} ({n} rows)')
                pruned += 1
                continue

            with transaction.atomic():
                with connection.cursor() as cur:
                    cur.execute(_AGGREGATE_SQL.format(part=part), {'watermark': watermark})
                    aggregated = cur.rowcount
                    cur.execute(f'DROP TABLE {part}')
            self.stdout.write(f'{part}: rolled into {aggregated} coverage bin(s), partition dropped')
            pruned += 1

        # Batch ledger — plain delete, no aggregation.
        old_batches = TelemetryBatch.objects.filter(
            received_at__lt=timezone.now() - timedelta(days=days)
        )
        bcount = old_batches.count()
        if not dry:
            old_batches.delete()

        verb = 'Would prune' if dry else 'Pruned'
        self.stdout.write(self.style.SUCCESS(
            f'{verb} {pruned} partition(s) (kept {kept}); '
            f'{"would remove" if dry else "removed"} {bcount} old batch-ledger row(s). '
            f'Retention: {days} days (cutoff {cutoff}).'
        ))
