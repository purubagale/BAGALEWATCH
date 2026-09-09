"""
python manage.py sync_live_sites [--file PATH] [--source-id ID] [--loop]
                                  [--poll-seconds N] [--dry-run]

One-shot by default: syncs every ENABLED LiveSiteSource row (or, with
--source-id, just that one — required if --file or --dry-run is combined
with more than one configured source, since a fetched/local record list
has to be attributed to exactly one source's status). See core/live_sites.py's
module docstring for what a sync overwrites and what never does, and
LiveSiteSource's docstring (core/models.py) for the 2026-09-08
multi-source design this command implements.

--loop runs forever instead, waking up every --poll-seconds (default 30 —
short, since it's just a cheap "is anything due yet" check, not a fetch)
and syncing whichever ENABLED sources are actually due based on their OWN
`sync_interval_minutes` (independent per-source schedules, not one shared
interval) — this is what docker-compose.yml's `site-sync` service runs,
the "scheduled automatically" side of syncing (LiveSiteSourceSyncView in
site_import.py is the other, admin-triggered "Sync now" side; both call
the same sync_live_sites()). A single source's failed pull (network
hiccup, that source's API down) logs and waits for ITS OWN next interval
rather than crashing the whole service or blocking any other source —
this command is meant to run unattended for the container's entire
lifetime, syncing every configured source for as long as the container
lives.
"""
import json
import time

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.live_sites import sync_live_sites
from core.models import LiveSiteSource

DEFAULT_POLL_SECONDS = 30


class Command(BaseCommand):
    help = 'Sync Site identity/location/on-air data from the live Site Directory API(s).'

    def add_arguments(self, parser):
        parser.add_argument(
            '--file', default=None,
            help='Read a local JSON file (a list of site records) instead of calling a live API.',
        )
        parser.add_argument(
            '--source-id', type=int, default=None,
            help=(
                'Only sync this LiveSiteSource (by id), instead of every enabled source. '
                'Required for one-shot mode when combined with --file or --dry-run and more '
                'than one source is configured.'
            ),
        )
        parser.add_argument(
            '--loop', action='store_true',
            help='Run forever, waking every --poll-seconds and syncing whichever sources are due.',
        )
        parser.add_argument(
            '--poll-seconds', type=int, default=None,
            help=(
                f'Seconds between due-checks under --loop (default: {DEFAULT_POLL_SECONDS}). '
                'This is NOT the sync interval itself -- each source has its own '
                '`sync_interval_minutes`; this is only how often the loop checks whether any '
                'source has become due.'
            ),
        )
        parser.add_argument(
            '--dry-run', action='store_true',
            help=(
                'Fetch and map records as usual but write nothing to Site, and never touch the '
                "source's own status fields -- prints the created/updated counts plus a sample "
                'of mapped rows so a newly-configured source can be sanity-checked before its '
                'first real run. Incompatible with --loop.'
            ),
        )

    def _resolve_sources(self, source_id, *, require_single):
        if source_id is not None:
            source = LiveSiteSource.objects.filter(pk=source_id).first()
            if source is None:
                raise CommandError(f'No LiveSiteSource with id={source_id}.')
            return [source]
        sources = list(LiveSiteSource.objects.filter(enabled=True))
        if not sources:
            raise CommandError(
                'No enabled Live Site source is configured -- add one on the Live Site Sync '
                'admin page first, or pass --source-id.'
            )
        if require_single and len(sources) > 1:
            raise CommandError(
                f'{len(sources)} enabled sources are configured -- pass --source-id to pick '
                'which one this record list/dry-run belongs to.'
            )
        return sources

    def _run_one(self, source, records, dry_run=False):
        result = sync_live_sites(source=source, records=records, dry_run=dry_run)
        verb = 'Would sync' if dry_run else 'Synced'
        self.stdout.write(self.style.SUCCESS(
            f"[{source.name}] {verb}: {result['created']} created, {result['updated']} updated, "
            f"{result.get('unchanged', 0)} unchanged, {len(result['warnings'])} warning(s)."
        ))
        for warning in result['warnings']:
            self.stdout.write(self.style.WARNING(f'[{source.name}] {warning}'))
        if dry_run:
            for row in result.get('sample', []):
                self.stdout.write(f'  sample: {row}')
        return result

    def _run_once(self, options):
        records = None
        if options['file']:
            with open(options['file'], encoding='utf-8') as f:
                records = json.load(f)
            if not isinstance(records, list):
                raise CommandError(f"{options['file']} does not contain a JSON list.")

        # A local --file record list, or a dry run, has to be attributed
        # to exactly one source (its status/credentials aren't ambiguous
        # for a real fetch, but --file skips fetching entirely, so there's
        # nothing to disambiguate WHICH source's records these are except
        # asking) -- a plain one-shot real sync with no --file, however,
        # still means "sync every enabled source" same as --loop's due
        # sources, just once instead of forever.
        require_single = bool(options['file']) or options['dry_run']
        sources = self._resolve_sources(options['source_id'], require_single=require_single)
        for source in sources:
            self._run_one(source, records, dry_run=options['dry_run'])

    def _run_loop(self, options):
        poll_seconds = options['poll_seconds'] or DEFAULT_POLL_SECONDS
        self.stdout.write(
            f'Polling every {poll_seconds}s for due sources (Ctrl+C to stop)...'
        )
        while True:
            now = timezone.now()
            sources = LiveSiteSource.objects.filter(enabled=True)
            for source in sources:
                due = (
                    source.last_run_at is None
                    or (now - source.last_run_at).total_seconds() >= source.sync_interval_minutes * 60
                )
                if not due:
                    continue
                try:
                    self._run_one(source, records=None)
                except Exception as exc:  # noqa: BLE001 — one source's failure must never stop the others or crash-loop
                    self.stderr.write(self.style.ERROR(f'[{source.name}] Sync failed: {exc}'))
            time.sleep(poll_seconds)

    def handle(self, *args, **options):
        if options['dry_run'] and options['loop']:
            raise CommandError('--dry-run and --loop cannot be used together.')

        if not options['loop']:
            self._run_once(options)
            return

        self._run_loop(options)
