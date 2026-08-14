"""
Site/Sector import from an uploaded Excel/CSV file (2026-08-05).

Original request: "since i have not uploaded complete site, coordinate,
sector details so i need feature to upload excel file such that, it
checks the uploaded file and compare with the database data of site, if
exist already then do nothing, if not exist then add data like in V1."
For `kind='sites'` that's exactly what happens — pure add-only, an
existing site's fields are NEVER touched.

Same-day follow-up specifically for `kind='sectors'`: "if site is
already present in the system and only sector is missing, then add
missing sector data, if site and sector already present then check for
update and if only update is available then update it else do nothing,
if site is not present in the system then add site as well as sector
details (by using lat long of the site...)." So sectors gets a 3-way
contract — add missing / update if genuinely different / no-op if
identical, plus auto-creating the parent site from the row's own
coordinates if it's missing entirely — deliberately more permissive
than `kind='sites'`'s pure add-only rule. Both are still a long way
short of v1's "GPS Coordinate Update" (which re-seeds lat/lng/district
for EVERY existing site from one specific embedded dataset — see
backup.py's module docstring for why that wasn't ported): this endpoint
only ever acts on the site/sector identity (ID / site+cell_name) a row
actually names, never does a blanket re-seed.

**Per-sector GPS override, 2026-08-09 follow-up: "when i upload the
sector data, also import each sector lat long also and store."** Every
row's `lat`/`lng` was already being parsed (used solely to auto-create a
missing parent Site — see `sites_to_create` below) but silently DROPPED
for a sector whose site already existed, even though Sector has carried
its own optional `lat`/`lng` override columns since the same-day Site
Detail feature that added them (see Sector.lat/lng's docstring in
models.py). `_sector_location_override()` below now decides, per row,
whether the row's coordinate is the sector's OWN distinct location (set
it) or just the site's own location repeated on that row as before (leave
the override unset/untouched) — using the same ~11m epsilon
`frontend/src/lib/sectorLocation.ts` uses for the same judgment call on
the display side, so an imported sector and a manually-edited one are
held to the same standard. Deliberately never CLEARS an existing
override when a row's coordinate happens to match the site (mirrors this
whole endpoint's "a row that doesn't carry new information about a field
never erases what's already stored in it" rule for every other field).

File parsing happens client-side (frontend/src/lib/siteImportParser.ts +
xlsxReader.ts/dtTemplateParser.ts), matching this app's established
convention for template uploads (DT session CSV/XLSX templates parse
client-side too) — this endpoint receives already-parsed plain JSON rows,
not a file upload, and is the single source of truth for the actual
"does this already exist" check (never trust a client-side existence
check alone; the browser's cached site list can be stale).

**Bulk-write rewrite, same day (real bug fix, not a style change).** The
first version of this endpoint called `Site.objects.create()`/
`Sector.objects.save()` once PER ROW inside a single `atomic()` block.
A real user's Sector Data upload (23,607 rows) hit "Import failed."
with no useful error message. Reproduced with a synthetic 24,000-row
payload against this app's own dev DB: the request took **21 seconds**
end-to-end even on local SQLite with zero network latency — against the
real deployed stack (Postgres in a separate `db` container, one round
trip per individual `.create()`/`.save()` call) this comfortably blows
past gunicorn's default 30-second worker timeout
(`backend-django/Dockerfile`'s `CMD` has no `--timeout` flag). Gunicorn
kills the worker mid-request, the connection drops, and the browser's
`fetch()` rejects before a response ever comes back — which is exactly
why the frontend showed a bare "Import failed." with no HTTP status:
`apiErrorMessage()` only adds "(HTTP nnn)" when it actually has an
`ApiError` with a real response, and there never was one.

Fixed by batching every write into `bulk_create`/`bulk_update` calls
(a handful of DB round trips total, not one per row) — see
`_apply_sites()`/`_apply_sectors()` below. Same synthetic 24,000-row
payload now completes in well under a second locally; see
docs/RUNBOOK.md's pass entry for the real timed re-test.

Gating: IsAdminOrSuperadmin, same tier as every other DB-mutating action
in this app (see IsAdminOrSuperadmin's docstring in views.py) — this is
additive-only, not destructive, so it doesn't need the extra
superadmin-only caution BackupImportView's full-replace restore does.
"""
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Sector, Site
from .views import IsAdminOrSuperadmin

