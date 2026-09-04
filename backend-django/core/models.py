"""
Phase 1 models: Auth (custom User), Sites, Sectors, MenuPermission.

Field names deliberately mirror the real v1 schema (bagalewatch_api.py's
SCHEMA_SQL, confirmed against the live production bagalewatch.db on
2026-07-27 — 4,718 sites / 11,932 sectors / 5 users / 74 role_permissions
rows) so the seed script (management/commands/seed_legacy_data.py) is a
close to 1:1 field copy rather than a lossy remap. Deeper normalization
(e.g. splitting the per-tech kpi_2g_json/kpi_3g_json blobs into a proper
SectorKpi table, per §3 of the migration plan) is deferred to Phase 3,
when the reporting suite actually needs ORM-level aggregation over those
values — Phase 1 only needs to read and display them.
"""
import uuid

from django.contrib.auth.models import AbstractUser
from django.contrib.gis.db.models import PointField
from django.contrib.gis.geos import Point
from django.db import models


def _point_or_none(lat, lng):
    """`Point(x, y)` is (lng, lat) — GEOS/PostGIS order longitude first,
    the opposite of this codebase's own lat/lng field order everywhere
    else, which is exactly the kind of swap that silently produces valid-
    looking points in the ocean off West Africa. Centralized here so every
    caller goes through one place instead of risking that swap per call
    site."""
    if lat is None or lng is None:
        return None
    return Point(float(lng), float(lat), srid=4326)


class SignalFloatField(models.FloatField):
    """A single-precision (`real`, 4 bytes) float column instead of
    Django's default `double precision` (8 bytes). Used only for
    DriveTestSample's RF signal readings (RSRP/RSRQ/SINR/RSCP/Ec-No/
    RxQual/throughput/serving-distance) — the single largest table in the
    app, and these values are modem-quantized to 1/16 dB or 0.5 dB, well
    within `real`'s ~7 significant digits, so nothing a coverage plot or
    its band thresholds can see changes. NOT used for lat/lng, which
    genuinely need `double` for sub-metre GPS precision. Halving 8 of the
    ~24 columns is ~30 bytes/row saved as sessions accumulate.

    DRF's ModelSerializer maps this to `serializers.FloatField` via MRO
    (it subclasses FloatField), so the API contract is unchanged."""

    def db_type(self, connection):
        return 'real'


class GeoSyncQuerySet(models.QuerySet):
    """Keeps `location` (a generated PostGIS point, see Site/
    DriveTestSample below) in sync with the real lat/lng columns for
    EVERY write path, not just `Model.save()`. Site and DriveTestSample
    are both written almost exclusively via `bulk_create`/`bulk_update`
    (site_import.py, seed_legacy_data.py, drive_test.py, serializers.py —
    none of them call `.save()` per row, for the same throughput reasons
    their own docstrings/comments already give), so a `save()` override
    alone would never actually run for real traffic. Overriding at the
    QuerySet level instead means every existing and future call site gets
    `location` populated for free, with zero changes required at the call
    site itself."""

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            obj.location = _point_or_none(obj.lat, obj.lng)
        return super().bulk_create(objs, *args, **kwargs)

    def bulk_update(self, objs, fields, *args, **kwargs):
        objs = list(objs)
        fields = list(fields)
        if ('lat' in fields or 'lng' in fields) and 'location' not in fields:
            for obj in objs:
                obj.location = _point_or_none(obj.lat, obj.lng)
            fields.append('location')
        return super().bulk_update(objs, fields, *args, **kwargs)


class User(AbstractUser):
    ROLE_CHOICES = [
        ('superadmin', 'Superadmin'),
        ('admin', 'Admin'),
        ('viewer', 'Viewer'),
        # Rescue-location lookups only (core/rescue.py's IsRescueOperator) —
        # deliberately NOT admin/superadmin-implied in the other direction;
        # see IsRescueOperator's own comment for why superadmin is granted
        # this too while admin/viewer are not.
        ('rescue_operator', 'Rescue Operator'),
    ]
    # Overrides AbstractUser's default max_length=128. The legacy password
    # hashers' rewritten algorithm prefix ('bagalewatch_legacy_pbkdf2$...')
    # pushes the encoded hash to ~130 chars, just over 128 — SQLite never
    # enforces varchar length so this passed silently in local dev, but
    # Postgres does enforce it strictly and rejected every legacy-hash
    # user with DataError: value too long for type character varying(128)
    # (found 2026-07-27, first time seeding ran against real Postgres).
    # 255 matches Django's own documented recommendation for hashers with
    # longer output (e.g. bcrypt, argon2) — covers this and any future
    # hasher without needing to revisit the prefix length again.
    password = models.CharField(max_length=255)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default='viewer')
    name = models.CharField(max_length=150, blank=True)
    dept = models.CharField(max_length=100, blank=True)

    # ── Operator data-access scope (2026-09-02) ─────────────────────────
    # Empty list (the default) = unrestricted: this account sees telemetry
    # data from every mobile operator, matching a regulator/government
    # (NTA) role or a superadmin. One or more MNC codes here restricts
    # every scoped telemetry endpoint (see telemetry.py's
    # `_scope_by_operator`) to samples/devices/coverage bins/rescue
    # lookups reporting one of those MNCs — the right posture for a single
    # telecom operator's own staff, who should never see another
    # operator's subscriber data. MNC (not an operator-name FK) because
    # it's exactly what the SDK already reports per sample (Sample.kt's
    # `mnc`, stored on TelemetrySample) — no separate operator-identity
    # mapping to keep in sync. A list rather than one value in case a
    # single account should ever legitimately span more than one operator
    # (e.g. a shared infrastructure company); the common case is one code.
    operator_mncs = models.JSONField(default=list, blank=True)

    # ── Keycloak SSO (2026-08-23) ───────────────────────────────────────
    # `auth_source` exists so the UI can tell an admin that this user's role
    # is managed by Keycloak and re-applied on every login — without it, an
    # admin edits the role on the Users page and it silently reverts next
    # time the person signs in, which looks like a bug in the app.
    AUTH_SOURCE_LOCAL = 'local'
    AUTH_SOURCE_SSO = 'sso'
    AUTH_SOURCE_CHOICES = [
        (AUTH_SOURCE_LOCAL, 'Local password'),
        (AUTH_SOURCE_SSO, 'Keycloak SSO'),
    ]
    auth_source = models.CharField(
        max_length=10, choices=AUTH_SOURCE_CHOICES, default=AUTH_SOURCE_LOCAL
    )
    # Keycloak's `sub` — the only identifier stable across username and email
    # changes in the realm, so it is what an already-linked account is found
    # by. `null=True` rather than blank='' because it is UNIQUE: Postgres (and
    # SQLite) allow many NULLs under a unique constraint but only one '', so
    # an empty-string default would let exactly one local user exist.
    sso_subject = models.CharField(
        max_length=255, null=True, blank=True, unique=True, default=None
    )

    class Meta:
        db_table = 'v2_users'

    def __str__(self):
        return f'{self.username} ({self.role})'


