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

CHUNK = 5000

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
            # In chunks (2026-10-13): a long drive is 140,000 readings, too
            # many to hold as full objects on a small server.
            hits = moved = seen = 0
            sites = set()
            last_id = 0
            while True:
                samples = list(
                    DriveTestSample.objects.filter(session=session, id__gt=last_id).order_by('id')
                    .only('id', 'lat', 'lng', 'pci', 'bcch', 'bsic', 'scrambling_code', 'cell_id', *_SERVING_FIELDS)[:CHUNK]
                )
                if not samples:
                    break
                last_id = samples[-1].id
                seen += len(samples)
                rows = [
                    {
                        'lat': s.lat, 'lng': s.lng, 'pci': s.pci,
                        'bcch': s.bcch, 'bsic': s.bsic, 'scrambling_code': s.scrambling_code,
                        'cell_id': s.cell_id,
                    }
                    for s in samples
                ]
                attach_serving_cells(rows, session.tech or '4G')
                changed = []
                for s, r in zip(samples, rows):
                    if r.get('serving_site_id'):
                        hits += 1
                        sites.add(r['serving_site_id'])
                    if any(getattr(s, f) != r.get(f) for f in _SERVING_FIELDS):
                        if (s.serving_site_id or None) != r.get('serving_site_id'):
                            moved += 1
                        for f in _SERVING_FIELDS:
                            setattr(s, f, r.get(f))
                        changed.append(s)
                if changed and not dry_run:
                    DriveTestSample.objects.bulk_update(changed, list(_SERVING_FIELDS), batch_size=1000)
            label = session.name or session.id
            if not seen:
                continue
            if hits:
                attributed_sessions += 1
                attributed_rows += hits
            prefix = '[dry-run] ' if dry_run else ''
            self.stdout.write(
                f'{prefix}session {label}: {hits}/{seen} readings matched to {len(sites)} site(s); '
                f'{moved} given to a different site than before'
            )

        self.stdout.write(self.style.SUCCESS(
            f'Attributed {attributed_rows} sample(s) across {attributed_sessions} of {total} session(s).'
        ))