SECTOR_FIELDS = [
    'sector', 'tech', 'local_cell_id', 'height', 'azimuth', 'mech_tilt', 'elec_tilt', 'pci',
    'carrier', 'site_band', 'cell_active_status', 'site_existence',
]
# 'carrier', 'site_band', 'cell_active_status', 'site_existence' added
# 2026-08-09 ("need to store all those data also") — real columns from
# the user's own 3G/2G source files that had nowhere to go before now.
# All four are plain free-text CharFields (see Sector model docstring),
# so `_coerce()` handles them like 'sector'/'tech' with no special-casing.
#
# `tech` added 2026-08-09 ("yes for 2g and 3g also need sector import") —
# it was silently missing from this list since the endpoint was first
# written, so every sector added/updated via this bulk import left
# Sector.tech at its blank default forever, regardless of what the
# uploaded row said. That's more than a cosmetic gap: core/sector_expansion.py's
# classification logic defaults a blank tech to '4G' for its
# letter-lookup (`(sector.tech or '4G')`), so 2G/3G sectors imported this
# way were silently evaluated against the 4G letter sets instead of their
# own tech's — see that module's docstring for the full story. `_coerce()`
# handles it like any other plain text field (blank means "leave alone",
# non-blank overwrites) — no special-casing needed the way lat/lng
# required.
# lat/lng are handled separately from SECTOR_FIELDS above — see
# _sector_location_override()'s docstring for why they need
# site-relative comparison instead of _coerce()'s plain "blank means
# leave alone" rule. Only included in the bulk_update() field list, not
# SECTOR_FIELDS itself, so the two field sets stay easy to tell apart at
# every call site below.
SECTOR_UPDATE_FIELDS = SECTOR_FIELDS + ['lat', 'lng']
_INT_FIELDS = {'local_cell_id', 'pci'}
_FLOAT_FIELDS = {'height', 'azimuth', 'mech_tilt', 'elec_tilt'}

# Mirrors frontend/src/lib/sectorLocation.ts's SAME_LOCATION_EPSILON_DEG
# exactly (~11m at Nepal's latitude) — keeps "is this sector's coordinate
# actually different from its site" judged the same way whether a sector
# got there via this bulk import or a manual edit on Site Detail.
_SAME_LOCATION_EPSILON_DEG = 0.0001


def _coerce(field, raw_val):
    """None/'' means "this row didn't carry a value for this field" — the
    caller treats that as "leave it alone", never as "clear it". Raises
    (TypeError, ValueError) for a genuinely bad non-blank value, same
    contract the row-level try/except below expects."""
    if raw_val in (None, ''):
        return None
    if field in _INT_FIELDS:
        return int(raw_val)
    if field in _FLOAT_FIELDS:
        return float(raw_val)
    return str(raw_val).strip()


def _sector_location_override(row, site_lat, site_lng):
    """Returns (lat, lng) if this row's own coordinate is a genuine,
    parseable, non-trivial distance from the SITE's resolved location —
    meaning this sector really does sit somewhere else (e.g. a later
    expansion cabinet) and should get its own stored override. Returns
    None for every other case (row has no lat/lng, row's lat/lng is
    unparseable, or it's within epsilon of the site) — None here always
    means "no new information", never "clear the sector's existing
    override" (see the module docstring's 2026-08-09 note)."""
    raw_lat, raw_lng = row.get('lat'), row.get('lng')
    if raw_lat in (None, '') or raw_lng in (None, '') or site_lat is None or site_lng is None:
        return None
    try:
        lat_val, lng_val = float(raw_lat), float(raw_lng)
    except (TypeError, ValueError):
        return None
    if abs(lat_val - site_lat) < _SAME_LOCATION_EPSILON_DEG and abs(lng_val - site_lng) < _SAME_LOCATION_EPSILON_DEG:
        return None
    return (lat_val, lng_val)


