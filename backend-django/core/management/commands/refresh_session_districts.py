"""Give stored phone sessions every district they passed through (2026-10-26).

Sessions used to be named after the district of their first readings only.
This reads each session's readings (by drive_session_id), lists the districts
in the order first reached (core/collection.py districts_in) and rewrites the
session's district list, and its name while that is still the generated one.

    python manage.py refresh_session_districts [--dry-run] [--session <drive_session_id>]
"""
from django.core.management.base import BaseCommand

from core.collection import districts_in, merge_districts, session_name
from core.models import CollectionSession, TelemetrySample

MAX_ROWS = 50000       # readings read per session
MAX_LOOKUPS = 40       # map lookups per session for readings with no serving site


class Command(BaseCommand):
    help = "Rewrite phone sessions' district lists and names from all their readings."

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='Show the changes, write nothing.')
        parser.add_argument('--session', help='Only this drive_session_id.')

    def handle(self, *args, **opts):
        qs = CollectionSession.objects.exclude(drive_session_id__isnull=True).exclude(drive_session_id='')
        if opts.get('session'):
            qs = qs.filter(drive_session_id=opts['session'])
        changed = 0
        for s in qs.order_by('started_at').iterator():
            rows = list(TelemetrySample.objects.filter(drive_session_id=s.drive_session_id).order_by('ts')
                        .values('serving_site_id', 'lat', 'lng')[:MAX_ROWS])
            if not rows:
                continue
            district = merge_districts('', districts_in(rows, max_lookups=MAX_LOOKUPS))
            if not district or district == s.district:
                continue
            fields = {'district': district}
            if not s.name or s.name == session_name(s.source, s.district, s.started_at):
                fields['name'] = session_name(s.source, district, s.started_at)
            changed += 1
            self.stdout.write(f'{s.drive_session_id}: {s.district or "-"} -> {district}'
                              + (f'  ({fields["name"]})' if 'name' in fields else '  (name kept)'))
            if not opts['dry_run']:
                CollectionSession.objects.filter(pk=s.pk).update(**fields)
        self.stdout.write(f'{changed} session(s) {"would change" if opts["dry_run"] else "changed"}.')
