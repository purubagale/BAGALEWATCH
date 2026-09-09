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
site_import.py's LiveSiteSourceSyncView for the manual "Sync now" side —
both call `sync_live_sites()` below, so the actual sync logic exists in
exactly one place. **2026-09-08** — multiple named LiveSiteSource
connections can now be configured (see that model's docstring in
core/models.py); each is synced independently on its own schedule/
credentials, but every one still funnels through this same module.
"""
import logging
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import certifi
import requests
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import LiveSiteSource, Site

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

# NetBox's `district` Site custom field is a "Selection" custom field
# backed by choice-set id 6 (77 choices, one per district of Nepal) --
# confirmed 2026-09-07 via GET /api/extras/custom-field-choice-sets/6/
# against the live instance. NetBox returns the opaque *value* side of
# each choice ("choice31"), never the label ("Nuwakot"), so without this
# table every synced site's district would be a meaningless string like
# "choice31" instead of a real district name. Hardcoded rather than
# fetched at sync time: Nepal's 77 districts are effectively permanent
# reference data, and hardcoding avoids a second live NetBox call (and a
# second way this sync can fail) for a table that isn't expected to
# change. If NetBox's choice set is ever edited, re-fetch the endpoint
# above and refresh this dict to match.
NETBOX_DISTRICT_CHOICES = {
    'choice1': 'Taplejung', 'choice2': 'Panchthar', 'choice3': 'Ilam', 'choice4': 'Jhapa',
    'choice5': 'Morang', 'choice6': 'Sunsari', 'choice7': 'Dhankuta', 'choice8': 'Sankhuwasabha',
    'choice9': 'Bhojpur', 'choice10': 'Tehrathum', 'choice11': 'Okhaldhunga', 'choice12': 'Khotang',
    'choice13': 'Solukhumbu', 'choice14': 'Udayapur', 'choice15': 'Saptari', 'choice16': 'Siraha',
    'choice17': 'Parsa', 'choice18': 'Bara', 'choice19': 'Rautahat', 'choice20': 'Sarlahi',
    'choice21': 'Dhanusha', 'choice22': 'Mahottari', 'choice23': 'Sindhuli', 'choice24': 'Ramechhap',
    'choice25': 'Dolakha', 'choice26': 'Bhaktapur', 'choice27': 'Dhading', 'choice28': 'Kathmandu',
    'choice29': 'Kavrepalanchok', 'choice30': 'Lalitpur', 'choice31': 'Nuwakot', 'choice32': 'Rasuwa',
    'choice33': 'Sindhupalchowk', 'choice34': 'Chitwan', 'choice35': 'Makwanpur', 'choice36': 'Baglung',
    'choice37': 'Gorkha', 'choice38': 'Kaski', 'choice39': 'Lamjung', 'choice40': 'Manang',
    'choice41': 'Mustang', 'choice42': 'Myagdi', 'choice43': 'Nawalpur', 'choice44': 'Parbat',
    'choice45': 'Syangja', 'choice46': 'Tanahun', 'choice47': 'Kapilvastu', 'choice48': 'Parasi',
    'choice49': 'Rupandehi', 'choice50': 'Arghakhanchi', 'choice51': 'Gulmi', 'choice52': 'Palpa',
    'choice53': 'Dang', 'choice54': 'Pyuthan', 'choice55': 'Rolpa', 'choice56': 'Rukum East',
    'choice57': 'Banke', 'choice58': 'Bardiya', 'choice59': 'Rukum West', 'choice60': 'Salyan',
    'choice61': 'Dolpa', 'choice62': 'Humla', 'choice63': 'Jumla', 'choice64': 'Kalikot',
    'choice65': 'Mugu', 'choice66': 'Surkhet', 'choice67': 'Dailekh', 'choice68': 'Jajarkot',
    'choice69': 'Kailali', 'choice70': 'Achham', 'choice71': 'Doti', 'choice72': 'Bajhang',
    'choice73': 'Bajura', 'choice74': 'Kanchanpur', 'choice75': 'Dadeldhura', 'choice76': 'Baitadi',
    'choice77': 'Darchula',
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


# Hard ceiling on pages followed for a paginated (NetBox-style) response
# -- at NetBox's own default page size this covers roughly 100k sites,
# far past the ~4,900 this deployment actually has. A real fetch that
# somehow needs more than this is far more likely a misconfigured `next`
# link looping forever than a genuine site count, so this raises instead
# of hanging a sync indefinitely.
MAX_PAGES = 500


# NetBox's own web server certificate for *.ntc.net.np (a normal
# publicly-trusted GlobalSign cert, confirmed 2026-09-07 -- NOT a private
# corporate CA) fails Python's verification because the server doesn't
# send its intermediate certificate ("GlobalSign RSA OV SSL CA 2018")
# during the TLS handshake -- a server misconfiguration browsers paper
# over (they fetch missing intermediates themselves) but requests/
# urllib3 do not. Rather than disabling verification (verify=False),
# this supplies the one missing certificate alongside the normal
# certifi trusted-root bundle, so the chain still verifies properly end
# to end -- see core/certs/globalsign_rsa_ov_ssl_ca_2018.pem, fetched
# from GlobalSign's own certificate repository. Built once per process
# (not per request) and cached in _CA_BUNDLE_PATH.
_EXTRA_CA_CERT = Path(__file__).parent / 'certs' / 'globalsign_rsa_ov_ssl_ca_2018.pem'
_CA_BUNDLE_PATH = None


def _ca_bundle_path():
    global _CA_BUNDLE_PATH
    if _CA_BUNDLE_PATH is None:
        combined = Path('/tmp/live_sites_ca_bundle.pem')
        combined.write_text(Path(certifi.where()).read_text() + '\n' + _EXTRA_CA_CERT.read_text())
        _CA_BUNDLE_PATH = str(combined)
    return _CA_BUNDLE_PATH


def _fetch_paginated(start_url, headers, timeout):
    """Follows a plain JSON list OR a NetBox-style DRF `{"results": [...],
    "next": ...}` envelope from `start_url` onward, returning the combined
    list of records. Split out of fetch_live_sites() (2026-09-07) so the
    NetBox device lookup in _translate_netbox_records() below can reuse
    the exact same pagination-following logic against a second endpoint,
    instead of a second copy of this loop."""
    collected = []
    next_url = start_url
    for page_num in range(1, MAX_PAGES + 1):
        if not next_url:
            break
        logger.info('Live Site Directory: fetching page %d (%s)', page_num, next_url)
        resp = requests.get(next_url, headers=headers, timeout=timeout, verify=_ca_bundle_path())
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            # Plain-list source (the shape this module was originally
            # built against) — nothing to paginate.
            collected.extend(data)
            next_url = None
        elif isinstance(data, dict) and isinstance(data.get('results'), list):
            # NetBox-style DRF pagination envelope.
            collected.extend(data['results'])
            next_url = data.get('next') or None
        else:
            raise ValueError(
                'Live Site Directory API response was neither a JSON list '
                'nor a paginated {"results": [...]} object.'
            )
    else:
        raise RuntimeError(
            f'Live Site Directory API pagination did not terminate within {MAX_PAGES} pages '
            '— check the source\'s `next` links before raising this limit.'
        )
    logger.info('Live Site Directory: fetched %d record(s) from %s', len(collected), start_url)
    return collected


def fetch_live_sites(url=None, api_key=None, auth_scheme=None, timeout=30):
    """Calls the live Site Directory API and returns its parsed JSON list,
    transparently paging through a NetBox-style `{"count", "next",
    "results": [...]}` envelope if that's what comes back (added
    2026-09-07 when NetBox became the real source -- the original version
    of this function only accepted a flat JSON array, which is what the
    sample payload this module was first built against looked like).
    Raises on failure (missing config, network error, non-2xx, unrecognized
    body shape) — callers decide how to surface that (the management
    command prints and exits non-zero; LiveSiteSyncView returns it as a
    502).

    Resolution order for url/api_key/auth_scheme, each independently: an
    explicit argument (2026-09-08 on — always a specific LiveSiteSource
    row's own credentials, resolved by the caller; see sync_live_sites()),
    then the LIVE_SITE_API_URL/LIVE_SITE_API_KEY env vars (the original
    .env-only design, still supported so a deployment that has never
    configured a source in the app keeps working). This function never
    writes anywhere — only reads whatever it's given/falls back to.
    """
    url = url or settings.LIVE_SITE_API_URL
    if not url:
        raise RuntimeError(
            'Live Site Directory API URL is not configured — add a source on the '
            'Live Site Sync admin page, or set LIVE_SITE_API_URL in the '
            "server's .env file (see .env.example's Live Site Directory block)."
        )
    key = api_key if api_key is not None else settings.LIVE_SITE_API_KEY
    scheme = auth_scheme or 'Bearer'
    headers = {'Authorization': f'{scheme} {key}'} if key else {}

    collected = _fetch_paginated(url, headers, timeout)

    # NetBox detection (2026-09-07) — a NetBox site record is
    # distinguishable from the original flat-schema payload by its
    # `custom_fields.site_id` key; nothing else feeding this module ever
    # has that shape. When detected, translate every record into the same
    # flat siteid/sitename2/.../operational_technologies shape
    # _map_record() already expects, so _map_record()/_do_sync() never
    # need to know NetBox exists — see _translate_netbox_records()'s own
    # docstring for the district/technology lookups this requires.
    if collected and _is_netbox_record(collected[0]):
        collected = _translate_netbox_records(collected, url, headers, timeout)

    return collected


def _is_netbox_record(rec):
    """True for a raw NetBox `/dcim/sites/` record -- identified by its
    distinctive `custom_fields.site_id` key, which nothing else feeding
    this module ever has. Checked once against the first record in a
    batch (fetch_live_sites() assumes one configured source is
    homogeneous), not on every record."""
    cf = rec.get('custom_fields')
    return isinstance(cf, dict) and 'site_id' in cf


# Placeholder values seen in NetBox's `site_id` custom field for a site
# that hasn't been assigned a real CDR number yet (a still-planned site,
# usually) -- confirmed 2026-09-07: naively prepending "CDR" to these
# would collapse every such site onto the SAME id ("CDRNA") and silently
# overwrite all but one of them in _do_sync()'s mapping step. Treated the
# same as a genuinely blank site_id -- see _netbox_site_id()'s docstring.
_NETBOX_SITE_ID_PLACEHOLDERS = {'NA', 'N/A', 'TBD', 'NONE', 'UNKNOWN', 'PENDING'}


def _netbox_site_id(rec):
    """NetBox's own `custom_fields.site_id` is inconsistently populated
    across records -- sometimes a bare number ("1283"), sometimes already
    carrying a region-code prefix ("CDR1283", "FWDR154", "EDR893",
    "WDR284", "KTM174"), sometimes a placeholder like "NA" for a site
    with no real number yet -- confirmed 2026-09-07 against real data.

    The prefixes are Nepal's old development-region codes -- CDR
    (Central), EDR (Eastern), WDR (Western), MWDR (Mid-Western), FWDR
    (Far-Western) -- plus KTM for Kathmandu Valley. "CDR" is NOT a
    universal prefix meaning "this is a valid id"; it's just one region
    among several, and a value like "FWDR154" is already a complete,
    correct id on its own.

    BUG FIXED 2026-09-07 (found from a user report of "CDRFWDR154"
    appearing in a diff report): this used to check only "does it
    already start with CDR?" and prepend "CDR" to anything that
    didn't -- corrupting already-valid codes like "FWDR154" into
    nonsense double-coded ids ("CDRFWDR154") that match nothing in
    either NetBox or this app's existing Excel-imported data. Now: any
    raw value that already starts with a letter is a complete code and
    is used as-is; only a value with NO letter prefix at all (a bare
    number) gets "CDR" prepended, matching this app's established
    convention for uncategorized/Central-region sites (see Site.id's
    comment in models.py).

    Returns '' for a placeholder or genuinely blank value -- treated by
    _map_record() as "no siteid, skip" exactly like a blank one, rather
    than becoming a fake shared id every such site collides onto."""
    raw = str((rec.get('custom_fields') or {}).get('site_id') or '').strip()
    if not raw or raw.upper() in _NETBOX_SITE_ID_PLACEHOLDERS:
        return ''
    raw_upper = raw.upper()
    if raw_upper[0].isalpha():
        return raw_upper
    return f'CDR{raw_upper}'


def _netbox_devices_url(sites_url):
    """Derives the sibling `/dcim/devices/` endpoint from whichever
    `/dcim/sites/...` URL is actually configured (any query string on it
    is dropped -- this always asks for exactly what it needs, ignoring
    the page size etc the admin configured for the sites fetch)."""
    parts = urlsplit(sites_url)
    path = parts.path.replace('/dcim/sites/', '/dcim/devices/')
    if path == parts.path:  # no trailing slash on the configured URL
        path = parts.path.replace('/dcim/sites', '/dcim/devices')
    return urlunsplit((parts.scheme, parts.netloc, path, 'tenant=wsd&limit=500', ''))


def _netbox_operational_technologies_by_site(sites_url, headers, timeout):
    """Builds {netbox_site_id: [technology, ...]} from NetBox Device
    records. NetBox's Site custom fields carry no radio-technology field
    at all (confirmed 2026-09-07 against all 49 custom fields defined on
    dcim.site) -- instead, each BTS radio at a site is its own Device
    with a role like "WSD/BTS/2G" (slug "wsd-bts-2g"), one device per RAT
    per site (verified: CDR015_GANJ_BHAWANIPUR has separate 2G/3G/4G
    devices). Filtered to tenant=wsd so the non-radio equipment also
    tracked against a site in NetBox (transport/L3 gear -- see the
    `l3_node` custom field) never becomes a fake "technology". A device
    whose role doesn't match the "wsd-bts-<tech>" pattern is skipped
    rather than guessed at."""
    devices = _fetch_paginated(_netbox_devices_url(sites_url), headers, timeout)
    by_site = {}
    for device in devices:
        role_slug = (device.get('role') or {}).get('slug') or ''
        site_id = (device.get('site') or {}).get('id')
        if site_id is None or not role_slug.startswith('wsd-bts-'):
            continue
        tech = role_slug.rsplit('-', 1)[-1].upper()
        by_site.setdefault(site_id, set()).add(tech)
    return {site_id: sorted(techs) for site_id, techs in by_site.items()}


def _netbox_coordinate(raw_lat, raw_lng):
    """`(0.0, 0.0)` in NetBox's latitude/longitude custom fields is a
    placeholder for "no real location yet" (confirmed 2026-09-07, real
    data -- 4 Cell-on-Wheels sites, e.g. "KTM427_COW3", all exactly
    0.0/0.0), NOT a real coordinate anyone would have for a Nepal site
    (0,0 is off the coast of Africa). Passed through as-is before this
    fix, `_to_float` correctly parsed it, so the sync had no reason to
    treat it as invalid -- one such site was enough to blow out
    MapView.tsx's auto-fit-to-scope bounds from Nepal to a global view.
    Returns `(None, None)` for that exact placeholder pair so
    _map_record() stores it the same way as a genuinely blank
    latitude/longitude (no marker plotted, no bounds impact); any other
    value, including a real partial value, passes through unchanged."""
    lat = _to_float(raw_lat)
    lng = _to_float(raw_lng)
    if lat == 0.0 and lng == 0.0:
        return None, None
    return raw_lat, raw_lng


def _translate_netbox_records(records, sites_url, headers, timeout):
    """Converts a batch of raw NetBox `/dcim/sites/` records into the
    flat siteid/sitename2/.../operational_technologies shape _map_record()
    already expects, so _map_record()/_do_sync() need no NetBox-specific
    branching at all -- see that function's own docstring for the field
    semantics this reuses unchanged (region normalization, ward_no/lat/
    lng coercion, etc). Makes one extra API call (paginated) to resolve
    operational_technologies from Device records -- see
    _netbox_operational_technologies_by_site()'s docstring for why that
    can't come from the Site record itself."""
    tech_by_site = _netbox_operational_technologies_by_site(sites_url, headers, timeout)
    translated = []
    for rec in records:
        cf = rec.get('custom_fields') or {}
        district_code = cf.get('district')
        latitude, longitude = _netbox_coordinate(rec.get('latitude'), rec.get('longitude'))
        translated.append({
            'siteid': _netbox_site_id(rec),
            'sitename2': (rec.get('name') or '').strip(),
            'sitename1': (cf.get('site_name') or '').strip(),
            'province': (rec.get('region') or {}).get('name') or '',
            'district': NETBOX_DISTRICT_CHOICES.get(district_code, '') if district_code else '',
            'palika': (cf.get('local_level_name') or '').strip(),
            'palika_type': '',
            'wardno': cf.get('Wardno'),
            'latitude': latitude,
            'longitude': longitude,
            'status': (rec.get('status') or {}).get('label') or '',
            'operational_technologies': tech_by_site.get(rec.get('id'), []),
            'site_updated_at': rec.get('last_updated'),
            'last_updated_at': rec.get('last_updated'),
        })
    return translated


# Fields actually compared to decide whether a site changed -- everything
# in LIVE_SITE_FIELDS except `live_synced_at`, which always changes and
# would make every site look "different" every sync if included.
LIVE_SITE_COMPARE_FIELDS = [f for f in LIVE_SITE_FIELDS if f != 'live_synced_at']


def _site_row_changed(site, row):
    """True if any field this sync would write differs from what's
    already stored for `site` -- lets _do_sync() below skip a real DB
    write for a site whose live-source data hasn't actually changed since
    the last sync (2026-09-07, requested explicitly: NetBox inventory
    data barely changes day to day, so writing every one of ~5,400 sites
    on every sync cycle regardless of whether anything moved is pure
    waste)."""
    return any(getattr(site, field) != row.get(field) for field in LIVE_SITE_COMPARE_FIELDS)


def build_live_site_map(records=None):
    """Fetches (if `records` is None) and maps live-source records into
    {site_id: row_dict}, exactly the way a real sync would -- including
    resolving duplicate ids by keeping the first record seen (see the
    comment this used to carry, now below) and returning the warnings
    generated along the way as (mapped, warnings).

    Pulled out of _do_sync() (2026-09-07) so `diff_live_sites` can build
    the exact same live-side view of the world that a real sync would,
    without duplicating the mapping/dedup logic -- asked for after a
    4,966-vs-4,925 site-count mismatch turned out to be an apples-to-
    oranges comparison (the 4,966 was an old Excel import that had never
    actually been synced against the live source at all); this is the
    building block for a proper site-by-site diff instead.
    """
    if records is None:
        records = fetch_live_sites()

    # Two different source records ending up with the same target id
    # (2026-09-07: seen for real -- NetBox has ~100+ still-unassigned
    # sites that used to all collapse onto "CDRNA", see
    # _NETBOX_SITE_ID_PLACEHOLDERS above for that specific fix) must
    # never silently overwrite one another here -- that would make a
    # real sync quietly end up with fewer sites than the source actually
    # has, with nothing in the result to say so. Every id is kept on its
    # FIRST occurrence; every later record claiming an id already taken
    # is warned about and dropped instead of silently replacing it.
    mapped = {}
    warnings = []
    for rec in records:
        row = _map_record(rec)
        if row is None:
            warnings.append(f'Record with no siteid skipped: {rec!r:.200}')
            continue
        if row['id'] in mapped:
            warnings.append(
                f"Duplicate siteid {row['id']!r} — keeping the first record seen, "
                f"discarding: {rec!r:.200}"
            )
            continue
        mapped[row['id']] = row

    return mapped, warnings


def _do_sync(records, dry_run=False):
    mapped, warnings = build_live_site_map(records)

    if not mapped:
        return {'created': 0, 'updated': 0, 'unchanged': 0, 'warnings': warnings}

    existing = {s.id: s for s in Site.objects.filter(id__in=mapped.keys())}

    to_create = []
    to_update = []
    unchanged = 0
    for site_id, row in mapped.items():
        site = existing.get(site_id)
        if site is None:
            to_create.append(row)
        elif _site_row_changed(site, row):
            to_update.append((site, row))
        else:
            unchanged += 1

    # dry_run (2026-09-07, added alongside the NetBox integration) --
    # reports the same created/updated/unchanged split a real sync would
    # produce, without writing anything and without touching
    # LiveSiteSyncStatus (see sync_live_sites()) -- letting a ~5,400-site
    # source be sanity-checked (`manage.py sync_live_sites --dry-run`)
    # before its first real run overwrites this app's Site table.
    if dry_run:
        return {
            'created': len(to_create),
            'updated': len(to_update),
            'unchanged': unchanged,
            'warnings': warnings,
            'sample': list(mapped.values())[:5],
        }

    now = timezone.now()
    create_objs = [Site(**row, live_synced_at=now) for row in to_create]
    update_objs = []
    for site, row in to_update:
        for field, value in row.items():
            if field != 'id':
                setattr(site, field, value)
        site.live_synced_at = now
        update_objs.append(site)

    if create_objs:
        Site.objects.bulk_create(create_objs, batch_size=1000)
    if update_objs:
        Site.objects.bulk_update(update_objs, LIVE_SITE_FIELDS, batch_size=1000)

    logger.info(
        'Live Site Directory sync: %d created, %d updated, %d unchanged, %d warning(s)',
        len(create_objs), len(update_objs), unchanged, len(warnings),
    )
    return {'created': len(create_objs), 'updated': len(update_objs), 'unchanged': unchanged, 'warnings': warnings}


def sync_live_sites(source=None, records=None, dry_run=False):
    """Upserts every record from the live Site Directory into `Site`, and
    (for a real, non-dry-run sync) records the attempt directly on the
    passed-in `source` (a LiveSiteSource row) — replaces the old shared
    LiveSiteSyncStatus singleton (2026-09-08, multi-source feature) now
    that each configured source needs its OWN run history rather than
    one shared "the" status for the whole app.

    `source`: the LiveSiteSource this run is for. Required for a real
    (non-dry-run) sync — status has to land somewhere, and guessing which
    source a bare `records` list came from would be wrong more often than
    right. Not required for a dry run (see below), or when `records` is
    already given and the caller genuinely doesn't need status recorded
    (there is no such caller today, but the parameter split is kept
    orthogonal rather than coupling "do I have records" to "do I have a
    source to record onto").

    `records`: an already-fetched list of site dicts (a local JSON
    fixture, or a payload the caller fetched itself) — when None, this
    fetches via `source`'s own credentials if a source was given
    (url/api_key/auth_scheme all resolved from that one row, so two
    sources never accidentally share credentials), otherwise via
    fetch_live_sites()'s own .env fallback. See the module docstring for
    what gets overwritten and what never does.

    `dry_run=True` (2026-09-07) computes and returns the same
    created/updated counts (plus a `sample` of up to 5 mapped rows)
    WITHOUT writing anything to Site, and deliberately never touches
    `source`'s status fields — a dry run never happened as far as the
    Live Site Sync admin page is concerned. Only `manage.py
    sync_live_sites --dry-run` exposes this; the scheduled loop and the
    admin "Sync now" button always do a real sync.

    Returns {'created': int, 'updated': int, 'warnings': [str, ...]} on
    success. Re-raises whatever _do_sync()/fetch_live_sites() raised on
    failure, AFTER recording it — callers still get their own exception
    handling (LiveSiteSourceSyncView turns it into a 502, the management
    command's --loop catches it and retries next interval for that
    source only, leaving every other source's own schedule unaffected).
    """
    if records is None and source is not None:
        records = fetch_live_sites(
            url=source.api_url, api_key=source.api_key, auth_scheme=source.auth_scheme,
        )

    if dry_run:
        return _do_sync(records, dry_run=True)

    if source is None:
        raise ValueError(
            'sync_live_sites() requires a `source` (a LiveSiteSource row) for a real '
            '(non-dry-run) sync, so the attempt has somewhere to be recorded.'
        )

    source.last_run_at = timezone.now()
    try:
        result = _do_sync(records)
    except Exception as exc:
        source.last_error = str(exc)
        source.save(update_fields=['last_run_at', 'last_error'])
        raise
    else:
        source.last_success_at = source.last_run_at
        source.last_created = result['created']
        source.last_updated = result['updated']
        source.last_warnings = result['warnings']
        source.last_error = ''
        source.save(update_fields=[
            'last_run_at', 'last_success_at', 'last_created',
            'last_updated', 'last_warnings', 'last_error',
        ])
        return result
