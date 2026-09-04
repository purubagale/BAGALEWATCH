"""
Live Site Directory sync (2026-08-26).

An external API is being stood up as the authoritative source for a
site's identity/location/on-air status — siteid/name/province/district/
palika/ward/lat-long/deployment status/operational technologies. Sector
details, KPI data, and drive-test sessions remain manually uploaded via
the existing Backup/Sites pages, exactly as today; this module never
touches any of that.

**Endpoint/auth not finalized yet** (2026-08-26, confirmed via
AskUserQuestion) — this module is built against the exact JSON shape
already shared (a plain list of site records), with LIVE_SITE_API_URL/
LIVE_SITE_API_KEY read from settings so real credentials can be dropped
into .env later with no code change. `sync_live_sites()` also accepts an
already-fetched `records` list directly, which is what lets this be
exercised (and the management command's `--file` option used) before a
real endpoint exists.

**Live API is authoritative for the fields it sends** (confirmed via
AskUserQuestion) — every sync OVERWRITES name/region/district/palika/
ward_no/lat/lng/deployment_status/operational_technologies from whatever
the API currently says, on the theory that a stale manual edit silently
drifting from reality is worse than an admin's one-off edit being
overwritten on the next sync. A site's OWN `status` (this app's KPI-health
traffic light), every Sector row, and all KPI/DT data are untouched.

**Sites missing from the API response are left alone** — no delete, no
deactivate. This directory is additive/corrective, not a source of truth
for "this site no longer exists"; that stays a manual/admin decision.

See docker-compose.yml's `site-sync` service for the scheduled side, and
site_import.py's LiveSiteSyncView for the manual "Sync now" side — both
call `sync_live_sites()` below, so the actual sync logic exists in
exactly one place.
"""
import logging

import requests
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import LiveSiteSyncStatus, Site

logger = logging.getLogger(__name__)

# Short province names the live API sends -> this app's canonical `region`
# strings (see CLAUDE.md's "Region names (current)" list — every other
# part of this app, including the client-side _SITE_REGION_MAP, expects
# EXACTLY these seven strings). Matched case-insensitively; both the
# sample payload's "Sudurpaschim" spelling and this app's own
# "Sudurpashchim" are accepted rather than picking one and breaking on the
# other. A province string that doesn't match anything here falls back to
# being stored as-is (see _map_region) rather than silently guessing wrong.
PROVINCE_NAME_MAP = {
    'koshi': 'Province 1 (Koshi)',
    'province 1': 'Province 1 (Koshi)',
    'madhesh': 'Province 2 (Madhesh)',
    'madhes': 'Province 2 (Madhesh)',
    'province 2': 'Province 2 (Madhesh)',
    'bagmati': 'Bagmati Province',
    'gandaki': 'Gandaki Province',
    'lumbini': 'Lumbini Province',
    'karnali': 'Karnali Province',
    'sudurpaschim': 'Sudurpashchim Province',
    'sudurpashchim': 'Sudurpashchim Province',
}

# Fields sync_live_sites() ever writes on an EXISTING Site — kept as one
# list so the bulk_update() call and the "what does this endpoint
# actually touch" question have a single answer. Deliberately excludes
# `id` (the lookup key, never itself updated) and every KPI/Sector-related
# column on Site.
LIVE_SITE_FIELDS = [
    'name', 'sitename1', 'region', 'district', 'palika', 'palika_type', 'ward_no',
    'lat', 'lng', 'deployment_status', 'operational_technologies',
    'live_site_updated_at', 'live_last_updated_at', 'live_raw', 'live_synced_at',
]


def _map_region(raw_province):
    if not raw_province:
        return ''
    mapped = PROVINCE_NAME_MAP.get(raw_province.strip().lower())
    return mapped or raw_province.strip()


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_datetime(value):
    if not value:
        return None
    try:
        return parse_datetime(value)
    except (TypeError, ValueError):
        return None


def _map_record(rec):
    """One live-API record -> a dict of Site field values (including
    `id`), or None for a record with no siteid — there's no primary key
    to upsert on, so it's skipped rather than guessed at."""
    site_id = (rec.get('siteid') or '').strip()
    if not site_id:
        return None
    return {
        'id': site_id,
        # sitename2 is the clean human label ("Badimalika Temple"),
        # matching how `name` is used everywhere else in this app already
        # — see the field's comment in models.py for why sitename1 isn't
        # just derived from it instead.
        'name': (rec.get('sitename2') or rec.get('sitename1') or '').strip(),
        'sitename1': (rec.get('sitename1') or '').strip(),
        'region': _map_region(rec.get('province')),
        'district': (rec.get('district') or '').strip(),
        'palika': (rec.get('palika') or '').strip(),
        'palika_type': (rec.get('palika_type') or '').strip(),
        'ward_no': _to_int(rec.get('wardno')),
        'lat': _to_float(rec.get('latitude')),
        'lng': _to_float(rec.get('longitude')),
        'deployment_status': (rec.get('status') or '').strip(),
        'operational_technologies': rec.get('operational_technologies') or [],
        'live_site_updated_at': _to_datetime(rec.get('site_updated_at')),
        'live_last_updated_at': _to_datetime(rec.get('last_updated_at')),
        'live_raw': rec,
    }


