"""
python manage.py backfill_telemetry_serving_cells [--all] [--dry-run]

Matches stored phone readings to their serving site and sector again
(2026-10-19), with the rules added that day: 2G/3G by LAC + CI, and 4G by
the site an eNodeB number stands for. By default only readings with no
serving site are processed; --all redoes every reading. Readings that do
not resolve keep what they had.
"""
from django.core.management.base import BaseCommand

from core.models import TelemetrySample
from core.telemetry import attach_telemetry_serving_cells

CHUNK = 5000
_FIELDS = ('id', 'network_type', 'lat', 'lng', 'cell_id', 'tac', 'pci', 'scrambling_code', 'bcch', 'bsic')
_SERVING = ('serving_site_id', 'serving_cell_name', 'serving_sector', 'serving_local_cell_id', 'serving_dist_km')


class Command(BaseCommand):
    help = 'Match stored phone readings to their serving site and sector again.'

    def add_arguments(self, parser):
        parser.add_argument('--all', action='store_true', help='Redo readings that already have a site.')
        parser.add_argument('--dry-run', action='store_true', help='Report without writing.')

    def handle(self, *args, **options):
        qs = TelemetrySample.objects.all()
        if not options['all']:
            qs = qs.filter(serving_site_id='')
        last_id, seen, matched = 0, 0, 0
        while True:
            rows = list(qs.filter(id__gt=last_id).order_by('id').values(*_FIELDS)[:CHUNK])
            if not rows:
                break
            last_id = rows[-1]['id']
            seen += len(rows)
            attach_telemetry_serving_cells(rows)
            hits = [r for r in rows if r.get('serving_site_id')]
            matched += len(hits)
            if hits and not options['dry_run']:
                objs = []
                for r in hits:
                    obj = TelemetrySample(id=r['id'])
                    obj.serving_site_id = r['serving_site_id']
                    obj.serving_cell_name = r.get('serving_cell_name') or ''
                    obj.serving_sector = r.get('serving_sector') or ''
                    obj.serving_local_cell_id = r.get('serving_local_cell_id')
                    obj.serving_dist_km = r.get('serving_dist_km')
                    objs.append(obj)
                TelemetrySample.objects.bulk_update(objs, _SERVING, batch_size=1000)
        verb = 'would match' if options['dry_run'] else 'matched'
        self.stdout.write(f'{seen} readings checked, {verb} {matched}.')
