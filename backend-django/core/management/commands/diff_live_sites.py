"""
diff_live_sites (2026-09-07).

Compares the live source (NetBox, or whatever LIVE_SITE_SYNC_API_URL /
the Live Site Sync config point at) against what's currently stored in
Site -- WITHOUT writing anything -- and writes three CSV reports so a
human can decide, site by site, which side is right.

Written after a raw count mismatch (an old Excel-imported Site table
showing 4,966 rows vs. a different tool's fresh NetBox pull showing
4,925) turned out to be uncomparable: the 4,966 had never actually been
touched by this app's live sync at all. A total count can never answer
"is my Excel data more current, or does it have stale sites that should
be removed?" -- only a per-site-id diff can, which is what this produces.
"""
import csv
import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.live_sites import LIVE_SITE_COMPARE_FIELDS, build_live_site_map
from core.models import Site

# Columns shown in the two "only in ..." reports -- enough to recognise
# the site by eye (name, location, status) without opening live_raw.
_SUMMARY_FIELDS = ['name', 'sitename1', 'region', 'district', 'palika', 'deployment_status']

# Fields actually compared in the differs.csv report -- everything
# LIVE_SITE_COMPARE_FIELDS compares EXCEPT live_raw. live_raw is the
# entire raw source record; an Excel-imported row either never had it
# populated or had it populated from a different source shape entirely,
# so it disagrees with a fresh NetBox pull for basically every single
# site regardless of whether anything meaningful actually changed --
# including it here would flood the report with a giant JSON-blob diff
# on every row instead of the handful of real, actionable field changes.
_DIFF_REPORT_FIELDS = [f for f in LIVE_SITE_COMPARE_FIELDS if f != 'live_raw']