class ImportSitesView(APIView):
    """POST /api/v2/backup/import-sites/
    body: {kind: 'sites', rows: [{id, name, region, district, city, lat, lng}, ...]}
       or {kind: 'sectors', tech: '4G'|'3G'|'2G' (optional), rows: [{site_id, cell_name,
             sector, tech, local_cell_id, lat, lng, height, azimuth, mech_tilt, elec_tilt, pci}, ...]}

    **Per-tech upload, 2026-08-09 follow-up** ("i have some seperate
    colums of sector information than 4g... allow seperate upload of
    sector data for 4g, 3g and 2g rather than using tech type column in
    single sheet"). Real 3G/2G source spreadsheets have their own column
    layouts entirely (Carrier, Site Band, Cell Active Status, etc. — not
    just a missing Tech column), so the frontend now offers three
    separate upload slots instead of one combined sheet. A top-level
    `tech` on the request body is that slot's declaration and — when
    present — is applied to EVERY row before the per-row logic below
    runs, overriding whatever (if anything) that row's own 'tech' key
    says. Omitting `tech` falls back to the original per-row behavior
    (each row's own 'tech' field, or blank) for any caller still using
    the old single-sheet-with-a-Tech-column shape.

    'sites': a row is skipped if a Site with that id already exists
    (existing site's fields are NEVER touched — this is add-only, not an
    upsert). Otherwise a new Site is created with whatever fields the row
    provided (blank id rows were already filtered out client-side, but
    re-checked here since this endpoint must not trust the client).

    'sectors' — three-way logic, per explicit user request (2026-08-05
    follow-up, more permissive than 'sites' above): (1) site exists,
    sector missing -> add the sector. (2) site and sector both exist ->
    compare every field the row provides against the stored sector; if
    any differ, update just those fields; if none differ, do nothing (no
    wasted write). (3) site itself doesn't exist yet -> auto-create a
    minimal Site record from the row's own `lat`/`lng` before creating
    the sector under it. A blank cell in the uploaded row is never
    treated as "clear this field" during an update — only a genuinely
    different, non-blank value triggers a change, so a partial re-export
    can't silently wipe data the row simply didn't carry. The row's
    `lat`/`lng` is ALSO compared against the resolved site's own location
    (2026-08-09 follow-up) — a row whose coordinate genuinely differs
    from its site gets that stored as the sector's own GPS override (see
    `_sector_location_override()`); a row that just repeats the site's
    location (the common case) leaves the sector's override untouched.

    **"Which sector" matching, 2026-08-09 follow-up** ("siteid may be
    same but it can have 2g, 3g and 4g all in it. so manage accordingly.
    during upload, same logic used previously for already existing site,
    or sector or data to upload also need to be managed"). A Site can now
    genuinely have separate 2G/3G/4G Sector rows that happen to reuse the
    same Cell Name (each tech's own naming convention, uploaded through
    its own slot — see the "Per-tech upload" note above) — matching on
    (site_id, cell_name) ALONE, like this endpoint always has, would let
    a 2G row silently overwrite an existing 4G sector that happens to
    share that Cell Name, corrupting it. `_pick_target()` below now
    disambiguates by tech: (1) an existing sector with the SAME resolved
    tech wins outright; (2) failing that, a LEGACY sector at that
    (site_id, cell_name) with no tech recorded yet is treated as
    "unclaimed" and adopts this row's tech — this is what keeps a
    re-upload of the ~23,607 rows imported before tech tracking existed
    from silently duplicating into a second copy of every one of them;
    (3) failing both, every same-(site_id, cell_name) candidate already
    belongs to a different, CONFIRMED tech, so this row describes a
    genuinely different sector and gets its own new row instead of
    overwriting one that belongs to another technology. A row with no
    tech information at all (the pre-2026-08-09 shape, no top-level
    `tech` and no per-row 'tech') falls back to the ORIGINAL tech-blind
    "just match by (site_id, cell_name)" behavior, unchanged.

    All writes are batched (see module docstring's "Bulk-write rewrite"
    note) — row processing below is pure Python (no DB access per row),
    then a handful of `bulk_create`/`bulk_update` calls apply everything
    at once inside one transaction.
    """

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def post(self, request):
        body = request.data or {}
        kind = body.get('kind')
        rows = body.get('rows')
        if kind not in ('sites', 'sectors'):
            return Response({'detail': 'kind must be "sites" or "sectors".'}, status=400)
        if not isinstance(rows, list):
            return Response({'detail': 'rows must be a list.'}, status=400)

        tech = None
        if kind == 'sectors':
            raw_tech = (body.get('tech') or '').strip().upper()
            if raw_tech:
                if raw_tech not in ('4G', '3G', '2G'):
                    return Response({'detail': 'tech must be "4G", "3G", or "2G".'}, status=400)
                tech = raw_tech

        with transaction.atomic():
            if kind == 'sites':
                result = self._apply_sites(rows)
            else:
                result = self._apply_sectors(rows, tech=tech)

        return Response(result)

    @staticmethod
    def _apply_sites(rows):
        existing_ids = set(Site.objects.values_list('id', flat=True))
        seen_in_batch = set()
        to_create = []
        errors = []
        skipped = 0

        for i, row in enumerate(rows):
            row = row or {}
            site_id = (row.get('id') or '').strip()
            if not site_id:
                errors.append(f'Row {i + 1}: missing Site ID, skipped.')
                continue
            if site_id in existing_ids or site_id in seen_in_batch:
                skipped += 1
                continue
            lat, lng = row.get('lat'), row.get('lng')
            try:
                lat_val = float(lat) if lat not in (None, '') else None
                lng_val = float(lng) if lng not in (None, '') else None
            except (TypeError, ValueError):
                errors.append(f'Row {i + 1} ({site_id}): invalid latitude/longitude, skipped.')
                continue
            to_create.append(Site(
                id=site_id,
                name=(row.get('name') or '').strip(),
                region=(row.get('region') or '').strip(),
                district=(row.get('district') or '').strip(),
                city=(row.get('city') or '').strip(),
                lat=lat_val, lng=lng_val,
            ))
            seen_in_batch.add(site_id)

        if to_create:
            Site.objects.bulk_create(to_create, batch_size=1000)

        return {'added': len(to_create), 'updated': 0, 'skipped': skipped, 'sites_added': 0, 'errors': errors}

    @staticmethod
    def _apply_sectors(rows, tech=None):
        sites_by_id = {s.id: (s.lat, s.lng) for s in Site.objects.only('id', 'lat', 'lng')}
        # (site_id, cell_name) -> list of candidate Sector objects, NOT a
        # single sector — 2026-08-09 follow-up ("siteid may be same but
        # it can have 2g, 3g and 4g all in it"). A real site can have
        # separate 2G/3G/4G sectors that happen to reuse the same Cell
        # Name; `_pick_target()` below disambiguates the list by tech
        # instead of this dict silently picking "whichever one happened
        # to be stored under this key" the way a single-value dict would.
        sectors_by_pair: dict[tuple, list] = {}
        for sec in Sector.objects.all():
            sectors_by_pair.setdefault((sec.site_id, sec.cell_name), []).append(sec)

        sites_to_create: dict[str, Site] = {}
        sectors_to_create: list[Sector] = []
        sectors_to_update: dict[int, Sector] = {}
        errors = []
        skipped = 0

        def pick_target(pair, row_tech_key):
            """Which existing (or already-queued-this-batch) Sector a row
            should update, if any — see the class docstring's "Which
            sector matching" note for the full reasoning. Returns None
            when this row describes a genuinely new sector (nothing at
            this (site_id, cell_name) yet, or everything there already
            belongs to a confirmed different tech)."""
            candidates = sectors_by_pair.get(pair) or []
            if not candidates:
                return None
            if not row_tech_key:
                # No tech information on this row at all (the pre-
                # 2026-08-09 shape) — preserve the ORIGINAL tech-blind
                # behavior exactly: match whatever's at this key.
                return candidates[0]
            for c in candidates:
                if (c.tech or '').strip().upper() == row_tech_key:
                    return c
            for c in candidates:
                if not (c.tech or '').strip():
                    # A legacy sector with no tech recorded yet is
                    # "unclaimed" — this row's tech gets written onto it
                    # below via the normal field-update loop, reconciling
                    # it going forward instead of leaving it orphaned.
                    return c
            return None

        def resolved_site_coords(site_id):
            """The site's OWN lat/lng — from the newly-created record this
            batch is about to insert if this is the first row to name a
            missing site, otherwise from the already-existing row. Used
            purely as the reference point _sector_location_override()
            compares each row's coordinate against — never mutated."""
            if site_id in sites_to_create:
                s = sites_to_create[site_id]
                return s.lat, s.lng
            return sites_by_id.get(site_id, (None, None))

        for i, row in enumerate(rows):
            row = row or {}
            # Per-tech upload (2026-08-09, "allow seperate upload of
            # sector data for 4g, 3g and 2g rather than using tech type
            # column in single sheet") — when the caller declared a tech
            # for this whole batch, it wins over anything the row itself
            # says, since the dedicated 4G/3G/2G upload slot IS the
            # authoritative source of truth for what tech this file is.
            if tech:
                row = {**row, 'tech': tech}
            site_id = (row.get('site_id') or '').strip()
            cell_name = (row.get('cell_name') or '').strip()
            if not site_id or not cell_name:
                errors.append(f'Row {i + 1}: missing Site ID or Cell Name, skipped.')
                continue

            if site_id not in sites_by_id and site_id not in sites_to_create:
                lat, lng = row.get('lat'), row.get('lng')
                try:
                    lat_val = float(lat) if lat not in (None, '') else None
                    lng_val = float(lng) if lng not in (None, '') else None
                except (TypeError, ValueError):
                    errors.append(
                        f'Row {i + 1} ({cell_name}): site "{site_id}" not found and its lat/long are invalid — could not create it.'
                    )
                    continue
                sites_to_create[site_id] = Site(id=site_id, lat=lat_val, lng=lng_val)

            site_lat, site_lng = resolved_site_coords(site_id)
            # None unless this row's own coordinate is a genuine, different
            # location from the site (2026-08-09, "when i upload the sector
            # data, also import each sector lat long also and store") — see
            # _sector_location_override()'s docstring.
            location_override = _sector_location_override(row, site_lat, site_lng)

            raw_fields = {f: row.get(f) for f in SECTOR_FIELDS}
            pair = (site_id, cell_name)
            row_tech_key = (row.get('tech') or '').strip().upper()
            target = pick_target(pair, row_tech_key)

            if target is None:
                try:
                    values = {f: _coerce(f, v) for f, v in raw_fields.items()}
                except (TypeError, ValueError):
                    errors.append(f'Row {i + 1} ({cell_name}): invalid numeric field, skipped.')
                    continue
                # Non-null fallback — every field above is a CharField
                # that's blank=True/default='' but NOT null=True
                # (models.py), so a row with no value for one of these
                # would otherwise pass e.g. carrier=None into
                # Sector(**values) below and hit a NOT NULL constraint on
                # Postgres (SQLite is more forgiving, which is exactly
                # the kind of dev-DB-only pass this app has been burned by
                # before — see feedback_verify_outputs_copy_before_trusting).
                for text_field in ('sector', 'tech', 'carrier', 'site_band', 'cell_active_status', 'site_existence'):
                    values[text_field] = values[text_field] or ''
                if location_override is not None:
                    values['lat'], values['lng'] = location_override
                new_sector = Sector(site_id=site_id, cell_name=cell_name, **values)
                sectors_to_create.append(new_sector)
                # Visible to later rows in THIS SAME batch too — e.g. two
                # duplicate rows for the same new sector in one upload
                # should fold together, not create it twice (mirrors the
                # old sectors_to_create.get(pair) lookup this replaced).
                sectors_by_pair.setdefault(pair, []).append(new_sector)
                continue

            changed = False
            try:
                for field, raw_val in raw_fields.items():
                    new_val = _coerce(field, raw_val)
                    if new_val is None:
                        continue
                    if getattr(target, field) != new_val:
                        setattr(target, field, new_val)
                        changed = True
            except (TypeError, ValueError):
                errors.append(f'Row {i + 1} ({cell_name}): invalid numeric field, skipped.')
                continue

            if location_override is not None and (target.lat, target.lng) != location_override:
                target.lat, target.lng = location_override
                changed = True

            if changed and target.pk is not None:
                sectors_to_update[target.pk] = target
            elif not changed and target.pk is not None:
                skipped += 1
            # else: target.pk is None -> this row duplicates one already
            # queued for creation in sectors_to_create earlier in THIS
            # batch; any changes were already folded into that same
            # in-memory object above, nothing further to queue.

        if sites_to_create:
            Site.objects.bulk_create(list(sites_to_create.values()), batch_size=1000)
        if sectors_to_create:
            Sector.objects.bulk_create(sectors_to_create, batch_size=1000)
        if sectors_to_update:
            Sector.objects.bulk_update(list(sectors_to_update.values()), SECTOR_UPDATE_FIELDS, batch_size=1000)

        return {
            'added': len(sectors_to_create), 'updated': len(sectors_to_update),
            'skipped': skipped, 'sites_added': len(sites_to_create), 'errors': errors,
        }