class Site(models.Model):
    # v1 uses a free-text site ID (e.g. "CDR0123") as the primary key, not
    # an autoincrement int — kept as-is so seeded IDs match the source
    # system exactly, which matters for any future parity check (§8 of the
    # migration plan) that compares old-system vs new-system output for
    # the same site ID.
    id = models.CharField(primary_key=True, max_length=64)
    name = models.CharField(max_length=255, blank=True, default='')
    region = models.CharField(max_length=100, blank=True, default='', db_index=True)
    city = models.CharField(max_length=100, blank=True, default='')
    district = models.CharField(max_length=100, blank=True, default='', db_index=True)
    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)
    # PostGIS point mirroring lat/lng, added 2026-08-25 for real spatial
    # queries (nearest-site / within-radius) instead of the bounding-box +
    # Python-haversine hack `_nearby_site_ids` (serializers.py) used to be
    # stuck with. lat/lng REMAIN the source of truth and the fields every
    # existing caller (frontend, serializers, CSV import/export) reads —
    # `location` is kept in sync via GeoSyncQuerySet/save() below and
    # exists purely for spatial `.filter()`/`.annotate()` lookups.
    # `geography=True` so `__distance_lte`/`__dwithin` work in real meters
    # over the whole country's extent without a manual degrees<->meters
    # conversion; `spatial_index=True` is the field default but named here
    # since the GiST index is the entire reason this field exists.
    location = PointField(geography=True, srid=4326, null=True, blank=True, spatial_index=True)

    # ── Live Site Directory sync (2026-08-26) ────────────────────────────
    # An external API (not yet wired up — see core/live_sites.py's module
    # docstring) is the authoritative source for a site's identity/
    # location/on-air state, confirmed via AskUserQuestion: every sync
    # OVERWRITES name/region/district/palika/ward_no/lat/lng/
    # deployment_status/operational_technologies. Sector/KPI/DT data is a
    # completely separate set of fields/models and none of this touches
    # them — those stay manually uploaded exactly as today.
    #
    # `sitename1`/`sitename2` both exist in the source payload and are NOT
    # reliably derivable from each other (seen identical in one real
    # sample, one embedding the site ID as a prefix in another) — `name`
    # above is populated from sitename2 (the clean human label, matching
    # how `name` is used everywhere else in this app already), and
    # `sitename1` is kept verbatim alongside it rather than guessed at or
    # discarded.
    sitename1 = models.CharField(max_length=255, blank=True, default='')
    # palika = the municipality/rural municipality (Nepal's local-government
    # tier below district) — genuinely new information this app had no
    # column for before this API. `palika_type` distinguishes
    # Municipality/Rural Municipality/Metropolitan City etc; kept as a
    # plain string, not a choices= enum, since the source system's own
    # vocabulary for this isn't something to hardcode a closed list for.
    palika = models.CharField(max_length=150, blank=True, default='')
    palika_type = models.CharField(max_length=50, blank=True, default='')
    ward_no = models.IntegerField(null=True, blank=True)
    # The source API's own "Operational"/"Planned"/etc — a SEPARATE concept
    # from `status` below (which is this app's own KPI-health traffic light:
    # ok/warn/crit/nodata, computed from uploaded KPI data). Naming this
    # `deployment_status` rather than reusing/overloading `status` keeps
    # "is this site built yet" and "is this site performing well" from
    # colliding in one column.
    deployment_status = models.CharField(max_length=30, blank=True, default='')
    # List of {technology, raw_technology, on_air_date, raw_on_air_date}
    # dicts, stored verbatim as JSON — same "normalize once the shape stops
    # evolving" call already made for kpi_2g_json/kpi_3g_json/meta
    # elsewhere in this schema, not a new pattern.
    operational_technologies = models.JSONField(null=True, blank=True)
    # The source system's own two timestamps, passed through as-is (NOT
    # this app's `updated_at`/`updated_by` below, which track a manual
    # admin edit in THIS app — a different event entirely). `live_synced_at`
    # is this app's own bookkeeping: when WE last pulled this record, which
    # is what lets an admin tell "synced 5 minutes ago" from "synced last
    # month, API may be down" without needing separate monitoring.
    live_site_updated_at = models.DateTimeField(null=True, blank=True)
    live_last_updated_at = models.DateTimeField(null=True, blank=True)
    live_synced_at = models.DateTimeField(null=True, blank=True)
    # Full raw API record for this site, verbatim. Deliberately NOT trying
    # to add a column for every field the source payload carries (e.g.
    # province_nepali/district_nepali/palika_nepali) — this app renders no
    # Nepali-language UI today, so dedicated columns for those would sit
    # unused. Keeping the raw record means that data isn't thrown away and
    # a future feature can read it straight out of here without another
    # migration or another round of "did we capture that field."
    live_raw = models.JSONField(null=True, blank=True)

    type = models.CharField(max_length=50, blank=True, default='')
    tech = models.CharField(max_length=50, blank=True, default='')
    status = models.CharField(max_length=20, blank=True, default='nodata')
    status_2g = models.CharField(max_length=20, blank=True, default='')
    status_3g = models.CharField(max_length=20, blank=True, default='')
    # Added 2026-07-28 (task tracked since Phase 3 research): v1's real
    # schema has these on the sites table (bagalewatch_api.py's
    # SCHEMA_SQL: "rssi REAL, load REAL"), confirmed still missing here
    # despite Phase 1's model docstring claiming a field-for-field port —
    # a real gap, not a deliberate omission. Needed for Scatter Plot's
    # SCATTER_KPIS list (bts_monitor.html ~12785), which includes both.
    rssi = models.FloatField(null=True, blank=True)
    load = models.FloatField(null=True, blank=True)
    kpi_entered = models.BooleanField(default=False)
    kpi_entered_2g = models.BooleanField(default=False)
    kpi_entered_3g = models.BooleanField(default=False)
    kpi_date = models.CharField(max_length=32, blank=True, default='')

    # 4G KPI columns — same flat-column shape as v1 (kept flat rather than
    # normalized in Phase 1; see module docstring).
    rrc = models.FloatField(null=True, blank=True)
    erab = models.FloatField(null=True, blank=True)
    call_setup = models.FloatField(null=True, blank=True)
    call_drop = models.FloatField(null=True, blank=True)
    svc_drop = models.FloatField(null=True, blank=True)
    intra_ho = models.FloatField(null=True, blank=True)
    inter_ho = models.FloatField(null=True, blank=True)
    inter_rat = models.FloatField(null=True, blank=True)
    ip_thru = models.FloatField(null=True, blank=True)
    ip_thru_dl = models.FloatField(null=True, blank=True)
    ip_thru_ul = models.FloatField(null=True, blank=True)
    ip_lat = models.FloatField(null=True, blank=True)
    prb = models.FloatField(null=True, blank=True)
    prb_dl = models.FloatField(null=True, blank=True)
    prb_ul = models.FloatField(null=True, blank=True)
    bearer_util = models.FloatField(null=True, blank=True)
    lic_util = models.FloatField(null=True, blank=True)
    cell_avail = models.FloatField(null=True, blank=True)
    volte_setup = models.FloatField(null=True, blank=True)
    csfb = models.FloatField(null=True, blank=True)

    kpi_2g_json = models.JSONField(null=True, blank=True)
    kpi_3g_json = models.JSONField(null=True, blank=True)

    updated_at = models.DateTimeField(null=True, blank=True)
    updated_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='updated_sites'
    )

    objects = GeoSyncQuerySet.as_manager()

    class Meta:
        db_table = 'v2_sites'
        indexes = [
            models.Index(fields=['region', 'district']),
        ]

    def save(self, *args, **kwargs):
        # Covers the .save()/.create()/update_or_create() path — see
        # GeoSyncQuerySet's docstring for why bulk_create/bulk_update need
        # their own sync instead of relying on this alone.
        self.location = _point_or_none(self.lat, self.lng)
        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.id} — {self.name}'


class Sector(models.Model):
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='sectors')
    # cell_name widened from max_length=100 to 255 alongside sector/tech
    # below (2026-08-10) — pre-emptive, not from a confirmed overflow on
    # this field specifically, but the same real-world Sector Data files
    # already overflowed two other "should be short" columns in a row
    # (site_band/cell_active_status/site_existence at 50, then sector/tech
    # at 20), so this one gets the same headroom now instead of risking a
    # third failed bulk_create on the next upload.
    cell_name = models.CharField(max_length=255, blank=True, default='')
    # sector/tech widened from max_length=20 to 100 (2026-08-10 real-world
    # fix) — a real 2G Sector Data upload hit Postgres's
    # `StringDataRightTruncation: value too long for type character
    # varying(20)` on this exact column set (confirmed via live traceback
    # — the DataError referenced no column name, but 'sector'/'tech' were
    # the only two CharFields still capped at 20 after the carrier/
    # site_band/cell_active_status/site_existence widening in migration
    # 0023). The real "Sector" column value in the file is apparently
    # longer than the short "J3"/"M20"-style codes this was originally
    # sized for. `tech` is normally just "4G"/"3G"/"2G" (set by the
    # upload slot itself, see site_import.py's ImportSitesView), but
    # widened too rather than leaving a second narrow column that could
    # bite the same way on a future file with an unexpected raw value.
    sector = models.CharField(max_length=100, blank=True, default='')
    tech = models.CharField(max_length=100, blank=True, default='')
    local_cell_id = models.IntegerField(null=True, blank=True)
    height = models.FloatField(null=True, blank=True)
    azimuth = models.FloatField(null=True, blank=True)
    mech_tilt = models.FloatField(null=True, blank=True)
    elec_tilt = models.FloatField(null=True, blank=True)
    pci = models.IntegerField(null=True, blank=True)
    scrambling_code = models.IntegerField(null=True, blank=True)
    bcch = models.IntegerField(null=True, blank=True)
    bsic = models.IntegerField(null=True, blank=True)
    kpi_json = models.JSONField(null=True, blank=True)
    kpi_date = models.CharField(max_length=32, blank=True, default='')
    # Optional per-sector GPS override (2026-08-09 request: "sometimes same
    # sites with multiple sectors may have different lat long location as
    # sector expansion"). Checked against v1 first — bts_monitor.html has
    # NO per-sector coordinate at all; every sector has always inherited
    # its parent Site's single lat/lng, including in the sector-level CSV
    # import/export (the Lat/Long columns there are the SITE's own value
    # repeated on every row, not a distinct per-sector value). This is a
    # genuinely new capability, not a port. Both null (the common case)
    # means "this sector is physically at its site's location" — every
    # existing caller (maps, exports) should fall back to the parent
    # Site's lat/lng whenever these are null, never treat null as 0,0.
    # Only set when a real second GPS reading was taken for that sector's
    # actual equipment location (e.g. a later expansion added a cabinet
    # some distance from the original site) — never fabricated/estimated.
    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)
    # 2026-08-09 follow-up ("need to store all those data also") — the
    # real 3G/2G Sector Data source files the user showed carry columns
    # this schema had no home for at all (Carrier, Site Band, Cell Active
    # Status, and a per-tech "Site Existence" flag like "3G Site
    # Existence"/"Physical Site Existance 2G"). Stored as free text,
    # exactly as uploaded — never interpreted/coerced into a boolean or
    # enum here, since the real value vocabulary (e.g. what "Active"
    # means vs some other status string) isn't something to guess at.
    # blank=True/default='' (not null=True) to match every other short
    # text field on this model (cell_name, sector, tech, kpi_date) — see
    # site_import.py's SECTOR_FIELDS comment for why that matters for the
    # bulk-import create path specifically.
    #
    # max_length=255 across all four (2026-08-10 real-world fix) — the
    # original 50-char caps on site_band/cell_active_status/
    # site_existence were a guess, and a real 2G Sector Data upload
    # (14,000 rows) hit Postgres's own
    # `StringDataRightTruncation: value too long for type character
    # varying(50)` on the very first bulk_create, confirmed via a live
    # traceback (this endpoint writes with the ORM directly, bypassing
    # SectorWriteSerializer's validation entirely, so an over-length
    # value here fails at the DB level, not as a clean 400). 255 gives
    # real headroom over the guessed 50/100 caps without going fully
    # unbounded (TextField) for what's still meant to be a short status/
    # label value, not free-form notes.
    carrier = models.CharField(max_length=255, blank=True, default='')
    site_band = models.CharField(max_length=255, blank=True, default='')
    cell_active_status = models.CharField(max_length=255, blank=True, default='')
    site_existence = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        db_table = 'v2_sectors'
        indexes = [
            models.Index(fields=['site']),
        ]

    def __str__(self):
        return f'{self.site_id} / {self.cell_name or self.sector}'


class MenuPermission(models.Model):
    # Same (role, menu_key, action) -> allowed shape as v1's role_permissions
    # table. 'action' is always 'read' for simple (non-CRUD) menus — see
    # CRUD_MENUS in bagalewatch_api.py for which menu_keys use the full
    # read/write/update/delete set.
    ACTION_CHOICES = [
        ('read', 'read'),
        ('write', 'write'),
        ('update', 'update'),
        ('delete', 'delete'),
    ]
    role = models.CharField(max_length=20)
    menu_key = models.CharField(max_length=50)
    action = models.CharField(max_length=10, choices=ACTION_CHOICES, default='read')
    allowed = models.BooleanField(default=False)

    class Meta:
        db_table = 'v2_role_permissions'
        constraints = [
            models.UniqueConstraint(fields=['role', 'menu_key', 'action'], name='uniq_role_menu_action'),
        ]

    def __str__(self):
        return f'{self.role}/{self.menu_key}/{self.action} = {self.allowed}'


