"""
python manage.py backfill_nearby_sites [--dry-run]

One-time backfill for the ~1km nearby-site tagging feature (2026-07-30
request: "while saving the session nearby sites around 1km tagging is
missing. through this tag, it will be easier for future search also").
DriveTestSessionWriteSerializer.create() now computes
meta['nearby_site_ids'] for every NEW session at upload time, but
existing sessions saved before that change have no such key in their
`meta` JSONField. User explicitly chose "Backfill existing sessions
too" (via AskUserQuestion) over leaving old sessions untagged, so this
command walks every existing DriveTestSession and fills it in.

Idempotent: re-running simply recomputes and overwrites
meta['nearby_site_ids'] for every session (cheap — one query per
session against the small Site table's bounding-box-prefiltered
candidates), so it's safe to run again after Site coordinates change
(e.g. a fresh GPS import) to refresh stale tags, not just once.

--dry-run prints what would change without saving, for a quick sanity
check on the number of sessions affected before running for real
against production data.
"""
from django.core.management.base import BaseCommand

from core.models import DriveTestSample, DriveTestSession
from core.serializers import _nearby_site_ids


class Command(BaseCommand):
    help = 'Backfill meta["nearby_site_ids"] (~1km) for existing DriveTestSessions.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run', action='store_true',
            help='Compute and print results without saving anything.',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        sessions = DriveTestSession.objects.all().iterator()
        updated = 0
        total = 0
        for session in sessions:
            total += 1
            points = DriveTestSample.objects.filter(session=session).values_list('lat', 'lng')
            nearby_ids = _nearby_site_ids(points)

            meta = session.meta or {}
            before = meta.get('nearby_site_ids')
            if before == nearby_ids:
                continue  # already correct, nothing to do

            label = session.name or session.id
            if dry_run:
                self.stdout.write(
                    f'[dry-run] session {label}: {len(nearby_ids)} nearby site(s) '
                    f'(was {len(before) if before is not None else "unset"})'
                )
                continue

            meta['nearby_site_ids'] = nearby_ids
            session.meta = meta
            session.save(update_fields=['meta'])
            updated += 1
            self.stdout.write(f'session {label}: tagged {len(nearby_ids)} nearby site(s)')

        verb = 'Would update' if dry_run else 'Updated'
        self.stdout.write(self.style.SUCCESS(
            f'{verb} {updated if not dry_run else total} of {total} session(s).'
        ))