class BackfillSiteLocationView(APIView):
    """POST /api/v2/backup/backfill-location/
    body: {updates: [{id, district, region}, ...]}

    2026-08-10 request: "there are 248 unassigned sites displaying. it
    may be due to the absence of district. find the district of the
    sites and update in district field, so that they will not be shown
    in the unassigned list." Root cause confirmed: a Site auto-created by
    a sector-only upload when its site didn't exist yet
    (`_apply_sectors` above) only ever gets `id`/`lat`/`lng` — no
    district/region/name — which is exactly why the Sidebar tree's
    `site.region || 'Unassigned'` / `site.district || 'Unassigned'`
    fallback (SidebarTree.tsx) buckets it there.

    Resolving "which district/region is this lat/lng in" needs the real
    Nepal district boundary polygons (`NEPAL_DISTRICT_BOUNDARIES`,
    frontend/src/lib/nepalDistrictBoundaries.ts) — deliberately never
    ported to this backend (see drive_test.py's `near` action docstring
    for that same decision made previously) rather than duplicating ~75
    districts' worth of polygon data a second time. So the actual point-
    in-polygon resolution happens CLIENT-SIDE (BackupPage.tsx's
    `runDistrictBackfill()`, reusing the exact same trusted
    `pointInPolygon`/`NEPAL_DISTRICT_BOUNDARIES` this app's own "Explore
    by Coordinates" feature already relies on) — this endpoint is only
    the actual DB write, given a list of already-resolved district/
    region values per site id.

    Same "never erase real data" contract as every other bulk-write
    endpoint in this module: a site's EXISTING district/region is never
    overwritten, even if the update payload includes a value for it —
    only a currently-blank field gets filled in. Admin/superadmin only,
    same tier as the sector/site import above."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def post(self, request):
        updates = request.data.get('updates')
        if not isinstance(updates, list):
            return Response({'detail': 'updates must be a list.'}, status=400)

        ids = [u.get('id') for u in updates if isinstance(u, dict) and u.get('id')]
        sites_by_id = {s.id: s for s in Site.objects.filter(id__in=ids).only('id', 'district', 'region')}

        to_update = []
        skipped = 0
        for u in updates:
            if not isinstance(u, dict):
                continue
            site = sites_by_id.get(u.get('id'))
            if site is None:
                continue
            changed = False
            new_district = (u.get('district') or '').strip()
            new_region = (u.get('region') or '').strip()
            if new_district and not site.district:
                site.district = new_district
                changed = True
            if new_region and not site.region:
                site.region = new_region
                changed = True
            if changed:
                to_update.append(site)
            else:
                skipped += 1

        if to_update:
            Site.objects.bulk_update(to_update, ['district', 'region'], batch_size=1000)

        return Response({'updated': len(to_update), 'skipped': skipped})