# ── Phase 2: KPI thresholds, tree structure ─────────────────────────────
# Schema below mirrors bagalewatch_api.py's SCHEMA_SQL exactly (confirmed
# 2026-07-27): thresholds / tree_folders / tree_subfolders /
# site_assignments / tree_settings. v1's write endpoints for these are
# "full replace" (tree/permissions) or "upsert provided keys" (thresholds)
# rather than per-row REST CRUD — the Django views mirror that same
# contract shape rather than exposing a generic ModelViewSet, so the React
# client (which already sends v1-shaped payloads) doesn't need a rewrite.

class KpiThreshold(models.Model):
    # kpi_key is the KPI's camelCase field name (e.g. 'callDrop', matching
    # the flat Site/Sector KPI field names), not a Django FK — v1 stores
    # these as a flat key->threshold map, not tied to any specific model.
    kpi_key = models.CharField(primary_key=True, max_length=50)
    warn = models.FloatField(null=True, blank=True)
    crit = models.FloatField(null=True, blank=True)
    # 'hi' = whether higher values are better (e.g. cell_avail) vs worse
    # (e.g. call_drop) — matches v1's INTEGER 0/1 column exactly.
    hi = models.BooleanField(default=False)
    max = models.FloatField(null=True, blank=True)
    unit = models.CharField(max_length=20, blank=True, default='')

    class Meta:
        db_table = 'v2_kpi_thresholds'

    def __str__(self):
        return self.kpi_key


class TreeFolder(models.Model):
    # v1 uses client-generated string IDs (e.g. 'folder-<timestamp>'), not
    # autoincrement — kept as CharField PK to match exactly, same reasoning
    # as Site.id in the model above.
    #
    # v1's tree is a fixed 2-level hierarchy (a separate TreeSubfolder
    # table, one level deep). User requested arbitrary nesting depth
    # instead (2026-07-27 live testing) — a deliberate v2 divergence from
    # v1's schema, not something v1 itself supports. TreeSubfolder is
    # gone; this single self-referencing table now covers every depth.
    # `lat`/`lng` absorb what TreeSubfolder used to carry (v1 only put
    # coordinates on subfolders, never top-level folders) — nullable here
    # since a top-level/organizational folder has no reason to need them.
    id = models.CharField(primary_key=True, max_length=64)
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.CASCADE, related_name='children')
    name = models.CharField(max_length=100, blank=True, default='')
    icon = models.CharField(max_length=20, blank=True, default='')
    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)

    class Meta:
        db_table = 'v2_tree_folders'

    def __str__(self):
        return self.name or self.id


class SiteAssignment(models.Model):
    # One row per assigned site, PK = site (matches v1's
    # site_assignments.site_id TEXT PRIMARY KEY REFERENCES sites(id)).
    # folder_id is deliberately a plain CharField, NOT a ForeignKey — v1's
    # own schema declares its equivalent columns as plain TEXT (no
    # REFERENCES), and _set_tree_state's full-replace write order
    # (folders first, then assignments) means a dangling folder_id is
    # possible in v1 too if a client ever sends stale data. Modeling as a
    # real FK here would raise on exactly the data v1 tolerates, which
    # would be a parity regression, not an improvement. (Previously two
    # columns, folder_id + subfolder_id, matching v1's 2-level split —
    # collapsed to one now that TreeFolder itself can nest to any depth,
    # so "the folder this site is assigned to" is always a single id.)
    site = models.OneToOneField(Site, on_delete=models.CASCADE, primary_key=True, related_name='tree_assignment')
    folder_id = models.CharField(max_length=64, blank=True, null=True)

    class Meta:
        db_table = 'v2_site_assignments'

    def __str__(self):
        return f'{self.site_id} -> {self.folder_id}'


class KpiSnapshot(models.Model):
    """Daily per-site KPI snapshot, backing KPI Trend (core/kpi_trend.py).

    v1 has an equivalent store (IndexedDB `netwatch_trend_db`,
    `saveDailySnapshot()`, bts_monitor.html ~12203) but its own code
    comment says "Daily snapshot interval removed (no live feed)" — the
    function that would populate it is never actually called anywhere.
    `renderTrendCharts()` therefore almost always finds fewer than 3 real
    snapshots and falls back to `buildSimulatedHistory()`, a
    Math.random()-driven fake trend line — a direct conflict with this
    project's "never fabricate data" rule (see the RSRP boundary/hull
    memory). User decision (2026-07-28, confirmed via AskUserQuestion):
    build a real snapshot history instead, via a daily management
    command (`take_kpi_snapshot`), and show "not enough historical data
    yet" in the UI rather than fabricating anything when a site's history
    is thin. Field names are snake_case (matching Site), not v1's
    camelCase `DAILY_KPI_KEYS` — the same 16 KPIs, just this project's
    Python-side naming convention.
    """
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='kpi_snapshots')
    date = models.DateField()
    taken_at = models.DateTimeField(auto_now_add=True)

    rrc = models.FloatField(null=True, blank=True)
    erab = models.FloatField(null=True, blank=True)
    call_setup = models.FloatField(null=True, blank=True)
    call_drop = models.FloatField(null=True, blank=True)
    svc_drop = models.FloatField(null=True, blank=True)
    intra_ho = models.FloatField(null=True, blank=True)
    inter_ho = models.FloatField(null=True, blank=True)
    inter_rat = models.FloatField(null=True, blank=True)
    ip_thru = models.FloatField(null=True, blank=True)
    ip_lat = models.FloatField(null=True, blank=True)
    prb = models.FloatField(null=True, blank=True)
    bearer_util = models.FloatField(null=True, blank=True)
    lic_util = models.FloatField(null=True, blank=True)
    cell_avail = models.FloatField(null=True, blank=True)
    rssi = models.FloatField(null=True, blank=True)
    load = models.FloatField(null=True, blank=True)

    class Meta:
        db_table = 'v2_kpi_snapshots'
        constraints = [
            # One snapshot per site per day — the daily job is idempotent
            # (update_or_create), so this can never be violated by normal
            # operation; it's a safety net, not a v1-parity requirement
            # (v1's IndexedDB index was deliberately non-unique, but v1
            # never actually wrote to it in practice — see docstring above).
            models.UniqueConstraint(fields=['site', 'date'], name='uniq_kpi_snapshot_site_date'),
        ]
        indexes = [
            models.Index(fields=['site', 'date']),
        ]

    def __str__(self):
        return f'{self.site_id} @ {self.date}'


class AuditHistory(models.Model):
    """Saved RF Site Audit reports (core/rf_audit.py, Phase 3f).

    v1 has an equivalent (bagalewatch_api.py's `audit_history` table,
    saveAuditReport() in bts_monitor.html ~12159) that already persists
    server-side in multi-user mode — unlike KpiSnapshot's Math.random()
    problem, this part of v1 doesn't fabricate anything, it just saves
    whatever markdown `generateAuditReport()` produced. Ported schema
    as-is: id/site/date/content/score/created_by, translated to a real
    FK + auto id instead of v1's client-generated `Date.now()` string id.

    `site` is SET_NULL (not CASCADE) and `site_name` is stored alongside
    it as a point-in-time snapshot, so a saved audit report remains
    readable — same as v1's plain-string `site` column — even if the
    site it was taken against is later deleted from the tree.

    What's NOT persisted here, matching v1 exactly: the raw checklist
    state (auditState — checklistItem id -> pass/fail/na + note) and the
    measurement/antenna/feeder form fields. v1 never saves those either
    (auditState lives only in an in-memory JS object, reset on modal
    close) — only the final generated report text and score survive.
    """
    site = models.ForeignKey(
        Site, null=True, blank=True, on_delete=models.SET_NULL, related_name='audit_history'
    )
    site_name = models.CharField(max_length=255, blank=True, default='')
    content = models.TextField(blank=True, default='')
    score = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='audit_reports'
    )

    class Meta:
        db_table = 'v2_audit_history'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['site', '-created_at']),
        ]

    def __str__(self):
        return f'{self.site_name or self.site_id} @ {self.created_at}'


class TreeSettings(models.Model):
    # Singleton row (v1: CHECK (id = 1)) holding whether the custom tree
    # is active vs the default Province/District auto-tree.
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    custom_active = models.BooleanField(default=False)

    class Meta:
        db_table = 'v2_tree_settings'

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return f'custom_active={self.custom_active}'


