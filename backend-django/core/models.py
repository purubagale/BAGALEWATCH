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
from django.db import models


class User(AbstractUser):
    ROLE_CHOICES = [
        ('superadmin', 'Superadmin'),
        ('admin', 'Admin'),
        ('viewer', 'Viewer'),
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

    class Meta:
        db_table = 'v2_sites'
        indexes = [
            models.Index(fields=['region', 'district']),
        ]

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
    rsrp = models.FloatField(null=True, blank=True)
    rsrq = models.FloatField(null=True, blank=True)
    sinr = models.FloatField(null=True, blank=True)
    dl = models.FloatField(null=True, blank=True)
    pci = models.IntegerField(null=True, blank=True)
    serving_site_id = models.CharField(max_length=64, blank=True, null=True)
    serving_site_name = models.CharField(max_length=255, blank=True, null=True)
    serving_sector = models.CharField(max_length=20, blank=True, null=True)
    serving_cell_name = models.CharField(max_length=100, blank=True, null=True)
    serving_local_cell_id = models.IntegerField(null=True, blank=True)
    serving_dist_km = models.FloatField(null=True, blank=True)
    cell_role = models.CharField(max_length=10, choices=ROLE_CHOICES, blank=True, default='serving')
    rx_qual = models.FloatField(null=True, blank=True)
    bcch = models.IntegerField(null=True, blank=True)
    bsic = models.IntegerField(null=True, blank=True)
    rscp = models.FloatField(null=True, blank=True)
    ecno = models.FloatField(null=True, blank=True)
    scrambling_code = models.IntegerField(null=True, blank=True)

    class Meta:
        db_table = 'v2_dt_samples'
        indexes = [
            models.Index(fields=['session']),
            # 2026-08-10 perf audit finding — drive_test.py's `near` action
            # (Explore by Coordinates) does a bounding-box prefilter on
            # lat/lng "before the exact haversine check in Python", and
            # that method's own docstring already claims it's a "cheap
            # index range scan" — but no such index actually existed on
            # this table, so every one of those searches was really doing
            # a full sequential scan across every sample in every session
            # ever uploaded (this table is the single biggest one in the
            # app — a single upload batch can be 120,000+ rows). This
            # index is what makes that docstring's claim true. Plain
            # btree, not PostGIS (this stack deliberately has none, see
            # _haversine_km's own docstring) — Postgres uses it to narrow
            # to the lat range first, then filters the lng range and the
            # exact haversine distance against that much smaller row set.
            models.Index(fields=['lat', 'lng']),
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
    yes/no "can this role see this link," never a full CRUD shape. The 4
    ACCESS_CHOICES below are an exact enumeration of the 4 different
    checks Layout.tsx used to hardcode per item:
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
    ACCESS_CHOICES = [
        (ACCESS_ALL, 'Any signed-in user'),
        (ACCESS_PERMISSION, 'Governed by Permissions matrix'),
        (ACCESS_ADMIN, 'Admin + superadmin only'),
        (ACCESS_SUPERADMIN, 'Superadmin only'),
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
    path = models.CharField(max_length=300)
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
    "BAGALEWATCH BTS v2"), so a fresh install with nothing customized yet
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

    class Meta:
        db_table = 'v2_branding_settings'

    def save(self, *args, **kwargs):
        self.id = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.app_name or '(default branding)'


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
