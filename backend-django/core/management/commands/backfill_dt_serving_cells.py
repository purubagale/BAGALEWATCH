"""
python manage.py backfill_dt_serving_cells [--session ID] [--dry-run]

One-time / on-demand backfill for the serving-cell -> site attribution
feature. New sessions get their samples' serving_site_id / serving_
cell_name / serving_sector / serving_local_cell_id / serving_dist_km
stamped at upload time (core/dt_serving_cell.py, wired into
DriveTestSessionWriteSerializer.create + DriveTestSessionViewSet.samples),
but sessions uploaded before the feature existed — or uploaded while the
Site directory was empty — have those columns NULL.

Idempotent: re-running recomputes and overwrites the serving_* columns
for every processed session, so it's also the way to refresh
attributions after the Sector directory changes (a fresh PCI plan, a
site move, a first-time site import).

--session ID limits to one session; --dry-run reports without writing.
"""
from django.core.management.base import BaseCommand

from core.dt_serving_cell import attach_serving_cells
from core.models import DriveTestSample, DriveTestSession

_SERVING_FIELDS = (
    'serving_site_id', 'serving_site_name', 'serving_cell_name', 'serving_sector',
    'serving_local_cell_id', 'serving_dist_km',
)


class Command(BaseCommand):
    help = 'Backfill serving-cell -> site attribution on existing DriveTestSample rows.'

    def add_arguments(self, parser):
        parser.add_argument('--session', type=int, default=None, help='Only this session id.')
        parser.add_argument('--dry-run', action='store_true', help='Report without writing.')

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        qs = DriveTestSession.objects.all()
        if options['session'] is not None:
            qs = qs.filter(id=options['session'])

        total = attributed_sessions = attributed_rows = 0
        for session in qs.iterator():
            total += 1
            samples = list(
                DriveTestSample.objects.filter(session=session).order_by('id')
            )
            if not samples:
                continue
            rows = [
                {
                    'lat': s.lat, 'lng': s.lng, 'pci': s.pci,
                    'bcch': s.bcch, 'bsic': s.bsic, 'scrambling_code': s.scrambling_code,
                }
                for s in samples
            ]
            attach_serving_cells(rows, session.tech or '4G')
            hits = [(s, r) for s, r in zip(samples, rows) if r.get('serving_site_id')]
            label = session.name or session.id
            if not hits:
                self.stdout.write(f'session {label}: no serving cells resolved (0 of {len(samples)})')
                continue
            attributed_sessions += 1
            attributed_rows += len(hits)
            if dry_run:
                sites = {r['serving_site_id'] for _, r in hits}
                self.stdout.write(
                    f'[dry-run] session {label}: {len(hits)}/{len(samples)} samples -> '
                    f'{len(sites)} site(s) {sorted(sites)}'
                )
                continue
            for s, r in hits:
                for f in _SERVING_FIELDS:
                    setattr(s, f, r.get(f))
            DriveTestSample.objects.bulk_update(
                [s for s, _ in hits], list(_SERVING_FIELDS), batch_size=2000
            )
            self.stdout.write(f'session {label}: attributed {len(hits)}/{len(samples)} samples')

        verb = 'Would attribute' if dry_run else 'Attributed'
        self.stdout.write(self.style.SUCCESS(
            f'{verb} {attributed_rows} sample(s) across {attributed_sessions} of {total} session(s).'
        ))