class DriveTestSession(models.Model):
    """Phase 4a — Drive-Test Data Manager. Schema ported field-for-field
    from v1's *already-live* multi-user server tables (`dt_sessions` +
    `dt_records` in `bagalewatch_api.py`'s `SCHEMA_SQL`), not from the
    migration plan's own sketch (`DriveTestSession(id, name, date, tech,
    uploaded_by, point_count, file metadata)` / `DriveTestSample(session
    FK, ts, lat, lng, rsrp, rsrq, sinr, dl_throughput, pci)`) — that sketch
    predates the real research pass done for this phase and is missing
    the serving-cell and 2G/3G fields v1 actually stores (see
    `bts_monitor.html`'s `saveDtSession()`, ~5960-5994). Same "the real
    v1 server schema is the source of truth, the plan doc is a starting
    sketch" pattern already used for Site/Sector/User in Phase 1.

    **Scope decision (2026-07-28, confirmed via AskUserQuestion):** Phase
    4 ships with TRP/GPX parsing staying client-side (a React/TS port of
    v1's already-proven browser-side decoder), same as v1 — NOT the
    migration plan's literal "React → Django → Go job" pipeline. The Go
    worker / Redis job queue / Node WebSocket progress push are real,
    none of them have processed a single real job since Phase 0 stubbed
    them empty, and wiring all three at once alongside a brand-new
    23-column high-volume table was judged higher risk than shipping the
    CRUD/storage layer first and porting the processing pipeline to
    Go as a dedicated follow-up once this is verified live. This model
    layer is written to be equally correct either way — nothing here
    assumes client-side parsing forever, it's just what today's
    `POST /api/v2/dt-sessions/` endpoint expects as input.

    **Partitioning — deliberately deferred, not silently dropped.** §3 of
    the migration plan calls out `DriveTestSample`-equivalent partitioning
    "planned from day one" given real data volume (121,000+ rows across
    28 files in one production batch, per §7). Native Postgres declarative
    partitioning isn't set up in this first migration — a single
    `(session, id)` btree index is enough for correctness at the scale
    this phase ships at, and partitioning needs a real data-volume number
    from live usage to size sensibly rather than a guess. Tracked as a
    follow-up once real upload volume exists to plan against, not
    forgotten.
    """
    name = models.CharField(max_length=255, blank=True, default='')
    tech = models.CharField(max_length=10, blank=True, default='4G')
    # DateField (not v1's plain string) — a real v2-native improvement,
    # same call already made for KpiSnapshot.date, enables real ORM
    # date filtering/ordering instead of string comparison.
    date = models.DateField(null=True, blank=True)
    uploaded_date = models.DateField(null=True, blank=True)
    saved_at = models.DateTimeField(auto_now_add=True)
    uploaded_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='dt_sessions'
    )
    # v1's meta_json blob, kept as a JSONField rather than normalized —
    # routeKm/duration/startTime/endTime/gpsCount/fileNames/city/region/
    # avgRsrp plus whatever _rsrpFindNearestSite() adds (siteId/siteName/
    # siteDistKm etc.). Matches how Sector.kpi_json/Site.kpi_2g_json stay
    # as JSON blobs elsewhere in this schema — normalizing a shape that's
    # still evolving client-side (auto-naming/district-resolution logic
    # changed 3 times in v1 within one week per project memory) would be
    # premature.
    meta = models.JSONField(null=True, blank=True)
    # Computed server-side from the actual stored payload on save, not
    # trusted from the client (v1's `session.sizeBytes` is a client-
    # computed `JSON.stringify(session).length*2` estimate for its own
    # IndexedDB quota bookkeeping — meaningless once storage is Postgres,
    # kept only for the History UI's existing "session size" display).
    size_bytes = models.BigIntegerField(null=True, blank=True)

    class Meta:
        db_table = 'v2_dt_sessions'
        ordering = ['-date', '-saved_at']
        indexes = [
            models.Index(fields=['-date', '-saved_at']),
        ]

    def __str__(self):
        return f'{self.name or self.id} ({self.date})'


class DriveTestSample(models.Model):
    """One GPS-tagged reading. Field list matches v1's real `dt_records`
    table exactly (23 columns) — see `DriveTestSession`'s docstring.
    `rsrp` is reused as the generic "signal strength dBm" slot for 2G/3G
    readings too (RxLevel for 2G, RSCP-adjacent for 3G at the map-legend
    level), same convention v1 already uses (`_dtSignalLabel`/
    `_dtMetricsForTech` are tech-aware about what to call it, the storage
    column itself is generic) — `rscp`/`ecno` below are the true 3G-
    specific fields kept alongside for cases that need the real metric,
    not just the generic band color.
    """
    ROLE_CHOICES = [('serving', 'Serving'), ('neighbor', 'Neighbor')]

    session = models.ForeignKey(DriveTestSession, on_delete=models.CASCADE, related_name='samples')
    ts = models.CharField(max_length=32, blank=True, default='')
    date = models.CharField(max_length=16, blank=True, default='')
    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)
    # Mirrors Site.location — see its comment for the full rationale. Same
    # GeoSyncQuerySet keeps this synced from lat/lng on every bulk_create
    # (this table's only real write path — see the Meta.indexes comment
    # below on drive_test.py's near() and the perf history that motivated
    # the lat/lng btree index in the first place).
    location = PointField(geography=True, srid=4326, null=True, blank=True, spatial_index=True)
    rsrp = SignalFloatField(null=True, blank=True)
    rsrq = SignalFloatField(null=True, blank=True)
    sinr = SignalFloatField(null=True, blank=True)
    dl = SignalFloatField(null=True, blank=True)
    pci = models.IntegerField(null=True, blank=True)
    serving_site_id = models.CharField(max_length=64, blank=True, null=True)
    serving_site_name = models.CharField(max_length=255, blank=True, null=True)
    serving_sector = models.CharField(max_length=20, blank=True, null=True)
    serving_cell_name = models.CharField(max_length=100, blank=True, null=True)
    serving_local_cell_id = models.IntegerField(null=True, blank=True)
    serving_dist_km = SignalFloatField(null=True, blank=True)
    cell_role = models.CharField(max_length=10, choices=ROLE_CHOICES, blank=True, default='serving')
    rx_qual = SignalFloatField(null=True, blank=True)
    bcch = models.IntegerField(null=True, blank=True)
    bsic = models.IntegerField(null=True, blank=True)
    rscp = SignalFloatField(null=True, blank=True)
    ecno = SignalFloatField(null=True, blank=True)
    scrambling_code = models.IntegerField(null=True, blank=True)

    objects = GeoSyncQuerySet.as_manager()

    class Meta:
        db_table = 'v2_dt_samples'
        indexes = [
            models.Index(fields=['session']),
            # 2026-08-10 perf audit finding — drive_test.py's `near` action
            # (Explore by Coordinates) used to do a bounding-box prefilter
            # on plain lat/lng "before the exact haversine check in
            # Python" (this table is the single biggest one in the app —
            # a single upload batch can be 120,000+ rows). That was a
            # btree index on (lat, lng) standing in for real spatial
            # indexing, back when "this stack deliberately has [no]
            # PostGIS" (see the removed _haversine_km's old docstring).
            # 2026-08-25: PostGIS adoption replaced it — `near()` now
            # queries `location` directly, which gets its own GiST index
            # via `spatial_index=True` above, so this btree index is gone
            # rather than left behind as unused dead weight.
        ]

    def __str__(self):
        return f'{self.session_id} @ ({self.lat}, {self.lng})'


class DtBand(models.Model):
    """Editable coverage-band color/range definitions for the Drive-Test
    maps (Explore/Compare/single-session Coverage) — added 2026-08-05 per
    explicit user request ("add a feature to add, edit, delete index
    details/legend to display in map and changing color also"). Unlike
    every other model in this file, this one has NO v1 equivalent to stay
    field-compatible with — v1's bands (RSRP_BANDS/RXLEV_BANDS/etc.) are
    hardcoded JS constants in bts_monitor.html, never a DB-backed,
    user-editable feature there. This is a deliberate v2-only addition,
    confirmed with the user via AskUserQuestion (shared/server-saved
    storage, a dedicated admin page, superadmin-or-admin editable) rather
    than built silently.

    Rows are grouped by `metric_tag` — the same tag string the frontend
    already uses everywhere (`TaggedMetric.tag` in lib/dtBands.ts, e.g.
    "RSRP:4G", "RSCP:3G", "RxQual:2G") — one tag per editable table in the
    admin UI, 7 tags total matching `ALL_METRICS`. Deliberately keyed by
    the full tag rather than just the raw sample field (`rsrp`/`rsrq`/
    `sinr`/`ecno`/`rx_qual`): today RSRP:4G and RSCP:3G happen to share
    identical default bands (both reuse dtBands.ts's RSRP_BANDS), but an
    admin should be able to diverge them independently going forward
    (e.g. tighten RSCP's thresholds without touching RSRP's) rather than
    the two silently staying locked together.

    `sort_order` preserves display/matching order — `bandColor()`'s "first
    band whose [min,max) contains the value wins" logic depends on band
    order being meaningful, same as the hardcoded arrays in dtBands.ts
    (each ordered worst-to-best except RXQUAL_BANDS, which is inverted —
    the ordering itself is exactly what an admin is being given control
    over, so this app deliberately does not try to auto-sort by min/max).
    """
    metric_tag = models.CharField(max_length=32, db_index=True)
    label = models.CharField(max_length=40)
    min_value = models.FloatField()
    max_value = models.FloatField()
    color = models.CharField(max_length=9)  # '#rrggbb', matches dtBands.ts's Band.color
    sort_order = models.IntegerField(default=0)

    class Meta:
        db_table = 'v2_dt_bands'
        ordering = ['metric_tag', 'sort_order']

    def __str__(self):
        return f'{self.metric_tag}: {self.label}'


def menu_icon_upload_path(instance, filename):
    # UUID-based filename, not a fixed per-item slug — unlike
    # branding_logo_upload_path (a true singleton), MenuItem rows are
    # created/deleted freely, and a new item has no stable id to key a
    # path off of until AFTER its first save(). A random name sidesteps
    # that ordering problem entirely and also means replacing an item's
    # icon never collides with a previous upload still referenced by a
    # cached URL somewhere.
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else 'png'
    return f'menu_icons/{uuid.uuid4().hex}.{ext}'