class Command(BaseCommand):
    help = (
        'Diffs the live source (NetBox) against the current Site table by site id, '
        'WITHOUT writing anything, and writes three CSV reports: sites only in the '
        'database (missing from the live source), sites only in the live source '
        '(missing from the database), and sites present in both but with differing '
        'field values. Use this before deciding whether to run a real sync, or to '
        'reconcile an existing Excel-imported Site table against the live source.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--file', type=str, default=None,
            help='Path to a local JSON file of live-source records instead of hitting the real API.',
        )
        parser.add_argument(
            '--output-dir', type=str, default=None,
            help=(
                'Directory to write the three CSV reports into. Defaults to '
                '<MEDIA_ROOT>/site_diff, which is bind-mounted to ./data/media on the '
                'host, so the CSVs land directly in your project folder without needing '
                '`docker cp`.'
            ),
        )
        parser.add_argument(
            '--detailed', action='store_true',
            help=(
                'Also write only_in_database_detailed.csv / only_in_live_source_detailed.csv '
                '(site_id plus name/region/district/palika/status) and differs_detailed.csv '
                '(one row per differing FIELD, with both values) alongside the plain '
                'single-column site_id lists that are always written.'
            ),
        )

    def handle(self, *args, **options):
        records = None
        if options['file']:
            with open(options['file'], encoding='utf-8') as f:
                records = json.load(f)
            if not isinstance(records, list):
                raise CommandError(f"{options['file']} does not contain a JSON list.")

        self.stdout.write('Fetching and mapping live-source records...')
        mapped, warnings = build_live_site_map(records)
        self.stdout.write(f'Live source: {len(mapped)} mappable site(s), {len(warnings)} warning(s) (skipped/duplicate records).')

        existing = {s.id: s for s in Site.objects.all()}
        self.stdout.write(f'Database: {len(existing)} site(s) currently stored.')

        only_in_db_ids = sorted(set(existing) - set(mapped))
        only_in_live_ids = sorted(set(mapped) - set(existing))
        common_ids = sorted(set(existing) & set(mapped))

        out_dir = Path(options['output_dir']) if options['output_dir'] else Path(settings.MEDIA_ROOT) / 'site_diff'
        out_dir.mkdir(parents=True, exist_ok=True)
        detailed = options['detailed']

        def write_id_list(path, ids):
            """Plain single-column CSV: one unique site_id per row, nothing
            else -- the default shape (2026-09-07, "i want only unique
            site id list, not all details") so the file drops straight
            into a spreadsheet as one column to sort/filter/paste
            elsewhere, without name/region/district noise."""
            try:
                with open(path, 'w', newline='', encoding='utf-8') as f:
                    w = csv.writer(f)
                    w.writerow(['site_id'])
                    for sid in ids:
                        w.writerow([sid])
            except PermissionError:
                # 2026-09-07: seen for real on Windows -- the previous
                # run's CSV was open in Excel, which holds an exclusive
                # lock the container can't write through. A clear message
                # here beats a raw traceback pointing at manage.py.
                raise CommandError(
                    f'Could not write {path} -- Permission denied. This almost always means '
                    f'the file is currently open in Excel (or another program) on your machine. '
                    f'Close it there and run this command again.'
                )

        # 1) In the database, but the live source has no record for this
        # id at all -- either the live source dropped/renamed the site,
        # or the database has a site the live source never knew about
        # (test data, a manual entry, or a site decommissioned in NetBox
        # but not yet reflected here).
        path_only_db = out_dir / 'only_in_database.csv'
        write_id_list(path_only_db, only_in_db_ids)

        # 2) In the live source, but the database has never seen this id
        # -- a site the live source knows about that hasn't been imported
        # (via Excel or otherwise) yet.
        path_only_live = out_dir / 'only_in_live_source.csv'
        write_id_list(path_only_live, only_in_live_ids)

        # 3) Same id on both sides, but at least one compared field
        # differs. The plain file lists just the unique site ids that
        # differ; --detailed additionally breaks each one down field by
        # field (one row per differing field, both values shown).
        differing_sites = []
        detail_rows = []
        for sid in common_ids:
            s = existing[sid]
            row = mapped[sid]
            site_differs = False
            for field in _DIFF_REPORT_FIELDS:
                old = getattr(s, field, None)
                new = row.get(field)
                if old != new:
                    detail_rows.append((sid, field, old, new))
                    site_differs = True
            if site_differs:
                differing_sites.append(sid)

        path_differs = out_dir / 'differs.csv'
        write_id_list(path_differs, differing_sites)

        detail_paths_note = ''
        if detailed:
            try:
                path_only_db_detail = out_dir / 'only_in_database_detailed.csv'
                with open(path_only_db_detail, 'w', newline='', encoding='utf-8') as f:
                    w = csv.writer(f)
                    w.writerow(['site_id'] + _SUMMARY_FIELDS)
                    for sid in only_in_db_ids:
                        s = existing[sid]
                        w.writerow([sid] + [getattr(s, field, '') for field in _SUMMARY_FIELDS])

                path_only_live_detail = out_dir / 'only_in_live_source_detailed.csv'
                with open(path_only_live_detail, 'w', newline='', encoding='utf-8') as f:
                    w = csv.writer(f)
                    w.writerow(['site_id'] + _SUMMARY_FIELDS)
                    for sid in only_in_live_ids:
                        row = mapped[sid]
                        w.writerow([sid] + [row.get(field, '') for field in _SUMMARY_FIELDS])

                path_differs_detail = out_dir / 'differs_detailed.csv'
                with open(path_differs_detail, 'w', newline='', encoding='utf-8') as f:
                    w = csv.writer(f)
                    w.writerow(['site_id', 'field', 'database_value', 'live_value'])
                    for sid, field, old, new in detail_rows:
                        w.writerow([sid, field, old, new])
            except PermissionError as exc:
                raise CommandError(
                    f'Could not write a detailed CSV -- Permission denied ({exc.filename}). This '
                    f'almost always means the file is currently open in Excel (or another program) '
                    f'on your machine. Close it there and run this command again.'
                )

            detail_paths_note = (
                f'\nDetailed versions also written: {path_only_db_detail}, '
                f'{path_only_live_detail}, {path_differs_detail}'
            )

        self.stdout.write(self.style.SUCCESS(
            f'\n'
            f'Only in database, not in live source: {len(only_in_db_ids)} site(s) -> {path_only_db}\n'
            f'Only in live source, not in database: {len(only_in_live_ids)} site(s) -> {path_only_live}\n'
            f'Present in both, at least one field differs: {len(differing_sites)} site(s) '
            f'({len(detail_rows)} field-level difference(s) total) -> {path_differs}\n'
            f'Present in both, identical: {len(common_ids) - len(differing_sites)} site(s)'
            f'{detail_paths_note}'
        ))
        for warning in warnings:
            self.stdout.write(self.style.WARNING(warning))
