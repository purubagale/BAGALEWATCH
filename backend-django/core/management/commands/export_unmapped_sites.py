"""
export_unmapped_sites (2026-09-08).

Writes out the full detail behind the two kinds of warning diff_live_sites/
sync_live_sites already print but only as truncated one-line summaries
(each capped to 200 chars via `{rec!r:.200}`, per live_sites.py's
build_live_site_map()) -- not enough to actually review a site's full
location/status, and not saved anywhere. Written after the user asked to
see the full list of "no siteid" sites before deciding whether they should
get a fallback ID or stay excluded from the Site Directory.

Two CSVs, both untruncated straight from the live source:

1. no_siteid_sites.csv -- every live-source record with no site_id at all
   (skipped by _map_record(), never reaches the database). These are
   real NetBox sites -- named facilities like embassies, hotels, radar
   sites, exchange buildings -- that were never assigned a value in
   NetBox's site_id custom field, so there's no id to store them under.

2. duplicate_siteid_sites.csv -- every record whose COMPUTED site_id
   collides with another record's, grouped by the shared id so both (or
   more) colliding records sit next to each other for comparison. Only
   the first one seen is ever kept by a real sync; this is what's being
   silently dropped for each one.
"""
import csv
from collections import defaultdict
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.live_sites import fetch_live_sites

# Enough to recognise/locate a site by eye without needing live_raw.
_FIELDS = [
    'sitename2', 'sitename1', 'province', 'district', 'palika', 'palika_type',
    'wardno', 'latitude', 'longitude', 'status', 'operational_technologies',
]


class Command(BaseCommand):
    help = (
        'Writes the full (untruncated) detail behind build_live_site_map()\'s '
        '"no siteid" and "duplicate siteid" warnings to two CSVs, for review before '
        'deciding whether no-siteid sites should get a fallback id or stay excluded, '
        'and which side of a siteid collision is the real one.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--output-dir', type=str, default=None,
            help=(
                'Directory to write the two CSV reports into. Defaults to '
                '<MEDIA_ROOT>/site_diff (same as diff_live_sites), bind-mounted to '
                './data/media on the host.'
            ),
        )

    def handle(self, *args, **options):
        self.stdout.write('Fetching live-source records...')
        try:
            records = fetch_live_sites()
        except Exception as exc:  # noqa: BLE001 -- surfaced as a clean CommandError below
            raise CommandError(f'Could not fetch live-source records: {exc}')
        self.stdout.write(f'{len(records)} live-source record(s) fetched.')

        no_siteid_rows = []
        by_siteid = defaultdict(list)
        for rec in records:
            site_id = (rec.get('siteid') or '').strip()
            if not site_id:
                no_siteid_rows.append(rec)
            else:
                by_siteid[site_id].append(rec)

        duplicate_groups = {sid: recs for sid, recs in by_siteid.items() if len(recs) > 1}

        out_dir = Path(options['output_dir']) if options['output_dir'] else Path(settings.MEDIA_ROOT) / 'site_diff'
        out_dir.mkdir(parents=True, exist_ok=True)

        def write_csv(path, header, rows):
            try:
                with open(path, 'w', newline='', encoding='utf-8') as f:
                    w = csv.writer(f)
                    w.writerow(header)
                    for row in rows:
                        w.writerow(row)
            except PermissionError:
                raise CommandError(
                    f'Could not write {path} -- Permission denied. This almost always means '
                    f'the file is currently open in Excel (or another program) on your machine. '
                    f'Close it there and run this command again.'
                )

        path_no_siteid = out_dir / 'no_siteid_sites.csv'
        no_siteid_rows.sort(key=lambda r: (r.get('sitename2') or r.get('sitename1') or ''))
        write_csv(
            path_no_siteid,
            _FIELDS,
            [[rec.get(f, '') for f in _FIELDS] for rec in no_siteid_rows],
        )

        path_duplicates = out_dir / 'duplicate_siteid_sites.csv'
        dup_rows = []
        for sid in sorted(duplicate_groups):
            for i, rec in enumerate(duplicate_groups[sid]):
                kept = (i == 0)
                dup_rows.append(
                    [sid, 'KEPT' if kept else 'DISCARDED'] + [rec.get(f, '') for f in _FIELDS]
                )
        write_csv(path_duplicates, ['site_id', 'kept_or_discarded'] + _FIELDS, dup_rows)

        self.stdout.write(self.style.SUCCESS(
            f'\n'
            f'No-siteid sites: {len(no_siteid_rows)} -> {path_no_siteid}\n'
            f'Duplicate-siteid groups: {len(duplicate_groups)} '
            f'({len(dup_rows)} record(s) total) -> {path_duplicates}'
        ))