class MenuItem(models.Model):
    """Superadmin-configurable top-nav entries (2026-08-08 request: "add
    feature to add, update, delete top menu with submenu feature also").
    Replaces the previously-hardcoded NavLink list in Layout.tsx — the 14
    entries that existed before this feature (Sites Topology, SLA, NTA,
    Monthly, Scatter, KPI Trend, RF Audit, DT Data Manager, Thresholds,
    Tree, Backup, Band Colors, Users, Permissions) are seeded into this
    table by migration 0010 with the exact same gating each one used to
    have hardcoded in JSX, so switching over doesn't change what any
    existing user currently sees.

    Visibility here is deliberately simpler than the granular per-action
    (read/write/update/delete) permission matrix that gates real data
    operations elsewhere (Sites/Tree/Thresholds/etc CRUD, see
    MenuPermission/CRUD_MENUS above) — a nav entry only ever needs a
    yes/no "can this role see this link," never a full CRUD shape. The
    first 4 ACCESS_CHOICES below are an exact enumeration of the 4
    different checks Layout.tsx used to hardcode per item (a 5th,
    ACCESS_RESCUE, was added later — see its own comment below):
      - ACCESS_ALL: unconditional (Sites Topology had no check at all)
      - ACCESS_PERMISSION: isAllowed(role, user.permissions[permission_key])
        — same MenuPermission-backed matrix every other simple menu key
        already resolves through (see MeSerializer.get_permissions /
        api/types.ts's isAllowed()). A brand new permission_key here is
        default-deny for admin/viewer (isAllowed returns False when no
        row exists) until a superadmin explicitly grants it a row via the
        Permissions page — same safe default every existing simple menu
        already has, and PermissionsPage.tsx lists these keys dynamically
        so a new one shows up there automatically.
      - ACCESS_ADMIN: role in (admin, superadmin) — matches the old
        `user.role === 'superadmin' || user.role === 'admin'` checks on
        Band Colors / Users.
      - ACCESS_SUPERADMIN: superadmin only — matches Permissions.

    Submenus support ARBITRARY depth (2026-08-08 follow-up — the sidebar
    rewrite's tree can indent as many levels as `parent` chains actually
    go, unlike the original top-nav dropdown this replaced, which could
    only ever show one level). The only structural rule enforced in
    MenuItemSerializer is "no cycles" (an item can't become its own
    ancestor, directly or transitively) — see `get_visible_menu_items()`
    in views.py, which also carries a defensive cycle-guard of its own in
    case bad data ever reaches it some other way (e.g. edited directly in
    Django admin, which doesn't go through the serializer).
    """
    ACCESS_ALL = 'all'
    ACCESS_PERMISSION = 'permission'
    ACCESS_ADMIN = 'admin'
    ACCESS_SUPERADMIN = 'superadmin'
    # ACCESS_RESCUE (2026-09-03) -- a 5th tier for the Rescue Lookup menu
    # item, mirroring core/rescue.py's IsRescueOperator permission class
    # exactly (role in ('rescue_operator', 'superadmin')) rather than
    # going through ACCESS_PERMISSION's generic default-deny matrix.
    # ACCESS_PERMISSION was deliberately NOT used here: that path is
    # granted per-role through PermissionsMatrixView/PermissionsPage.tsx,
    # which today only ever edits the 'admin'/'viewer' rows (see that
    # view's docstring) -- extending it to a 3rd editable role is a
    # bigger, separate change. Access to this tier is instead granted the
    # same way IsRescueOperator itself is: by a superadmin assigning a
    # user the 'rescue_operator' role at all (UsersPage.tsx), which is
    # already the "conscious grant" the rescue feature's own docs call for.
    ACCESS_RESCUE = 'rescue'
    ACCESS_CHOICES = [
        (ACCESS_ALL, 'Any signed-in user'),
        (ACCESS_PERMISSION, 'Governed by Permissions matrix'),
        (ACCESS_ADMIN, 'Admin + superadmin only'),
        (ACCESS_SUPERADMIN, 'Superadmin only'),
        (ACCESS_RESCUE, 'Rescue operator + superadmin only'),
    ]
    LINK_ROUTE = 'route'
    LINK_EXTERNAL = 'external'
    LINK_TYPE_CHOICES = [
        (LINK_ROUTE, 'Internal route'),
        (LINK_EXTERNAL, 'External URL'),
    ]

    label = models.CharField(max_length=100)
    link_type = models.CharField(max_length=10, choices=LINK_TYPE_CHOICES, default=LINK_ROUTE)
    # Internal route (e.g. '/sla') or a full external URL (e.g.
    # 'https://...') depending on link_type — validated in the serializer,
    # not here, so admin.py / shell usage isn't blocked by DRF-only checks.
    # unique=True (2026-08-?? via migration 0042_menuitem_path_unique) --
    # restored here after this field drifted out of sync with that
    # already-applied migration (found 2026-09-02 while checking for
    # drift before deploying rescue-policy/remote-optout: without this,
    # `makemigrations` would generate a migration that DROPS the unique
    # constraint the DB already enforces, not adds one).
    path = models.CharField(max_length=300, unique=True)
    parent = models.ForeignKey('self', null=True, blank=True, related_name='children', on_delete=models.CASCADE)
    order = models.IntegerField(default=0)
    access = models.CharField(max_length=12, choices=ACCESS_CHOICES, default=ACCESS_ALL)
    permission_key = models.CharField(max_length=50, blank=True, default='')
    is_active = models.BooleanField(default=True)
    # Sidebar + Dashboard (2026-08-08 follow-up: "left panel for menu and
    # submenu (icon display with detail on hover)... dashboard should be
    # like with some features... representing image"). `icon` is a single
    # emoji (not an icon-font class or image upload) — zero extra assets,
    # zero new CDN dependency, renders identically in the collapsed
    # sidebar rail, the hover flyout, and a Dashboard shortcut card.
    # `description` is the one-line detail shown on sidebar hover and on
    # a Dashboard shortcut card's body — optional, since not every item
    # needs one (falls back to just the label if blank).
    icon = models.CharField(max_length=8, blank=True, default='')
    description = models.CharField(max_length=200, blank=True, default='')
    # Uploaded icon image (2026-08-08, second follow-up: a user tried to
    # use a downloaded icon FILE and found there was no way to — `icon`
    # above only ever accepted a typed/pasted emoji). Optional and
    # additive, not a replacement: when set, it takes precedence over
    # `icon` everywhere an icon is rendered (sidebar rail, submenu rows,
    # Dashboard shortcut cards); when absent, everything falls back to
    # the emoji exactly as before. Same base64-JSON upload convention as
    # BrandingSettings.logo (see MenuItemSerializer / imageutils.py) —
    # deliberately NOT multipart/form-data.
    icon_image = models.ImageField(upload_to=menu_icon_upload_path, null=True, blank=True)

    class Meta:
        db_table = 'v2_menu_items'
        ordering = ['order', 'id']

    def __str__(self):
        return self.label


def branding_logo_upload_path(instance, filename):
    # Fixed filename per extension (not the uploaded filename verbatim,
    # and no per-upload uniqueness token) — there is only ever ONE logo
    # for the whole app (a singleton setting, not a per-user asset), so a
    # stable path is more useful than a growing pile of timestamped
    # files. BrandingSettingsView deletes the previous file before
    # assigning a new one, so this doesn't accumulate orphans either.
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else 'png'
    return f'branding/logo.{ext}'


class BrandingSettings(models.Model):
    """Singleton row (2026-08-08 follow-up: "also add feature to
    customize logo and name") holding the org-wide app name + logo shown
    in the sidebar brand block, the login page, and the browser tab icon.
    Same singleton convention as TreeSettings above (id forced to 1 in
    save()) — there is exactly one branding configuration for the whole
    app, not one per user.

    Both fields are optional/blank-able — absence means "use the
    built-in NTC default" (the real logo.jpg-derived `ntc-logo.jpg` still
    shipped as a static frontend asset, and the literal string
    "DT-WATCH BTS v2"), so a fresh install with nothing customized yet
    renders identically to how the app looked before this feature
    existed, rather than showing a broken image or blank title."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    app_name = models.CharField(max_length=100, blank=True, default='')
    logo = models.ImageField(upload_to=branding_logo_upload_path, null=True, blank=True)
    # Login-page text customization (2026-08-08, follow-up: "let
    # superadmin to customize the login interface texts also"). Each
    # blank-able, same fallback convention as app_name/logo — absence
    # means LoginPage.tsx uses its own hardcoded default string, so a
    # fresh install renders identically to how the login page looked
    # before this feature existed.
    login_subtitle = models.CharField(max_length=200, blank=True, default='')
    login_username_label = models.CharField(max_length=50, blank=True, default='')
    login_password_label = models.CharField(max_length=50, blank=True, default='')
    login_button_text = models.CharField(max_length=50, blank=True, default='')
    # Bottom disclaimer pill (2026-08-11 follow-up, added alongside the
    # bright-card login redesign) — same blank-means-default convention
    # as the four fields above. CharField (not TextField) to match the
    # short-line convention of the rest of the login text fields and
    # discourage someone pasting in a multi-paragraph notice that would
    # break the pill's single-line layout.
    login_disclaimer = models.CharField(max_length=200, blank=True, default='')
    # Inactivity auto-logout override, in minutes (2026-08-25 follow-up:
    # "session time for logout is very low, add a feature to customize
    # session time for logout"). Until now IDLE_TIMEOUT_MINUTES only came
    # from an env var (settings.py) — changing it meant an .env edit plus a
    # backend restart, no in-app control at all. NULL (the default) means
    # "no override, use the env var" — same blank/null-means-default
    # convention as every other field on this model — so a fresh install or
    # an install that never touches this setting behaves exactly as before.
    # 0 means auto-logout is disabled entirely, matching IDLE_TIMEOUT_MINUTES's
    # own 0-means-off convention. See BrandingSettingsView.get/put for how
    # this is merged with the env value and validated.
    idle_timeout_minutes = models.PositiveIntegerField(null=True, blank=True, default=None)

    class Meta:
        db_table = 'v2_branding_settings'

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.app_name or '(default branding)'


class LiveSiteSyncStatus(models.Model):
    """Singleton row (id forced to 1, same convention as BrandingSettings
    above) tracking the Live Site Directory sync's own run history — see
    core/live_sites.py's module docstring for what the sync itself does.

    Exists so the "Live Site Sync" admin page can show real status (last
    run, last success, last result, last error) WITHOUT the API URL/key
    themselves ever touching the database — those stay .env-only,
    confirmed via AskUserQuestion 2026-08-26 as the deliberate middle
    ground between "edit .env" and "store the credential in Postgres."

    Updated by every sync_live_sites() call regardless of what triggered
    it — the scheduled `site-sync` service's loop and the manual "Sync
    now" endpoint both write here, so this is always the most recent
    attempt from either source, not two separate histories."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    last_run_at = models.DateTimeField(null=True, blank=True)
    # Distinct from last_run_at so the page can show "last succeeded 3
    # days ago" even while today's runs have all been failing — collapsing
    # these into one field would hide exactly the information an admin
    # needs to notice the API's been down for days.
    last_success_at = models.DateTimeField(null=True, blank=True)
    last_created = models.PositiveIntegerField(null=True, blank=True)
    last_updated = models.PositiveIntegerField(null=True, blank=True)
    last_warnings = models.JSONField(null=True, blank=True)
    # Blank (not null) on a clean run — cleared on every SUCCESSFUL sync,
    # so a stale error from three attempts ago never lingers on-screen
    # once the underlying problem is actually fixed.
    last_error = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'v2_live_site_sync_status'

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return f'Live Site Sync status (last run {self.last_run_at})'


