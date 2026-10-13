"""
python manage.py cqi_rsrq_calibration [--drive-tests] [--days N]

Read-only. Checks the RSRQ fallback of the CQI estimate against this
network's own data, and prints a table to use in its place.

For a sample with no SINR the CQI is estimated from RSRQ with a step table
(core/cqi.py, `rsrq_table`). RSRQ moves with cell load as well as with
quality, so the table is only as good as the data it was taken from. This
command sets the RSRQ estimate against a better figure for the same
reading, per whole dB of RSRQ.

Two sources:

  (default)       phone samples (TelemetrySample, LTE) of the last --days
                  that have both SINR and RSRQ. The better figure is the
                  CQI worked out from SINR. Many phones report no SINR at
                  all; prod had none on 2026-10-12, and then there is
                  nothing to compare.
  --drive-tests   every stored 4G drive-test reading with a MEASURED CQI
                  (DriveTestSample, cqi_estimated false): an Excel export
                  from the TEMS server carries the CQI the test phone
                  reported. A CQI filled in from SINR at upload (every
                  TEMS .trp log) is left out; the first table was built
                  on those and was wrong for it. The built-in table came
                  from nine such exports.

It changes nothing. To apply the printed table, put the CQI_CONFIG_JSON
line in .env and restart django. Coverage bins already rolled up keep the
averages they were given.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.cqi import RSRP_RSRQ, compute_cqi, resolve_config
from core.models import DriveTestSample, TelemetrySample

# An RSRQ value with fewer readings than this is too thin to set a step from.
MIN_PER_STEP = 50
MIN_TOTAL = 500


class Command(BaseCommand):
    help = 'Compare the RSRQ-based CQI estimate with the SINR-based one on stored readings (read-only).'

    def add_arguments(self, parser):
        parser.add_argument('--drive-tests', action='store_true',
                            help='Use 4G drive-test readings, not phone samples.')
        parser.add_argument('--days', type=int, default=90,
                            help='Phone samples only: how far back to look (default 90).')

    def _pairs(self, o):
        if o['drive_tests']:
            return (DriveTestSample.objects
                    .filter(session__tech='4G', cqi__isnull=False, cqi_estimated=False, rsrq__isnull=False)
                    .exclude(cell_role='neighbor')
                    .values_list('rsrq', 'cqi')), '4G drive-test readings with a measured CQI and an RSRQ'
        since = timezone.now() - timedelta(days=o['days'])
        return (TelemetrySample.objects
                .filter(network_type='LTE', received_at__gte=since, sinr_db__isnull=False, rsrq_db__isnull=False)
                .values_list('rsrq_db', 'sinr_db')), (
                    f'LTE phone samples with both SINR and RSRQ in the last {o["days"]} days')

    def handle(self, *args, **o):
        pairs, label = self._pairs(o)
        cache, by_rsrq, n = {}, {}, 0
        measured = o['drive_tests']
        for rsrq, other in pairs.iterator(chunk_size=5000):
            if measured:
                better = int(other)
            else:
                key = round(float(other), 1)
                if key not in cache:
                    cache[key] = compute_cqi(sinr_db=key)['cqi_index']
                better = cache[key]
            by_rsrq.setdefault(int(round(rsrq)), []).append(better)
            n += 1

        self.stdout.write(f'{label}: {n}')
        if n == 0:
            self.stdout.write('Nothing to compare.')
            if not o['drive_tests']:
                self.stdout.write('Phones often report no SINR. Try: manage.py cqi_rsrq_calibration --drive-tests')
            else:
                self.stdout.write('No drive test with a measured CQI is stored. Upload an Excel export from the '
                                  'TEMS server; a .trp log carries no CQI.')
            return

        cfg = resolve_config()
        current = 'a step table' if cfg['rsrq_table'] is not None else (
            f'the line CQI = {cfg["rsrq_slope"]} x RSRQ + {cfg["rsrq_intercept"]}')
        self.stdout.write(f'Current RSRQ estimate: {current}')
        self.stdout.write('')
        column = 'measured CQI (mean)' if measured else 'CQI from SINR (mean)'
        self.stdout.write(f'RSRQ dB | readings | {column} | current estimate | difference')
        miss = 0.0
        for rsrq in sorted(by_rsrq, reverse=True):
            values = by_rsrq[rsrq]
            mean = sum(values) / len(values)
            now = compute_cqi(rsrq_db=rsrq, method=RSRP_RSRQ)['cqi_index']
            miss += sum(abs(now - v) for v in values)
            self.stdout.write(f'{rsrq:7d} | {len(values):8d} | {mean:20.1f} | {now:16d} | {now - mean:+.1f}')
        self.stdout.write('')
        against = 'the measured CQI' if measured else 'the SINR-based CQI'
        self.stdout.write(f'Average miss of the current estimate against {against}: {miss / n:.1f} steps')

        if n < MIN_TOTAL:
            self.stdout.write(f'Fewer than {MIN_TOTAL} readings: too few to make a table from. Collect more first.')
            return

        # One step per whole dB that has enough readings: its rounded mean,
        # never allowed to rise as RSRQ falls. Equal neighbours are merged.
        steps, last = [], 15
        for rsrq in sorted((q for q, v in by_rsrq.items() if len(v) >= MIN_PER_STEP), reverse=True):
            values = by_rsrq[rsrq]
            cqi = min(last, int(round(sum(values) / len(values))))
            last = cqi
            if steps and steps[-1][1] == cqi:
                steps[-1][0] = rsrq - 0.5
            else:
                steps.append([rsrq - 0.5, cqi])
        floor = int(cfg['rsrq_min_cqi'])
        steps = [s for s in steps if s[1] > floor]
        if not steps:
            self.stdout.write('No RSRQ value has enough readings to set a step.')
            return

        def fitted(q):
            return next((cqi for low, cqi in steps if q >= low), floor)

        new_miss = sum(abs(fitted(q) - v) for q, values in by_rsrq.items() for v in values) / n
        self.stdout.write('')
        self.stdout.write('Table from this data (lowest RSRQ dB of each step, CQI):')
        for low, cqi in steps:
            self.stdout.write(f'  RSRQ >= {low:6.1f} dB -> CQI {cqi}')
        self.stdout.write(f'  below that        -> CQI {floor}')
        self.stdout.write(f'Its average miss on this same data: {new_miss:.1f} steps')
        self.stdout.write('To use it, set in .env and restart django:')
        self.stdout.write("CQI_CONFIG_JSON='{\"rsrq_table\": " + str(steps).replace(' ', '') + "}'")
