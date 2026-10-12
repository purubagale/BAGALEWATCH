"""
python manage.py cqi_rsrq_calibration [--days N]

Read-only. Checks the RSRQ fallback of the CQI estimate against this
network's own data.

Some phones report SINR and some do not. For a sample with no SINR the CQI
is estimated from RSRQ with a straight line (core/cqi.py, `rsrq_slope` and
`rsrq_intercept`). RSRQ moves with cell load as well as with quality, so
that line is a guess until it is compared with real samples. This command
takes every stored LTE sample that has BOTH an SINR and an RSRQ, works out
the CQI from SINR (the better estimate), and shows per RSRQ value what the
RSRQ line says next to it. It then fits the line to the data and prints
the setting to use.

It changes nothing. To apply the fitted line, put the printed
CQI_CONFIG_JSON in .env and restart django. Bins already rolled up keep
the averages they were given.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.cqi import RSRP_RSRQ, compute_cqi, resolve_config
from core.models import TelemetrySample

MIN_PAIRS_FOR_FIT = 50


class Command(BaseCommand):
    help = 'Compare the RSRQ-based CQI estimate with the SINR-based one on stored samples (read-only).'

    def add_arguments(self, parser):
        parser.add_argument('--days', type=int, default=90, help='How far back to look (default 90).')

    def handle(self, *args, **o):
        since = timezone.now() - timedelta(days=o['days'])
        pairs = TelemetrySample.objects.filter(
            network_type='LTE', received_at__gte=since, sinr_db__isnull=False, rsrq_db__isnull=False,
        ).values_list('rsrq_db', 'sinr_db')

        by_rsrq = {}
        xs, ys = [], []
        for rsrq, sinr in pairs.iterator(chunk_size=5000):
            from_sinr = compute_cqi(sinr_db=sinr)['cqi_index']
            by_rsrq.setdefault(int(round(rsrq)), []).append(from_sinr)
            xs.append(float(rsrq))
            ys.append(float(from_sinr))

        n = len(xs)
        self.stdout.write(f'LTE samples with both SINR and RSRQ in the last {o["days"]} days: {n}')
        if n == 0:
            self.stdout.write('Nothing to compare. The RSRQ line cannot be checked on this data.')
            return

        cfg = resolve_config()
        self.stdout.write(f'Current line: CQI = {cfg["rsrq_slope"]} x RSRQ + {cfg["rsrq_intercept"]}')
        self.stdout.write('')
        self.stdout.write('RSRQ dB | samples | CQI from SINR (mean) | CQI from RSRQ line | difference')
        for rsrq in sorted(by_rsrq, reverse=True):
            values = by_rsrq[rsrq]
            mean = sum(values) / len(values)
            line = compute_cqi(rsrq_db=rsrq, method=RSRP_RSRQ)['cqi_index']
            self.stdout.write(f'{rsrq:7d} | {len(values):7d} | {mean:20.1f} | {line:18d} | {line - mean:+.1f}')

        if n < MIN_PAIRS_FOR_FIT:
            self.stdout.write('')
            self.stdout.write(f'Fewer than {MIN_PAIRS_FOR_FIT} samples: too few to fit a line. Collect more first.')
            return

        mean_x, mean_y = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mean_x) ** 2 for x in xs)
        if sxx == 0:
            self.stdout.write('')
            self.stdout.write('Every sample has the same RSRQ: a line cannot be fitted.')
            return
        slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / sxx
        intercept = mean_y - slope * mean_x
        # How far the fitted line still is from the SINR-based value, on average.
        error = sum(abs(max(0, min(15, round(slope * x + intercept))) - y) for x, y in zip(xs, ys)) / n
        self.stdout.write('')
        self.stdout.write(f'Fitted line: CQI = {slope:.2f} x RSRQ + {intercept:.1f}')
        self.stdout.write(f'Average miss of the fitted line against the SINR-based CQI: {error:.1f} steps')
        self.stdout.write('To use it, set in .env and restart django:')
        self.stdout.write(
            f"CQI_CONFIG_JSON='{{\"rsrq_slope\": {slope:.2f}, \"rsrq_intercept\": {intercept:.1f}}}'"
        )