class DashboardCardConfig(models.Model):
    """Per-user saved layout for the new customizable Dashboard home page
    (2026-08-08: "dashboard display contents also should be customizable
    by individual user by themselves and save for later use"). Saved to
    the backend (not localStorage) per an explicit user decision — this
    app already syncs everything else (tree, permissions, sessions)
    across browsers/devices, and a per-browser-only layout would be the
    one inconsistent exception.

    Absence of any rows for a user means "use the catalog defaults" —
    see DashboardView's docstring in views.py for exactly how catalog
    cards and saved rows are merged at read time. A user who never
    touches "Customize" never gets a row here at all.

    `card_key` is a plain string, NOT a FK — see dashboard.py's
    CARD_CATALOG for the fixed set of stat cards ('stat-total-sites' etc)
    and the `menu-<MenuItem.id>` convention for shortcut cards. A stat
    card has no corresponding table row to point a FK at, so this has to
    be string-keyed either way; using the same shape for both card types
    keeps the merge logic in DashboardView uniform."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='dashboard_cards')
    card_key = models.CharField(max_length=64)
    order = models.IntegerField(default=0)
    visible = models.BooleanField(default=True)

    class Meta:
        db_table = 'v2_dashboard_card_config'
        ordering = ['order', 'id']
        constraints = [
            models.UniqueConstraint(fields=['user', 'card_key'], name='uniq_user_dashboard_card'),
        ]

    def __str__(self):
        return f'{self.user_id}/{self.card_key}'


class ApiKey(models.Model):
    """Credential for the external data-exchange API (2026-08-12, "add
    feature to create api to share certain data of system to other and to
    receive certain data from other system") — mounted separately at
    `/api/external/v1/` (core/external_api.py), NOT part of the JWT-
    authenticated `/api/v2/` surface the React app uses. See
    core/api_auth.py's module docstring for the full auth-design
    reasoning (header-based API keys chosen over OAuth2/JWT-reuse,
    confirmed via AskUserQuestion).

    Only a SHA-256 hash of the full key is ever stored — `key_hash` below
    — same one-way posture as this app already uses for user passwords
    (see User.password's docstring). `key_prefix` is the non-secret first
    few hex characters, stored in the clear purely so a key can be looked
    up and displayed/identified (e.g. "bw_a1b2c3d4...") without ever
    needing the full secret again. The full plaintext key is generated
    once at creation time (core/api_auth.py's `generate_api_key()`) and
    handed back in that single API response — it is NOT recoverable after
    that, matching how GitHub/Stripe-style API keys work.

    `scopes` is a flat list of strings from a fixed vocabulary
    (SCOPE_CHOICES below) rather than a full CRUD-menu-style permission
    matrix — an external system's access is "can read/write this one
    category of data," not a UI-navigation concept the way MenuPermission
    is for human users, so reusing that model would be a poor fit.
    """
    SCOPE_CHOICES = [
        ('sites:read', 'Sites & Sectors — read'),
        ('sites:write', 'Sites & Sectors — write'),
        ('dt:read', 'Drive Test sessions — read'),
        ('dt:write', 'Drive Test sessions — write'),
    ]

    name = models.CharField(max_length=100)
    key_prefix = models.CharField(max_length=16, unique=True, db_index=True)
    key_hash = models.CharField(max_length=64)
    scopes = models.JSONField(default=list)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='api_keys_created'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    # Optional — a blank/null value means "never expires". Superadmin sets
    # this at creation time only (not editable after, same immutability
    # posture as key_prefix/key_hash); a key that needs a new expiry gets
    # revoked and replaced, not edited, to keep the audit story simple.
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'v2_api_keys'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.name} ({self.key_prefix}…)'


# ── Crowdsourced network telemetry (2026-08-30) ────────────────────────
# The backend intake for the opt-in crowdsourced coverage pilot described
# in samples/nepal_telecom_network_planning_brief_2.docx — the second of
# the brief's "one platform, two intake paths" (the first being the .trp
# drive-test manager above). The Android side is the provided
# netplanning-telemetry-sdk; this is only the ingestion + storage +
# retention half. See core/telemetry.py for the endpoint and the brief's
# "Data governance" section for why retention is enforced in code here.


class TelemetryIngestKey(models.Model):
    """Auth credential for the telemetry ingestion endpoint. Deliberately
    a SEPARATE store from ApiKey (the partner-integration external API) —
    this is a high-volume, single-purpose, public-internet-facing ingest
    with its own rate limit; keeping it isolated means a compromised or
    throttled telemetry key can never touch the sites/DT data the ApiKey
    scopes gate, and vice versa (explicit scoping decision, 2026-08-30).

    Same one-way-hash posture as ApiKey / User.password: only a SHA-256
    hash of the full key is stored, plus a non-secret prefix for lookup.
    Full key (`tel_<hex>`) is shown once at creation and never again.
    """

    name = models.CharField(max_length=100)
    key_prefix = models.CharField(max_length=16, unique=True, db_index=True)
    key_hash = models.CharField(max_length=64)
    is_active = models.BooleanField(default=True)
    # Batches/minute this key may POST (the brief's "rate-limited"
    # requirement). Enforced in core/telemetry.py against the Django cache.
    rate_limit_per_min = models.PositiveIntegerField(default=600)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='telemetry_keys_created'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'v2_telemetry_ingest_keys'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.name} ({self.key_prefix}…)'


class TelemetryBatch(models.Model):
    """One accepted upload batch, keyed by a content hash — the idempotency
    ledger. The SDK's UploadWorker re-POSTs the exact same batch on any
    non-2xx (WorkManager retry), so matching that with a batch-level hash
    is both simpler and more correct than a per-sample unique constraint
    (which a RANGE-partitioned samples table can't express without the
    partition key, and that key — receipt time — differs on every retry).
    A duplicate POST is answered 2xx with accepted=0 and never re-inserts.
    Pruned alongside the samples."""

    batch_hash = models.CharField(max_length=64, unique=True)
    key_prefix = models.CharField(max_length=16, blank=True, default='')
    device_count = models.PositiveIntegerField(default=0)
    sample_count = models.PositiveIntegerField(default=0)
    received_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = 'v2_telemetry_batches'
        ordering = ['-received_at']

    def __str__(self):
        return f'{self.batch_hash[:12]}… ({self.sample_count} samples)'


class TelemetrySample(models.Model):
    """One crowdsourced network reading. Field set is exactly the SDK's
    Sample.kt (samples/…/model/Sample.kt) plus server-derived `region` /
    `received_at`. NOTHING that could resolve to a subscriber identity is
    accepted or stored — `device_id` is the SDK's pseudonymous UUID, and
    there is no IMEI / Android-ID / MSISDN column by design (the brief's
    one hard privacy rule).

    The DB table is RANGE-partitioned by `received_at` (monthly) — created
    that way in migration 0040 via SeparateDatabaseAndState, since Django
    can't emit `PARTITION BY`. Retention (prune_telemetry.py) aggregates
    whole expired partitions into TelemetryCoverageBin and DROPs them —
    instant, no VACUUM debt — the brief's "retention enforced
    automatically in the pipeline, not left to a policy someone has to
    remember to run"."""

    NETWORK_TYPES = [
        ('LTE', 'LTE'), ('NR', '5G NR'), ('UMTS', 'UMTS'), ('GSM', 'GSM'), ('UNKNOWN', 'Unknown'),
    ]
    TRIGGERS = [('periodic', 'Periodic'), ('handover', 'Handover'), ('manual', 'Manual')]

    device_id = models.CharField(max_length=64, db_index=True)
    ts = models.DateTimeField(db_index=True)              # device-reported time (from `ts` epoch ms)
    received_at = models.DateTimeField(db_index=True)     # server receipt — the partition key

    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)        # SDK sends `lon`; stored `lng` for app consistency
    location = PointField(geography=True, srid=4326, null=True, blank=True, spatial_index=True)
    gps_accuracy_m = SignalFloatField(null=True, blank=True)

    cell_id = models.BigIntegerField(null=True, blank=True)   # bigint: NR NCI is 36-bit
    pci = models.IntegerField(null=True, blank=True)
    tac = models.IntegerField(null=True, blank=True)
    mcc = models.CharField(max_length=6, blank=True, default='')
    mnc = models.CharField(max_length=6, blank=True, default='')
    network_type = models.CharField(max_length=12, choices=NETWORK_TYPES, default='UNKNOWN')

    rsrp_dbm = models.SmallIntegerField(null=True, blank=True)
    rsrq_db = models.SmallIntegerField(null=True, blank=True)
    rssi_dbm = models.SmallIntegerField(null=True, blank=True)   # GSM's "RxLevel" -- same dBm reading, different label
    sinr_db = models.SmallIntegerField(null=True, blank=True)
    # rx_qual/rscp_dbm/ecio_db (2026-09-03) -- proper RAN-standard metrics
    # for 2G/3G, since RSRP/RSRQ/SINR are LTE/NR-only and RSSI alone isn't
    # what a RAN engineer expects for those generations:
    #   - rx_qual: GSM RxQual class (TS 45.008/27.007 8.5, 0-7). SDK's
    #     CellSampleCollector.kt reads this from CellSignalStrengthGsm's
    #     bit-error-rate field (its "unknown" sentinel is 99, already
    #     filtered to null on-device).
    #   - rscp_dbm / ecio_db: WCDMA RSCP and Ec/Io. Only ever populated on
    #     devices running Android 10+ (API 29) -- the SDK sends null below
    #     that, same as any other unsupported-on-this-device field.
    rx_qual = models.SmallIntegerField(null=True, blank=True)
    rscp_dbm = models.SmallIntegerField(null=True, blank=True)
    ecio_db = models.SmallIntegerField(null=True, blank=True)
    battery_pct = models.SmallIntegerField(null=True, blank=True)
    trigger_reason = models.CharField(max_length=10, choices=TRIGGERS, default='periodic')

    # Derived server-side (nearest Site.region) so coverage queries can
    # filter/group by province without a spatial join every time; null
    # until the site directory is populated, backfillable later.
    region = models.CharField(max_length=100, blank=True, default='', db_index=True)

    objects = GeoSyncQuerySet.as_manager()

    class Meta:
        db_table = 'v2_telemetry_samples'
        indexes = [
            models.Index(fields=['device_id', 'ts']),
            models.Index(fields=['network_type']),
        ]

    def save(self, *args, **kwargs):
        # .save()/.create() path — the high-volume ingest uses COPY
        # (core/telemetry.py) which sets `location` in the stream itself,
        # and GeoSyncQuerySet covers bulk_create/bulk_update; this is for
        # everything else (tests, a backfill script, admin).
        self.location = _point_or_none(self.lat, self.lng)
        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.device_id[:8]}… @ {self.ts:%Y-%m-%d %H:%M} ({self.network_type})'


class TelemetryCoverageBin(models.Model):
    """Aggregated coverage stats for a ~150 m geohash-7 cell, per network
    type. Written by prune_telemetry.py when a raw-sample partition
    expires: the raw {position, signal} points are rolled up here (mean /
    p10 / min signal, sample & approx-device counts, time span) and then
    dropped. Kept indefinitely — the brief's "aggregate coverage
    statistics preferred over keeping every raw GPS point". Re-aggregation
    weight-merges into the existing row (unique on geohash + network_type)."""

    geohash = models.CharField(max_length=12, db_index=True)   # precision 7 ≈ 153 m
    network_type = models.CharField(max_length=12, default='UNKNOWN')
    # Added 2026-09-02 for operator-scoped coverage maps (User.operator_mncs).
    # Blank ('') on every bin rolled up before this field existed — that
    # historical data was merged across all operators together at
    # aggregation time and the raw per-operator rows are gone (retention
    # already dropped their partition), so it can never be split
    # retroactively. Bins rolled up from now on carry the reporting
    # devices' mnc (see prune_telemetry.py / roll_telemetry_bins.py), so a
    # scoped user's Coverage map fills in with real per-operator data going
    # forward; a blank-mnc historical bin simply won't match any scoped
    # user's filter (an unrestricted/NTA account still sees it via
    # TelemetryCoverageView's fallback network_type/region distincts).
    mnc = models.CharField(max_length=6, blank=True, default='')
    region = models.CharField(max_length=100, blank=True, default='', db_index=True)
    center_lat = models.FloatField(null=True, blank=True)
    center_lng = models.FloatField(null=True, blank=True)

    sample_count = models.BigIntegerField(default=0)
    device_count = models.PositiveIntegerField(default=0)     # approximate

    rsrp_mean = SignalFloatField(null=True, blank=True)
    rsrp_p10 = SignalFloatField(null=True, blank=True)
    rsrp_min = models.SmallIntegerField(null=True, blank=True)
    rsrq_mean = SignalFloatField(null=True, blank=True)
    sinr_mean = SignalFloatField(null=True, blank=True)

    first_ts = models.DateTimeField(null=True, blank=True)
    last_ts = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'v2_telemetry_coverage_bins'
        constraints = [
            # Widened 2026-09-02 to include mnc (was just geohash +
            # network_type) — see the `mnc` field's comment above.
            models.UniqueConstraint(fields=['geohash', 'network_type', 'mnc'], name='uniq_telemetry_bin_mnc'),
        ]

    def __str__(self):
        return f'{self.geohash} {self.network_type} (n={self.sample_count})'


# ── Rescue-location beacon (2026-09-01) ─────────────────────────────────
# The backend half of samples/nepal_flood_location_beacon_proposal.docx's
# Phase 1 opt-in beacon — a THIRD, deliberately separate lane alongside
# the two above (uploaded .trp drive-test files; anonymous crowdsourced
# coverage telemetry). This one links a phone number to a location, which
# the other two are explicitly designed to never do — see
# TelemetrySample's "no MSISDN column by design" and this section's
# models for how that boundary is kept structural, not just documented.
# See core/rescue.py for the enrollment/consent/lookup flow.


class SubscriberLastLocation(models.Model):
    """Opt-in "last known position" STATE for the rescue-location feature
    — one upserted row per device, not a history log. This is the "for a
    single user, store latest data only" half of the two-lane design (the
    other half stays TelemetrySample's append-only, anonymous, aggregate-
    then-drop pipeline for coverage/drive-test purposes). Bounded by
    enrolled-device count rather than event count, so it stays a small,
    cheap table even against millions of anonymous telemetry devices,
    because enrollment here is a separate, explicit opt-in
    (`rescue_consent`) from whatever consent gate the app uses for
    anonymous coverage sharing.

    `device_id` is the SAME salted hash `core.telemetry.hash_device_id()`
    produces for TelemetrySample.device_id — stable per installation,
    never reversible to the SDK's raw id. Linking a phone number here
    never grants the ability to de-anonymize the crowdsourced coverage
    stream; the (raw device_id -> msisdn) link only ever exists because
    one device sent both values at enrollment time (core/rescue.py's
    RescueEnrollView), over a channel entirely separate from the bulk
    ingest endpoint.

    Governance, per the proposal's non-negotiable list — enforced in
    code, not left as a comment: never queried by anything except
    core/rescue.py's RescueLookupView (IsRescueOperator, case-reference
    required, every call written to RescueLocationAccessLog); never
    joined against TelemetrySample; dropped entirely on consent
    withdrawal (see core/rescue.py's RescueConsentView).
    """

    SOURCE_CHOICES = [
        ('gps', 'GPS fix'),
        ('network', 'Network-based location'),
        ('cell', 'Serving-cell fallback (no fix)'),
    ]

    device_id = models.CharField(max_length=64, unique=True, db_index=True)
    # Nullable until the subscriber separately supplies a phone number —
    # enrollment (msisdn + consent) and location updates are two distinct
    # moments (core/rescue.py), so a consented device can have a fresh
    # position with no msisdn yet, but never an msisdn without consent.
    msisdn = models.CharField(max_length=20, null=True, blank=True, db_index=True)

    last_lat = models.FloatField(null=True, blank=True)
    last_lng = models.FloatField(null=True, blank=True)
    last_location = PointField(geography=True, srid=4326, null=True, blank=True, spatial_index=True)
    last_accuracy_m = SignalFloatField(null=True, blank=True)
    last_source = models.CharField(max_length=10, choices=SOURCE_CHOICES, default='gps')
    last_seen_ts = models.DateTimeField(null=True, blank=True, db_index=True)

    # Populated from the same in-batch sample used for last_lat/last_lng
    # (core/telemetry.py's _upsert_rescue_locations) — lets RescueLookupView
    # apply the same operator scoping (User.operator_mncs) as every other
    # telemetry endpoint, e.g. an NTC-scoped rescue operator only ever
    # finds NTC subscribers by MSISDN, while an NTA/government account
    # (empty operator_mncs) finds anyone regardless of operator.
    last_mnc = models.CharField(max_length=6, blank=True, default='')
    last_mcc = models.CharField(max_length=6, blank=True, default='')

    # Separate from ordinary telemetry-sharing consent by design (the
    # proposal's "opt-in by default, with a one-tap way to disable it" —
    # for the beacon specifically). Only rows with this True are ever
    # touched by the ingest pipeline's opportunistic upsert
    # (core/telemetry.py's `_upsert_rescue_locations`) or returned by
    # RescueLookupView.
    rescue_consent = models.BooleanField(default=False)
    rescue_consent_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.last_location = _point_or_none(self.last_lat, self.last_lng)
        super().save(*args, **kwargs)

    class Meta:
        db_table = 'v2_subscriber_last_location'
        indexes = [
            # Explicit name restored (2026-09-02, same drift-check pass as
            # MenuItem.path above) to match the name migration
            # 0043_rescue_and_dt_sessions actually gave this index in the
            # DB -- without it, `makemigrations` proposes a pointless
            # RenameIndex to Django's auto-generated name instead of
            # reporting "no changes."
            models.Index(fields=['rescue_consent', 'last_seen_ts'], name='v2_sll_consent_seen_idx'),
        ]

    def __str__(self):
        return f'{self.device_id[:8]}… ({self.msisdn or "no number"})'


class RescueLocationAccessLog(models.Model):
    """Audit trail — every RescueLookupView call, no exceptions, matching
    the proposal's "named legal and institutional owner... accountable
    for how the data is used." A lookup is logged whether or not it found
    anything, so this table also answers "did anyone search for this
    number" on its own, independent of SubscriberLastLocation's current
    contents."""

    looked_up_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='rescue_lookups'
    )
    msisdn_queried = models.CharField(max_length=20)
    case_reference = models.CharField(max_length=100)
    found = models.BooleanField(default=False)
    # Which RescueConsentPolicy mode was in effect for this lookup
    # (2026-09-02) — blank for every lookup logged before the policy
    # existed (implicitly 'mandatory', the only mode that ever existed
    # then). Lets an auditor later distinguish an ordinary lookup from one
    # that only found its match because a superadmin had 'optional' mode
    # active — see RescueConsentPolicy's docstring.
    policy_mode = models.CharField(max_length=10, blank=True, default='')
    queried_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = 'v2_rescue_access_log'
        ordering = ['-queried_at']

    def __str__(self):
        return f'{self.looked_up_by} -> {self.msisdn_queried} ({self.case_reference})'