def fetch_live_sites(url=None, api_key=None, timeout=30):
    """Calls the live Site Directory API and returns its parsed JSON list.
    Raises on failure (missing config, network error, non-2xx, non-list
    body) — callers decide how to surface that (the management command
    prints and exits non-zero; LiveSiteSyncView returns it as a 502)."""
    url = url or settings.LIVE_SITE_API_URL
    if not url:
        raise RuntimeError(
            "LIVE_SITE_API_URL is not configured — see .env.example's "
            '"Live Site Directory" block.'
        )
    key = api_key if api_key is not None else settings.LIVE_SITE_API_KEY
    headers = {'Authorization': f'Bearer {key}'} if key else {}
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError('Live Site Directory API response was not a JSON list.')
    return data


def _do_sync(records):
    if records is None:
        records = fetch_live_sites()

    mapped = {}
    warnings = []
    for rec in records:
        row = _map_record(rec)
        if row is None:
            warnings.append(f'Record with no siteid skipped: {rec!r:.200}')
            continue
        mapped[row['id']] = row

    if not mapped:
        return {'created': 0, 'updated': 0, 'warnings': warnings}

    now = timezone.now()
    existing = {s.id: s for s in Site.objects.filter(id__in=mapped.keys())}

    to_create = []
    to_update = []
    for site_id, row in mapped.items():
        row['live_synced_at'] = now
        site = existing.get(site_id)
        if site is None:
            to_create.append(Site(**row))
        else:
            for field, value in row.items():
                if field != 'id':
                    setattr(site, field, value)
            to_update.append(site)

    if to_create:
        Site.objects.bulk_create(to_create, batch_size=1000)
    if to_update:
        Site.objects.bulk_update(to_update, LIVE_SITE_FIELDS, batch_size=1000)

    logger.info(
        'Live Site Directory sync: %d created, %d updated, %d warning(s)',
        len(to_create), len(to_update), len(warnings),
    )
    return {'created': len(to_create), 'updated': len(to_update), 'warnings': warnings}


def sync_live_sites(records=None):
    """Upserts every record from the live Site Directory into `Site`, and
    records the attempt on the LiveSiteSyncStatus singleton either way —
    see that model's docstring for why status-tracking lives in exactly
    this one place rather than each caller (the management command's
    loop, LiveSiteSyncView) recording it separately.

    `records`: an already-fetched list of site dicts (a local JSON
    fixture, or a payload the caller fetched itself) — when None,
    fetch_live_sites() is called to get it from the real API. See the
    module docstring for what gets overwritten and what never does.

    Returns {'created': int, 'updated': int, 'warnings': [str, ...]} on
    success. Re-raises whatever _do_sync()/fetch_live_sites() raised on
    failure, AFTER recording it — callers still get their own exception
    handling (LiveSiteSyncView turns it into a 502, the management
    command's --loop catches it and retries next interval).
    """
    status, _ = LiveSiteSyncStatus.objects.get_or_create(id=1)
    status.last_run_at = timezone.now()
    try:
        result = _do_sync(records)
    except Exception as exc:
        status.last_error = str(exc)
        status.save(update_fields=['last_run_at', 'last_error'])
        raise
    else:
        status.last_success_at = status.last_run_at
        status.last_created = result['created']
        status.last_updated = result['updated']
        status.last_warnings = result['warnings']
        status.last_error = ''
        status.save(update_fields=[
            'last_run_at', 'last_success_at', 'last_created',
            'last_updated', 'last_warnings', 'last_error',
        ])
        return result


def get_sync_status():
    """Read-only view of LiveSiteSyncStatus for LiveSiteSyncView's GET —
    plain dict, not a DRF serializer, matching how every other small
    admin-status endpoint in this codebase (e.g. BackfillSiteLocationView)
    returns a hand-built Response body rather than a Serializer class for
    a shape this simple. `configured` is derived here (not stored) so it
    always reflects the CURRENT env, not whatever it was at the last run."""
    status, _ = LiveSiteSyncStatus.objects.get_or_create(id=1)
    return {
        'configured': bool(settings.LIVE_SITE_API_URL),
        'sync_interval_seconds': settings.LIVE_SITE_SYNC_INTERVAL_SECONDS,
        'last_run_at': status.last_run_at,
        'last_success_at': status.last_success_at,
        'last_created': status.last_created,
        'last_updated': status.last_updated,
        'last_warnings': status.last_warnings or [],
        'last_error': status.last_error,
    }