# ── Superadmin-controlled rescue-consent policy (2026-09-02) ────────────
# The flood-beacon proposal's ordinary posture is strict opt-in with
# erase-on-withdrawal (RescueEnrollView's default behavior). But the real
# integration this is headed for is a carrier/government app with NO
# in-app consent screen at all -- the subscriber controls it via OS-level
# app permissions, and during an actual disaster they may never have
# taken any deliberate "I consent to rescue tracking" action. This gives
# a superadmin a single, audited, time-boxed switch to relax that
# requirement for the duration of a declared emergency, without ever
# being able to fabricate a phone-number link that was never established
# in the first place (see RescueConsentPolicy's docstring for the exact
# boundary of what "optional" does and does not unlock).

class RescueConsentPolicy(models.Model):
    """Singleton (pk=1). Controls two things, both normally gated on
    `rescue_consent=True`:

      * core/telemetry.py's `_upsert_rescue_locations` — which enrolled
        devices get their SubscriberLastLocation kept fresh from ongoing
        telemetry uploads;
      * core/rescue.py's `RescueLookupView` — which rows a lookup can
        match.

    'mandatory' (the default): both stay strictly `rescue_consent=True`
    only, and RescueEnrollView's `consent: false` deletes the row
    outright (erase-on-withdrawal) — the right posture for ordinary
    operation (routine drive-test/coverage-style use of this lane).

    'optional': an emergency override. Both checks above widen to "has a
    known msisdn on file" regardless of `rescue_consent`, and
    RescueEnrollView's `consent: false` becomes a SOFT withdrawal
    (`rescue_consent` set False, but the msisdn/location kept, not
    deleted) so a rescue operator can still find that subscriber while
    optional mode is active. This can NEVER produce a phone-number match
    for a device that has no SubscriberLastLocation row at all -- there
    is still no path from an anonymous TelemetrySample to an msisdn (see
    that model's "no MSISDN column by design"); optional mode only
    changes how strictly an EXISTING enrollment record's consent flag is
    enforced, it can never invent one.

    `active_until` auto-expires the effective override (see
    `is_optional_active`) even if nobody remembers to switch `mode` back
    — the stored `mode` can still say 'optional' after expiry, but
    enforcement treats it as mandatory again; the admin-facing API always
    reports the effective `is_optional_active` rather than the raw mode
    for exactly this reason. Every change is written to
    RescueConsentPolicyChangeLog — see that model.
    """
    MODE_MANDATORY = 'mandatory'
    MODE_OPTIONAL = 'optional'
    MODE_CHOICES = [
        (MODE_MANDATORY, 'Mandatory (default)'),
        (MODE_OPTIONAL, 'Optional (emergency override)'),
    ]

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    mode = models.CharField(max_length=10, choices=MODE_CHOICES, default=MODE_MANDATORY)
    reason = models.CharField(max_length=255, blank=True, default='')
    active_until = models.DateTimeField(null=True, blank=True)
    changed_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'v2_rescue_consent_policy'

    def is_optional_active(self):
        if self.mode != self.MODE_OPTIONAL:
            return False
        if self.active_until and timezone.now() > self.active_until:
            return False
        return True

    def __str__(self):
        return f'{self.mode} (until {self.active_until or "no expiry"})'


class RescueConsentPolicyChangeLog(models.Model):
    """Append-only audit trail for every RescueConsentPolicy change —
    same "no silent capability change" posture as RescueLocationAccessLog
    for lookups themselves. Never edited or deleted from the app (see
    core/admin.py); this is the record of who declared/ended an
    emergency override and why."""

    changed_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    mode = models.CharField(max_length=10)
    reason = models.CharField(max_length=255, blank=True, default='')
    active_until = models.DateTimeField(null=True, blank=True)
    changed_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = 'v2_rescue_consent_policy_log'
        ordering = ['-changed_at']

    def __str__(self):
        return f'{self.changed_by} -> {self.mode} @ {self.changed_at}'


# ── Continuous coverage-bin rollup (2026-09-01) ─────────────────────────

class TelemetryRollState(models.Model):
    """Singleton bookkeeping row (always pk=1) for
    core/management/commands/roll_telemetry_bins.py's incremental
    coverage-bin rollup — tracks the high-water mark of `received_at`
    already merged into TelemetryCoverageBin, so the frequent incremental
    roll and prune_telemetry.py's month-end aggregate-then-drop never
    double-count the same raw rows. See roll_telemetry_bins.py's module
    docstring for the full correctness argument. Created lazily on first
    run (get_or_create), not via a data migration."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    last_rolled_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'v2_telemetry_roll_state'

    def __str__(self):
        return f'watermark={self.last_rolled_at}'


# ── Scoped drive-test sessions over live telemetry (2026-09-01) ─────────

class TelemetryDriveTestSession(models.Model):
    """A scoped, consent-based window over the crowdsourced telemetry
    pipeline for real drive-test work — promotes the old superadmin-only
    "Live Samples" dev tool (TelemetryLiveSamplesView) into a first-class
    feature by making the scope explicit instead of implicit.

    Deliberately NOT the same thing as DriveTestSession/DriveTestSample
    higher up in this file (Phase 4a's uploaded-.trp-file manager) — this
    scopes LIVE crowdsourced-SDK uploads to an engineer-run session
    instead of a post-hoc file upload, and reusing that model would
    overload a very different write path (bulk file import vs. filtering
    the existing partitioned samples stream) for no benefit.

    Holds no FK to TelemetrySample — that table is large and RANGE-
    partitioned, so a session's samples are found by filtering it
    dynamically (device_id IN device_ids AND ts within
    [started_at, ended_at], optionally bounded by area), the same
    dynamic-query approach TelemetryCoverageView/TelemetryLiveSamplesView
    already use, not a join.

    What makes this promotable out of "superadmin dev tool" status: every
    device in `device_ids` is here because an engineer explicitly
    enrolled it for THIS session (a company/tester phone, not an
    anonymous member of the public crowdsourcing pool) — consent-scoped,
    not "any recent sample from anyone," which is exactly the distinction
    that kept the old endpoint dev-only in the first place.
    """

    STATUS_CHOICES = [('active', 'Active'), ('ended', 'Ended')]

    name = models.CharField(max_length=255)
    # Hashed device_id strings (core.telemetry.hash_device_id() output) —
    # a plain JSONField list rather than a related table since this is
    # always read/written whole, per session, and sessions have at most a
    # handful of devices.
    device_ids = models.JSONField(default=list)
    # Optional bounding box — when set, the samples endpoint further
    # filters to this area even for an enrolled device (e.g. a route
    # confined to one valley). Null bounds = device+time scope only.
    area_min_lat = models.FloatField(null=True, blank=True)
    area_max_lat = models.FloatField(null=True, blank=True)
    area_min_lng = models.FloatField(null=True, blank=True)
    area_max_lng = models.FloatField(null=True, blank=True)

    # Optional per-session gate (2026-09-02): when True, the samples
    # endpoint only returns data from devices that have separately opted
    # in via TelemetryDriveTestConsent. Set at creation — an admin's
    # deliberate choice "before drive-test coverage initiation" — and not
    # editable afterward through this API (no PATCH endpoint exists for
    # sessions at all). See TelemetryDriveTestConsent below for why this is
    # a distinct consent from rescue_consent and from the SDK's own
    # always-on telemetry opt-in.
    require_consent = models.BooleanField(default=False)

    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='active')
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='telemetry_dt_sessions'
    )

    class Meta:
        db_table = 'v2_telemetry_dt_sessions'
        ordering = ['-started_at']

    def __str__(self):
        return f'{self.name} ({self.status})'


# ── Optional per-device drive-test consent (2026-09-02) ─────────────────
# A FOURTH, purpose-limited consent lane, alongside rescue_consent
# (SubscriberLastLocation) and the SDK's own always-on telemetry opt-in
# (DeviceIdentity.optedIn on the client) — none of these imply each other.
# This one gates whether a device's ALREADY-collected samples are
# surfaced through a TelemetryDriveTestSession that an admin flagged
# `require_consent=True` at creation; it never affects whether the
# device's samples are ingested or stored at all — that stays controlled
# purely by the device's own telemetry opt-in, same as always.
#
# One standing per-device flag, not a separate grant per session: "do you
# consent to being included in consent-gated drive-test/coverage sessions
# in general," matching how the feature was actually requested (a
# device-level toggle, not a per-session prompt) and keeping the SDK-side
# API (NetTelemetry.setDriveTestConsent) as simple as rescue enrollment.

class TelemetryDriveTestConsent(models.Model):
    """Set via the SDK's `setDriveTestConsent()` call
    (core/consent.py's DriveTestConsentView) — the same ingest-key-
    authenticated, device-initiated pattern as rescue-enroll.
    `device_id` is the SAME salted hash `core.telemetry.hash_device_id()`
    produces for TelemetrySample.device_id / SubscriberLastLocation.
    device_id. Read ONLY by TelemetryDriveTestSessionSamplesView, and only
    for a session that opted into this gate."""

    device_id = models.CharField(max_length=64, unique=True, db_index=True)
    consent = models.BooleanField(default=False)
    consented_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'v2_telemetry_dt_consent'

    def __str__(self):
        return f'{self.device_id[:8]}… consent={self.consent}'


class DriveTestConsentConfig(models.Model):
    """Singleton (pk=1, same get_or_create pattern as RescueConsentPolicy/
    TelemetryRollState) holding the exact copy a host app can show a
    subscriber before calling `setDriveTestConsent()`. This does NOT make
    the SDK render any consent UI of its own — TelemetryConfig's docstring
    is explicit that it never will, matching the real integration
    scenario (a carrier/government app's OWN consent or permission
    screen). This exists purely so a deployment that WANTS to display
    fetched, centrally-editable copy (this project's own demo app does,
    for exactly this reason) doesn't have to bake that wording into an
    app build and ship a new release every time it changes. A deployment
    is equally free to hardcode its own copy and never call the
    device-facing GET endpoint at all.

    No separate change-log model here (contrast RescueConsentPolicy,
    which has RescueConsentPolicyChangeLog) — changing this affects only
    display wording, never who can be found, what's collected, or any
    other access/privacy consequence, so the heavier "no silent
    capability change" audit trail elsewhere in this codebase doesn't
    apply. `updated_by`/`updated_at` on the row itself is enough.
    """
    DEFAULT_MESSAGE = (
        "This app would like to include your device's network-quality "
        "readings in a drive-test coverage session. Nothing is shared "
        "unless you agree, and you can withdraw your consent at any time."
    )

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    message = models.TextField(default=DEFAULT_MESSAGE, blank=True)
    updated_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'v2_dt_consent_config'

    def __str__(self):
        return f'consent message ({len(self.message)} chars)'


# ── Remote opt-out request (2026-09-02) ──────────────────────────────────
# The general telemetry opt-in flag (the SDK's DeviceIdentity.optedIn)
# lives in EncryptedSharedPreferences ON THE DEVICE — nothing server-side
# can reach in and flip it directly. This is the "please opt out" REQUEST
# a superadmin/admin can leave for one device; the device applies it to
# itself, on its own next successful upload (see TelemetryIngestView's
# `opt_out` response field and the SDK's UploadWorker, which calls
# NetTelemetry.optOut() locally when it sees that flag). Most commonly
# created from ending a TelemetryDriveTestSession ("End & opt out enrolled
# devices" — core/telemetry_admin.py), but not tied to any one session.

class TelemetryRemoteOptOutRequest(models.Model):
    device_id = models.CharField(max_length=64, unique=True, db_index=True)
    requested_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    reason = models.CharField(max_length=255, blank=True, default='')
    # Set the moment the device's own next ingest upload reported the
    # opt_out flag back — a one-shot instruction, not a standing rule, so
    # a subscriber who opts back in later via optIn() isn't immediately
    # re-opted-out by a stale request.
    fulfilled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'v2_telemetry_remote_optout_request'

    def __str__(self):
        return f'{self.device_id[:8]}… {"fulfilled" if self.fulfilled_at else "pending"}'
