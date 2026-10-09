// Mirrors core/serializers.py — kept in one place so a field rename on
// the Django side is a one-file fix here, not a hunt through components.

// 2026-10-01 ("full parity" RBAC feature) -- was a closed 4-value union.
// A superadmin can now create custom roles at runtime (Manage Roles), so
// a role name is a dynamic string, not a fixed literal set. Every
// existing `role === 'superadmin'`-style comparison across the app still
// compiles fine against `string`; nothing exhaustively switched over the
// old union.
export type Role = string
// The 4 roles every permission class / MenuItem access tier on the
// backend hardcodes by this exact literal -- kept here purely for
// frontend dropdowns/labels that want to distinguish a builtin tier from
// a custom role, NOT as a type (that stays the open `Role = string` above).
export const BUILTIN_ROLES: Role[] = ['superadmin', 'admin', 'viewer', 'rescue_operator']

export type CrudPerm = { read?: boolean; write?: boolean; update?: boolean; delete?: boolean }
/** How a user authenticates. `sso` means Keycloak owns their role and
 * re-applies it on every login, so editing it here would not stick. */
export type AuthSource = 'local' | 'sso'
/** GET /api/v2/health/ — public, and the only place the RUNNING backend's
 * build stamp is exposed. Mirrors core/views.py's health(). */
export interface HealthInfo {
  service: string
  status: string
  database: string
  database_error: string | null
  // Present only for authenticated callers (2026-08-23 security review) —
  // the endpoint is AllowAny for healthchecks, but an exact build tag plus
  // git SHA is not something to hand an anonymous visitor. AboutPage is
  // behind ProtectedRoute so it always gets these; anything unauthenticated
  // reading /health/ must treat them as absent.
  version?: string
  build_tag?: string
  git_sha?: string
}

export type PermissionValue = boolean | CrudPerm
export type PermissionMap = Record<string, PermissionValue>

export interface Me {
  id: number
  username: string
  role: Role
  // Full role list (2026-10-01, "full parity" RBAC feature) -- `role`
  // above is still the single cached highest-precedence value every
  // pre-existing check reads; `roles` is the real set, needed to show a
  // custom role (e.g. 'ftth_leader') a user holds alongside their builtin
  // tier. Always present (an empty array, never undefined).
  roles: string[]
  name: string
  dept: string
  // Used for password-reset lookup (2026-10-02, "forget password"
  // follow-up) -- optional, application-level-unique when set (see
  // UserWriteSerializer.validate() in core/serializers.py).
  email: string
  is_active: boolean
  last_login: string | null
  date_joined: string
  auth_source: AuthSource
  permissions: PermissionMap
}

export interface SiteListItem {
  id: string
  name: string
  region: string
  city: string
  district: string
  lat: number | null
  lng: number | null
  type: string
  // 2026-09-30 -- `type` above is dead (never populated by any import
  // path, confirmed 0 of 5,327 real sites); `tower_type` genuinely is
  // (from the LTE Engineering Parameter import). AdvancedSiteSearchModal's
  // "Tower Type" filter derives its dropdown from this, not `type`.
  tower_type: string
  tech: string
  status: string
  status_2g: string
  status_3g: string
  kpi_entered: boolean
  // Available tech types on this site (2026-08-10, "in site tree, also
  // display available tech type in site") — union of `tech` above and
  // every distinct Sector.tech recorded against this site (real 2G/3G
  // data lives almost entirely on sector rows, not this `tech` field —
  // see core/serializers.py's SiteListSerializer docstring). Sorted,
  // uppercased (e.g. ['2G', '3G', '4G']); empty array if neither the
  // site nor any of its sectors has a tech recorded.
  techs: string[]
  // Live Site Directory fields (2026-08-26 sync, exposed here 2026-09-07
  // for the Sites page Table/Map rebuild) — palika/ward_no are Nepal's
  // local-government tier below district; deployment_status is the
  // source system's own on-air/planned/etc state, a SEPARATE concept
  // from `status` above (this app's own KPI-health traffic light).
  palika: string
  ward_no: number | null
  deployment_status: string
}

// GET /api/v2/sites/?page=&page_size=&region=&district=&status=&technology=
// (2026-09-07) — DRF's stock PageNumberPagination envelope. Only returned
// when the caller passes `page` or `page_size` (see SiteViewSet.
// paginate_queryset()'s docstring) — omit both and /sites/ still returns
// the plain SiteListItem[] useSites() has always expected.
export interface SitesPageResponse {
  count: number
  next: string | null
  previous: string | null
  results: SiteListItem[]
}

export interface SitesPageParams {
  page?: number
  page_size?: number
  region?: string
  district?: string
  /** Site.deployment_status, exact match — see SiteViewSet.get_queryset(). */
  status?: string
  /** One or more technology values — a site must have ALL of them (AND, since 2026-09-10; see SiteViewSet.get_queryset()). Ignored when technologyOnly is set. */
  technology?: string[]
  /** One or more "X only" values — site's full tech set must equal EXACTLY this set (2026-09-10, extended same day to allow more than one: "2g only"+"4g only" matches a 2G+4G-only site). Mutually exclusive with `technology`. */
  technologyOnly?: string[]
  q?: string
}

// One entry of SectorSerializer.get_config_changes() (2026-09-23) --
// deliberately a distinct, slimmer shape from SectorConfigChange below
// (which is the full RfReportsPage antenna-change-log row, including
// raw_row/sn/site_id/etc. this direction doesn't need) -- see that
// serializer method's own docstring for why it's hand-built rather than
// reusing SectorConfigChangeSerializer as-is.
export interface SectorAntennaChange {
  id: number
  report: { id: number; lot_name: string }
  before_change: string
  after_change: string
  result: string
  antenna_type: string
  created_at: string
}

export interface Sector {
  id: number
  cell_name: string
  sector: string
  tech: string
  local_cell_id: number | null
  height: number | null
  azimuth: number | null
  mech_tilt: number | null
  elec_tilt: number | null
  // Antenna beam width (degrees) / coverage radius (meters) / real
  // transmit power (dBm) (2026-09-27, antenna wedge visualization) —
  // sourced from the vendor's KML engineering-parameter export
  // (beamwidth/radius only) and the WSD-shaped xlsx source (all three,
  // including the real "Maximum TX Power (dBm)" column), no fabricated
  // default when any is null (see core/models.py's Sector.beamwidth/
  // Sector.radius/Sector.max_tx_power_dbm docstring).
  beamwidth: number | null
  radius: number | null
  max_tx_power_dbm: number | null
  pci: number | null
  scrambling_code: number | null
  bcch: number | null
  bsic: number | null
  kpi_json: Record<string, unknown> | null
  kpi_date: string
  // Optional per-sector GPS override (2026-08-09, "sometimes same sites
  // with multiple sectors may have different lat long location as sector
  // expansion"). Checked v1 first — it has no per-sector coordinate at
  // all, every sector always inherited its site's single lat/lng; this is
  // a genuinely new capability. Both null (the common case) means "same
  // location as the parent site" — every reader must fall back to the
  // site's own lat/lng, never treat null as 0,0. See
  // core/models.py's Sector.lat/lng docstring.
  lat: number | null
  lng: number | null
  // Real columns from the user's own 3G/2G source files (2026-08-09,
  // "need to store all those data also") — plain free text, exactly as
  // uploaded/entered, never interpreted into a boolean or enum. See
  // core/models.py's Sector.carrier/site_band/cell_active_status/
  // site_existence docstring.
  carrier: string
  site_band: string
  cell_active_status: string
  site_existence: string
  // 2G/3G RF Database engineering parameters (2026-09-27) — see each
  // field's own comment in core/models.py, just after Sector.site_existence.
  // lac/ci/tch are text (identifiers/channel-list, never a single number);
  // the rest are 2G/3G-specific integers/floats, null when the imported
  // row's source (xlsx/KML/RF database) doesn't carry that field at all.
  lac: string
  ci: string
  ncc: number | null
  hsn: number | null
  tch: string
  total_trx: number | null
  activated_trx: number | null
  cs_traffic: number | null
  site_traffic: number | null
  dl_uarfcn: number | null
  // Vendor-imported antenna azimuth/tilt changes against this sector
  // (2026-09-23, "need to relate and manage vendor provided RNO report")
  // -- reverse of SectorConfigChange.sector, see SectorSerializer.get_config_changes()'s
  // own docstring in serializers.py for why this is a hand-built shape
  // rather than reusing SectorConfigChangeSerializer as-is.
  config_changes: SectorAntennaChange[]
}

export interface SiteDetail extends SiteListItem {
  // Live Site Directory field (2026-09-28) — on `SiteDetailSerializer`
  // only (that one uses `fields = '__all__'`, a real model column), NOT
  // on `SiteListSerializer`'s explicit field list — so this deliberately
  // lives on `SiteDetail` alone, not `SiteListItem`, unlike palika/
  // ward_no above which both serializers genuinely send. Getting this
  // distinction wrong is exactly what caused the `techs` crash on
  // /sites/KTM200 the same day — see SiteDetailSerializer's own comment
  // in serializers.py.
  palika_type: string
  kpi_date: string
  rrc: number | null
  erab: number | null
  call_setup: number | null
  call_drop: number | null
  svc_drop: number | null
  intra_ho: number | null
  inter_ho: number | null
  inter_rat: number | null
  ip_thru: number | null
  ip_thru_dl: number | null
  ip_thru_ul: number | null
  ip_lat: number | null
  prb: number | null
  prb_dl: number | null
  prb_ul: number | null
  bearer_util: number | null
  lic_util: number | null
  cell_avail: number | null
  volte_setup: number | null
  csfb: number | null
  rssi: number | null
  load: number | null
  // Real model fields (core/models.py) — always came back from the API
  // already (SiteDetailSerializer uses fields = '__all__'), just never
  // typed here or read by any UI until the Site Detail redesign
  // (2026-08-08, "beautiful gui for site details and sector details")
  // added the 3G/2G KPI tabs these gate the empty-state for.
  kpi_entered_2g: boolean
  kpi_entered_3g: boolean
  kpi_2g_json: Record<string, unknown> | null
  kpi_3g_json: Record<string, unknown> | null
  updated_at: string | null
  sectors: Sector[]
  // Tower/antenna engineering parameters (2026-09-26, "for 4G I found
  // more parameters with data for sectors that are also need to be
  // managed") -- see Site's own docstring in models.py. Plain text
  // throughout, same "carry the vendor's own value through unchanged"
  // convention as Sector.carrier/site_band.
  tower_type: string
  tower_height_m: string
  building_height: string
  tower_height_tssr: string
  antenna_device: string
  tower_remark: string
}

// ── Phase 2: write payload shapes ───────────────────────────────────────
// These mirror SiteWriteSerializer/UserWriteSerializer exactly (see
// core/serializers.py) — a PUT is NOT a partial patch for sites (matches
// v1's _upsert_site: omitted optional fields clear to null/blank), so
// the form always sends the complete SiteDetail-shaped object back.

// 'config_changes' excluded too (2026-09-23) — a read-only reverse
// relation (SectorSerializer.get_config_changes()), never something a
// site/sector edit writes.
export type SectorWrite = Omit<Sector, 'id' | 'config_changes'>

export type SiteWrite = Omit<SiteDetail, 'sectors' | 'updated_at'> & {
  sectors: SectorWrite[]
}

export interface KpiThreshold {
  warn: number | null
  crit: number | null
  hi: boolean
  max: number | null
  unit: string
}

export type ThresholdMap = Record<string, KpiThreshold>

// Editable DT coverage-band colors/ranges (2026-08-05, v2-only — no v1
// equivalent, see core/models.py's DtBand docstring). Keyed by the same
// metric TAG string lib/dtBands.ts already uses everywhere (e.g.
// "RSRP:4G", "RSCP:3G") — one array of bands per tag, in display/match
// order (bandColor() picks the first band whose [min,max) contains the
// value).
export interface DtBandRow {
  label: string
  min: number
  max: number
  color: string
}
export type DtBandsMap = Record<string, DtBandRow[]>

// Arbitrary-depth folder tree (redesigned 2026-07-27, user-confirmed,
// beyond v1 parity — v1's own tree is a fixed 2-level folder/subfolder
// split; see core/models.py's TreeFolder docstring on the Django side).
// `children` recurses to whatever depth actually exists.
export interface TreeFolder {
  id: string
  name: string
  icon: string
  lat: number | null
  lng: number | null
  children: TreeFolder[]
}

// site_id -> the single folder (at any depth) it's assigned to, or null.
export type TreeAssignments = Record<string, string | null>

export interface TreeState {
  folders: TreeFolder[]
  assignments: TreeAssignments
  active: boolean
}

// Backup & Restore — Complete Project (2026-08-05), ported from v1's
// "Backup & Restore" modal (bts_monitor.html ~1581-1700). The export
// payload is deliberately built from the SAME shapes this app already
// uses elsewhere (SiteDetail, TreeState, ThresholdMap, DtBandsMap) —
// see core/backup.py's module docstring — rather than a separate,
// parallel export format.
export interface BackupSummary {
  sites: number
  sectors: number
  sites_with_kpi: number
  tree_custom: boolean
  thresholds_count: number
  dt_bands_count: number
}

export interface BackupExportPayload {
  _type: string
  _version: number
  _created: string
  _app: string
  meta: { sitesCount: number; sectorsCount: number; kpiCount: number; exportedBy: string }
  sites: SiteDetail[]
  tree: TreeState
  thresholds: ThresholdMap
  dt_bands: DtBandsMap
}

// v1 has a 4th restore checkbox, "Data Source Config" — no v2 concept to
// restore, so it's dropped; dt_bands (v2-only) takes its slot instead.
export interface BackupRestoreFlags {
  sites: boolean
  tree: boolean
  thresholds: boolean
  dt_bands: boolean
}

export interface BackupImportResult {
  ok: true
  restored: string[]
}

// Reset-for-live-sync (2026-09-10) -- the UI counterpart of
// `manage.py clear_sites --confirm` (core/backup.py's
// SiteDataResetView). Erases Site/Sector/KPI-snapshot/tree-assignment
// data only; Live Site Directory source config is left untouched on
// purpose, so a sync afterward repopulates everything cleanly.
export interface SiteResetResult {
  ok: true
  deleted: {
    sites: number
    sectors: number
    kpi_snapshots: number
    tree_assignments: number
  }
}

// Sector import (2026-08-05, updated 2026-08-26) — see core/
// site_import.py's module docstring. `kind: 'sectors'` is a 3-way
// contract: add a missing sector, UPDATE an existing sector if the row's
// values genuinely differ (else left alone, counted in `skipped`), and
// (2026-08-26) SKIP a row whose site doesn't exist rather than
// auto-creating it — site identity now comes only from the Live Site
// Directory sync (core/live_sites.py), never from this upload.
export interface SectorImportResult {
  added: number
  updated: number
  skipped: number
  errors: string[]
}

// KPI import (2026-08-26) — replaced the old identity-only `kind:
// 'sites'` import, which is gone now that sites are Live Site Directory-
// managed (see core/site_import.py's module docstring). Update-only,
// matched by Site ID: a row naming a site that doesn't exist is reported
// in `errors`, never used to create one.
export interface KpiImportResult {
  updated: number
  skipped: number
  errors: string[]
}

// `kind: 'engineering_params'` import (2026-09-26) -- see
// ImportSitesView._apply_engineering_params()'s docstring in
// site_import.py. Plain data sync matched by Cell Name, writing to both
// Sector (pci/azimuth/mech_tilt/elec_tilt/carrier/site_band) and that
// sector's Site (tower_type/tower_height_m/building_height/
// tower_height_tssr/antenna_device/tower_remark) -- explicitly not a
// diff/audit-log system ("do not import snapshot, import data only").
export interface EngineeringParamImportResult {
  sectors_updated: number
  sites_updated: number
  skipped: number
  errors: string[]
}

export interface AdminUser {
  id: number
  username: string
  role: Role
  // Full role list (2026-10-01) -- see Me.roles' own comment above, same
  // convention.
  roles: string[]
  name: string
  dept: string
  // Used for password-reset lookup (2026-10-02, "forget password"
  // follow-up) -- optional, application-level-unique when set (see
  // UserWriteSerializer.validate() in core/serializers.py).
  email: string
  is_active: boolean
  last_login: string | null
  date_joined: string
  auth_source: AuthSource
  // Operator-scoped data access (2026-09-02) — empty list means
  // unrestricted (NTA/government/superadmin); a non-empty list of MNC
  // codes (e.g. ["02"]) restricts telemetry/coverage/rescue-lookup
  // results to those operators only. See User.operator_mncs' docstring
  // (core/models.py) and core/telemetry.py's _scope_by_operator().
  operator_mncs: string[]
}

export interface UserWrite {
  username: string
  password?: string
  role: Role
  name: string
  dept: string
  email?: string
  is_active?: boolean
  operator_mncs?: string[]
}

// ── Multi-role RBAC (2026-10-01, "full parity" RBAC feature) ────────────
// Mirrors core/serializers.py's RoleSerializer / core/roles.py's
// UserRolesView exactly.
export interface RoleRow {
  id: number
  name: string
  label: string
  description: string
  is_builtin: boolean
  created_at: string
}
export interface RoleWrite {
  name: string
  label: string
  description?: string
}
/** GET/PUT /api/v2/users/:id/roles/ response shape — a flat list, not
 * just names, so AssignRolesPage can show each role's label without a
 * second lookup against useRoles(). */
export interface UserRoleRow {
  id: number
  name: string
  label: string
}
/** GET/PUT /api/v2/menu-visibility/ — sparse: a menu item id with no key
 * here, or a role name missing within one, means "inherit the default"
 * (see MenuItemRoleVisibilityView's own docstring, core/views.py). PUT
 * sends the same shape back with a changed/added entry, or `null` for a
 * value to delete that override and reset to inherited. */
export type MenuVisibilityMatrix = Record<string, Record<string, boolean>>

/** GET /api/v2/system-health/ (2026-10-01) — superadmin-only diagnostic
 * dashboard. `disk` is null (with `disk_error` set) only if the
 * `shutil.disk_usage()` call itself raised, which in practice should never
 * happen under a real deployment — see SystemHealthView's docstring
 * (core/views.py) for why Live Site Sync's own per-source state is NOT
 * part of this shape (SystemHealthPage.tsx calls useLiveSiteSources()
 * directly instead, to avoid a second source of truth for it). */
/** GET /api/v2/system-doc/ (2026-10-01) -- "Generate Current System
 * State" button on DocumentationPage.tsx. Same {markdown, meta} shape as
 * MonthlyReport -- generated fresh server-side on every request, by
 * introspecting the live model registry/menu tree/roles, not bundled at
 * build time like the rest of that page's docs. */
export interface SystemDocResponse {
  markdown: string
  meta: {
    generated_at: string
    version: string
    build_tag: string
    git_sha: string
  }
}

export interface SystemHealthPayload {
  database: { status: 'ok' | 'down'; error: string | null }
  redis: { status: 'ok' | 'down'; error: string | null }
  disk: { total_bytes: number; used_bytes: number; free_bytes: number } | null
  disk_error: string | null
  telemetry_bin_roller: { last_rolled_at: string | null }
  version: string
  build_tag: string
  git_sha: string
  checked_at: string
}

// ── Phase 3: reporting suite (read-only) ────────────────────────────────
// Mirrors core/reports.py exactly — see that file's docstrings for the
// bts_monitor.html line ranges each of these ports.

export interface SlaTarget {
  key: string
  label: string
  unit: string
  target: number
  op: 'gte' | 'lte'
  weight: number
}

export interface SlaKpiResult extends SlaTarget {
  value: number | null
  pass: boolean | null
}

export interface SlaSiteRow {
  id: string
  name: string
  region: string
  score: number | null
  kpi_results: SlaKpiResult[]
}

export interface SlaReport {
  targets: SlaTarget[]
  summary: {
    total: number
    compliant: number
    partial: number
    breach: number
    nodata: number
    avg_score: number | null
  }
  sites: SlaSiteRow[]
}

export interface NtaThreshold {
  key: string
  label: string
  min: number | null
  max: number | null
  unit: string
  hi: boolean
  cat: string
  penalty: string
}

export type NtaStatus = 'pass' | 'warn' | 'fail'

export interface NtaCell {
  key: string
  status: NtaStatus
  value: number | null
}

export interface NtaSiteRow {
  id: string
  name: string
  region: string
  cells: NtaCell[]
  overall: NtaStatus
}

export interface NtaReport {
  thresholds: NtaThreshold[]
  summary: { compliant: number; warning: number; violation: number; rate: number }
  sites: NtaSiteRow[]
}

export interface MonthlyReport {
  markdown: string
  meta: { site_count: number; region: string; month_name: string }
}

// GET /api/v2/scatter/ — see ScatterPlotPage.tsx for the client-side
// canvas rendering (regression/correlation/tooltip), ported from v1's
// renderScatterPlot() (bts_monitor.html ~12809-12921). The server only
// hands over raw per-site KPI values (SiteScatterSerializer), same split
// as v1: the chart math lives wherever v1's did, on the client.
export type ScatterKpiKey =
  | 'rrc' | 'call_drop' | 'intra_ho' | 'ip_thru' | 'ip_lat' | 'prb'
  | 'cell_avail' | 'rssi' | 'load' | 'erab' | 'bearer_util' | 'lic_util'

export interface ScatterKpi {
  key: ScatterKpiKey
  label: string
}

export interface ScatterSite {
  id: string
  name: string
  region: string
  status: string
  rrc: number | null
  erab: number | null
  call_drop: number | null
  intra_ho: number | null
  ip_thru: number | null
  ip_lat: number | null
  prb: number | null
  cell_avail: number | null
  rssi: number | null
  load: number | null
  bearer_util: number | null
  lic_util: number | null
}

export interface ScatterData {
  kpis: ScatterKpi[]
  region_colors: Record<string, string>
  sites: ScatterSite[]
}

// GET /api/v2/kpi-trend/?site=&days= — mirrors core/kpi_trend.py exactly.
// `has_enough_data` is the load-bearing field here: per the 2026-07-28
// "never fabricate data" decision, the server returns an empty `series`
// with `has_enough_data: false` instead of ever synthesizing a fallback
// trend the way v1's buildSimulatedHistory() does — the UI must render a
// "not enough data yet" state for that case, not silently show nothing.
export type TrendCategory = 'overview' | 'accessibility' | 'retainability' | 'mobility' | 'integrity' | 'utilization'

export interface TrendKpi {
  key: string
  label: string
}

export interface TrendSnapshotRow {
  date: string
  [kpiKey: string]: string | number | null
}

export interface KpiTrend {
  site: { id: string; name: string }
  categories: Record<TrendCategory, TrendKpi[]>
  days: number
  has_enough_data: boolean
  snapshot_count: number
  min_required: number
  series: TrendSnapshotRow[]
}

// GET /api/v2/rf-audit/data/?site= — mirrors core/rf_audit.py exactly.
// Checklist items, measurement RAG thresholds, VSWR/PIM evaluation, and
// antenna/feeder config fields are NOT here — they're fixed reference
// data / pure client-side arithmetic with no DB dependency, ported
// straight into RfAuditPage.tsx, matching where v1 keeps them too. Only
// what needs real Site/Sector data (KPI findings/score, per-sector KPI
// comparison) comes from the server.
export interface RfAuditKpiField {
  key: string
  label: string
  ok: number
  crit: number
  hi: boolean
}

export interface RfAuditFinding {
  sev: 'CRITICAL' | 'MAJOR'
  cat: string
  title: string
  detail: string
  action: string
  note: string
}

export interface RfAuditKpiProblem {
  sev: 'CRIT' | 'WARN'
  key: string
  label: string
  value: number
}

export interface RfAuditSectorValue {
  value: number | null
  // 'sector' = this sector has its own real kpi_json entry for this KPI.
  // 'site'   = no per-sector entry, showing the site's own real
  //            aggregate value instead — labeled as such in the UI, never
  //            an invented number (see rf_audit.py's module docstring on
  //            why this replaced v1's Math.random()-fabricated sectors).
  source: 'sector' | 'site' | null
}

export interface RfAuditSectorRow {
  id: number
  cell_name: string
  sector: string
  pci: number | null
  azimuth: number | null
  mech_tilt: number | null
  elec_tilt: number | null
  values: Record<string, RfAuditSectorValue>
}

export interface RfAuditData {
  site: {
    id: string; name: string; region: string; type: string; tech: string
    status: string; lat: number | null; lng: number | null
  }
  kpi_findings: RfAuditFinding[]
  kpi_score: number
  kpi_problems: RfAuditKpiProblem[]
  kpi_fields: RfAuditKpiField[]
  sector_fields: string[]
  sectors: RfAuditSectorRow[]
}

// GET/POST/DELETE /api/v2/rf-audit/history/ — matches v1's saved audit
// reports (bagalewatch_api.py's audit_history table), admin+ only both
// ways (see AuditHistoryListView's docstring on the Django side).
export interface AuditHistoryEntry {
  id: number
  site: string | null
  site_name: string
  content: string
  score: number | null
  created_at: string
  created_by_name: string | null
}

export interface AuditHistoryCreate {
  site?: string
  site_name?: string
  content: string
  score?: number | null
}

// ── Drive-Test Data Manager (Phase 4) ───────────────────────────────────
// Mirrors core/drive_test.py's serializers exactly. See
// DriveTestSession's docstring in the Django models.py for the full
// scope note: TRP/GPX parsing stays client-side for now (this phase's
// upload path is the CSV/XLSX template only — lib/dtTemplateParser.ts —
// not the .trp binary decoder, which is its own dedicated follow-up).
export type DtTech = '4G' | '3G' | '2G'
export type DtCellRole = 'serving' | 'neighbor'

export interface DtSample {
  ts: string
  date: string
  lat: number | null
  lng: number | null
  rsrp: number | null
  rsrq: number | null
  sinr: number | null
  dl: number | null
  pci: number | null
  // LTE band the serving cell was on (e.g. "3", "20") -- see
  // DriveTestSample.band's docstring in models.py. Blank ('') for any
  // sample saved before this field existed, or where trpAnalysis.ts
  // never decoded a band value in the first place.
  band?: string | null
  // LTE-only 3GPP Channel Quality Indicator, 0-15, higher is better --
  // see DriveTestSample.cqi's docstring in models.py.
  cqi: number | null
  // Serving-cell attribution (dt_serving_cell.py). `serving_site_id` +
  // `serving_dist_km` come back on the plot fetch and drive the coverage
  // map's hover connector (see useDtServingCells / DtCoverageMap). The
  // other three are stored but not in the lean plot serializer — the
  // per-session /serving-cells/ lookup carries cell_name/sector/azimuth
  // instead. Optional because a session uploaded before this feature (or
  // with no site directory loaded) has them null/absent.
  serving_site_id?: string | null
  serving_site_name: string | null
  serving_sector?: string | null
  serving_cell_name?: string | null
  serving_local_cell_id?: number | null
  serving_dist_km?: number | null
  cell_role?: DtCellRole
  rx_qual: number | null
  bcch: number | null
  bsic: number | null
  rscp: number | null
  ecno: number | null
  scrambling_code: number | null
}

// Compound events decoded from a .trp file's Call.*/Data.*/Location.*
// namespaces (2026-08-14, "detect and store separately but relating to
// session as particular events for which the log is taken like fallback
// events from fallback log, download success event from DL log etc") —
// mirrors lib/trpAnalysis.ts's TrpaEventRow exactly. Kept as a type for
// reuse (e.g. a future diagnostic view), but per a same-day follow-up
// ("i need to store only the data like total no. of call attempted...")
// the raw per-event list is no longer what gets written into
// DtSessionMeta — see DtCallSummary/DtDownloadSummary below, which is
// what actually gets stored. `sourceFile` ties an event back to which
// uploaded .trp file it came from.
export interface DtSessionEvent {
  ts: string
  type: string
  sourceFile: string
  lat: number | null
  lng: number | null
  fields: Record<string, string | number>
}

// Aggregate call/download KPI counts derived from the events above
// (2026-08-15, replacing the raw per-event table per the user's explicit
// "store only the data like total no. of call attempted, total call
// success, total call drop, total call rejected, percentage... for 4g dl,
// total download attempted/succeed/fail... for 4g fallback, total call
// attempted, total no. of fallback, success, fail" ask). Mirrors
// lib/trpAnalysis.ts's DtCallSummary/DtDownloadSummary exactly — see that
// module's own comment for exactly how "success"/"drop"/"rejected" are
// derived from real TEMS event structure (never from guessed numeric
// Cause/EndType code meanings, which have no public documentation).
export interface DtCallSummary {
  attempted: number
  setupSuccess: number
  rejected: number
  completed: number
  dropped: number
  fallbackDetected: number
  setupSuccessRatePct: number | null
  rejectRatePct: number | null
  dropRatePct: number | null
}

export interface DtDownloadSummary {
  attempted: number
  succeeded: number
  failed: number
  successRatePct: number | null
}

// Meta is an unnormalized JSON blob (matches v1's meta_json exactly) —
// only the keys this phase's UI actually reads are typed; anything else
// v1 might have stored (e.g. a future session's siteId/siteDistKm from
// nearest-site matching) still round-trips fine as extra untyped keys.
export interface DtSessionMeta {
  gpsCount?: number
  fileNames?: string[]
  routeKm?: string
  duration?: string
  startTime?: string
  endTime?: string
  city?: string
  region?: string
  avgRsrp?: number | null
  siteName?: string
  siteDistKm?: number
  // ~1km nearby-site tagging (2026-07-30) — every Site id within 1km of
  // ANY sample in this session, computed server-side at upload time by
  // DriveTestSessionWriteSerializer.create() (serializers.py's
  // _nearby_site_ids), and backfilled for older sessions by the
  // backfill_nearby_sites management command. Plural counterpart to the
  // single siteName/siteDistKm nearest-match above. Absent (undefined)
  // only for sessions from before this feature shipped and not yet
  // backfilled; an empty array means "computed, nothing found nearby".
  nearby_site_ids?: string[]
  // TEMS-native compound events extracted from the .trp file(s) this
  // session was built from (see DtSessionEvent above) — kept as an
  // optional field for backward-compat/future reuse, but no longer
  // written by the .trp upload flow (see callSummary/downloadSummary
  // below, which replaced this as of the 2026-08-15 follow-up).
  events?: DtSessionEvent[]
  // Aggregate call-outcome counts (see DtCallSummary above) — present
  // only when this session's source .trp file(s) contained at least one
  // Call.* event (a voice/CSFB-fallback-type capture). Absent for a
  // pure-data (4G DL) capture or a CSV/XLSX template upload.
  callSummary?: DtCallSummary
  // Aggregate download-outcome counts (see DtDownloadSummary above) —
  // present only when the source file(s) contained at least one
  // Data.Ftp.Download.Begin/EndEvent. Absent for a voice-only capture or
  // a CSV/XLSX template upload.
  downloadSummary?: DtDownloadSummary
  // Auto-detected NTC test type ('DL' | 'Fallback' | 'Voice' | 'Mixed') —
  // see DtUploadPage.tsx's detectTrpTestType (2026-08-15, "make it
  // identifiable... during session save": two real 4G .trp sessions from
  // the same date/district previously landed with the exact same
  // auto-generated name and no way to tell them apart). Also folded into
  // the auto-generated session name itself, so this field is mostly for
  // any future filtering/badge use — the name alone already carries it.
  testType?: string
  [key: string]: unknown
}

export interface DtSessionListItem {
  id: number
  name: string
  tech: DtTech
  date: string | null
  uploaded_date: string | null
  saved_at: string
  uploaded_by_name: string | null
  meta: DtSessionMeta | null
  size_bytes: number | null
  sample_count: number
  remarks: string
  // Drive "mode" this session was run in -- Free Mode, a band-lock
  // (B3/B20/...), Idle vs an active DL/UL session, etc. (2026-09-23) --
  // see DriveTestSession.mode's docstring in models.py. Blank ('') means
  // not set, same convention as `remarks`/`name` on an older session.
  mode: string
  attachment_count: number
  activities: DtSessionActivityTag[]
}

// Optimization Activities (2026-09-12) -- see OptimizationActivity's
// docstring in core/models.py for the before/after-change/re-verify
// grouping workflow this supports. `role` matches
// OptimizationActivitySession.ROLE_CHOICES on the backend exactly.
export type OptimizationActivityRole = 'baseline' | 'after_change' | 're_verify'

// One entry of DriveTestSessionListSerializer.get_activities() -- which
// activity/activities a session belongs to, embedded directly on each
// DtSessionListItem/DtSessionDetail row so History doesn't need a
// second per-row fetch to show it.
export interface DtSessionActivityTag {
  id: number
  name: string
  role: OptimizationActivityRole
}

// One linked session inside OptimizationActivitySerializer.get_sessions()
// -- richer than DtSessionActivityTag above (session name/tech/date +
// the per-link note), and keyed by `link_id` (the join row's own id,
// needed for DELETE .../sessions/<link_id>/) rather than the activity id.
export interface OptimizationActivitySessionLink {
  link_id: number
  session_id: number
  session_name: string
  tech: DtTech
  date: string | null
  role: OptimizationActivityRole
  note: string
}

// One entry of OptimizationActivitySerializer.get_resolved_issues() --
// the Issue-mediated trace back to a vendor report (only ever populated
// for a RECOMMENDATION-derived Issue; see OptimizationActivity.source_report's
// own docstring in models.py for the more common change-log path, which
// this type's sibling fields below (source_report/antenna_changes) cover
// instead).
export interface OptimizationActivityResolvedIssue {
  id: number
  title: string
  source_report: { id: number; lot_name: string } | null
}

// GET/POST /api/v2/dt-activities/ item shape (OptimizationActivitySerializer).
export interface OptimizationActivity {
  id: number
  name: string
  notes: string
  created_by: string | null
  created_at: string
  updated_at: string
  sessions: OptimizationActivitySessionLink[]
  resolved_issues: OptimizationActivityResolvedIssue[]
  // Direct vendor-report link (2026-09-23), managed via link_report() --
  // see OptimizationActivity.source_report/antenna_changes' own
  // docstrings in models.py for why this is separate from
  // resolved_issues above.
  source_report: { id: number; lot_name: string; network: string } | null
  antenna_changes: SectorConfigChange[]
}

// POST /api/v2/dt-activities/ request body. `resolve_issue_id` (2026-09-14,
// optional) picks an existing Issue this activity resolves -- the
// backend (OptimizationActivitySerializer.create()) sets that issue's
// resolved_by_activity to the new activity and moves its status to
// 'resolved' as a side effect. Create-only, matching
// OptimizationActivityViewSet having no update/partial_update at all.
export interface OptimizationActivityWrite {
  name: string
  notes?: string
  resolve_issue_id?: number | null
}

// POST /api/v2/dt-activities/<id>/sessions/ request body
// (OptimizationActivitySessionSerializer's write shape).
export interface OptimizationActivityAttach {
  session: number
  role: OptimizationActivityRole
  note?: string
}

// Site/Sector Issue tracker (2026-09-14) -- see Issue's docstring in
// core/models.py for the full workflow. `status`/`severity` match
// Issue.STATUS_CHOICES/SEVERITY_CHOICES on the backend exactly.
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed'
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical'

// A resolved issue's link back to the OptimizationActivity that fixed
// it (IssueSerializer.get_resolved_by_activity_name) -- null until an
// activity is created/edited with this issue picked as the one it
// resolves (see OptimizationActivityWrite.resolve_issue_id below).
export interface IssueResolvedByActivity {
  id: number
  name: string
}

// GET/POST/PATCH /api/v2/issues/ item shape (IssueSerializer). `site` is
// the Site's own string id (Site.id is a CharField PK, not a number --
// see Site's docstring in core/models.py), matching every other
// site-id-shaped field in this file (e.g. DtSessionMeta.siteId-alikes).
export interface Issue {
  id: number
  site: string
  site_name: string | null
  sector: number | null
  sector_label: string | null
  title: string
  description: string
  status: IssueStatus
  severity: IssueSeverity
  assignee: number | null
  assignee_name: string | null
  created_by: number | null
  created_by_name: string | null
  resolved_by_activity: number | null
  resolved_by_activity_name: IssueResolvedByActivity | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

// POST /api/v2/issues/ request body.
export interface IssueCreate {
  site: string
  sector?: number | null
  title: string
  description?: string
  status?: IssueStatus
  severity?: IssueSeverity
  assignee?: number | null
}

// PATCH /api/v2/issues/<id>/ request body -- every field optional, same
// partial-update shape used elsewhere in this file (e.g. Partial<UserWrite>
// at queries.ts's useUpdateUser).
export type IssueUpdate = Partial<IssueCreate> & {
  resolved_by_activity?: number | null
}

// GET /api/v2/sites/<id>/dt-sessions/ item shape — the Site Detail page's
// "Drive Tests Near This Site" panel. A trimmed sibling of
// DtSessionListItem (matches SiteDtSessionSerializer on the backend):
// this is a small summary panel embedded in a site page, not the History
// table, so it skips uploaded_by_name/meta/size_bytes/remarks/
// attachment_count — fields that panel has no room or need for.
export interface SiteDtSession {
  id: number
  name: string
  tech: DtTech
  date: string | null
  uploaded_date: string | null
  saved_at: string
  sample_count: number
}

// GET .../dt-sessions/<id>/attachments/ item shape, and the nested
// `attachments` array on DtSessionDetail (2026-09-07 — "add a provision
// of attaching multiple files related to the saved session").
export interface DtSessionAttachment {
  id: number
  original_filename: string
  url: string | null
  size_bytes: number | null
  uploaded_by_name: string | null
  uploaded_at: string
}

export interface DtSessionDetail extends DtSessionListItem {
  samples: DtSample[]
  attachments: DtSessionAttachment[]
}

// ── Vendor RNO report importer (2026-09-15, updated 2026-09-26) ─────────
// See RfOptimizationReport's docstring in core/models.py for the full
// feature: an uploaded vendor .docx is parsed for its antenna
// change-log table, Lot-wise OSS KPI summary tables, and worst-cell KPI
// tables (parse-preview, nothing saved yet), reviewed/edited in the
// frontend, then confirmed into one RfOptimizationReport + its
// SectorConfigChange/RfKpiSummary/RfCellKpi rows. Minutes-of-Meeting
// content is NOT parsed -- it's a plain RfReportAttachment
// (category='mom'), same as the source .docx.
//
// Recommendation-table parsing (new site/band additions -> Issue rows)
// was removed 2026-09-26 ("now it is not needed") -- Issue.source_report
// still exists for historical recommendation-derived Issues, but nothing
// in this app creates new ones anymore.

export type RfReportAttachmentCategory = 'source' | 'mom' | 'other'

// One row from RfReportParsePreviewView's response -- NOT yet saved.
// `matched_sector_id`/`matched_site_id` are best-effort suggestions from
// the backend's cell-name lookup; the review UI lets the user override
// or clear them before confirm-import.
export interface RfAntennaChangePreviewRow {
  sn: number | null
  cell_name: string
  before_change: string
  after_change: string
  result: string
  antenna_type: string
  antenna_shared_with: string
  raw_row: Record<string, string>
  matched_sector_id: number | null
  matched_site_id: string | null
  // 2026-09-29 addition ("comparison should be done with both before and
  // after... it is only for analysis before save import") — the matched
  // Sector's CURRENT azimuth/mech_tilt/elec_tilt, purely for the review
  // table's own before_change/after_change comparison (see
  // antennaChangeMatch.ts). Never sent back on confirm-import; nothing
  // here is stored anywhere new.
  current_azimuth: number | null
  current_mech_tilt: number | null
  current_elec_tilt: number | null
}

// One Lot-wise OSS KPI summary row from parse-preview -- aggregate,
// no per-cell identity (2026-09-26, see RfKpiSummary's docstring in
// models.py). `target`/`pre_value`/`post_value`/`remark` are the
// vendor's own text, never force-parsed ("66.19%(105884)", "Monitor
// only (>=-85dbm)").
export interface RfLotKpiPreviewRow {
  kpi_name: string
  target: string
  pre_value: string
  post_value: string
  remark: string
}

// One worst-cell KPI row from parse-preview (2026-09-26, see
// RfCellKpi's docstring in models.py) -- one table per metric in the
// source document, `metric_name` already has its trailing "Pre"/"Post"
// header token stripped server-side.
export interface RfCellKpiPreviewRow {
  enb_id: string
  enodeb_name: string
  cell_name: string
  metric_name: string
  pre_value: string
  post_value: string
  matched_sector_id: number | null
  // 2026-09-29 addition ("with what value it is matched?") — same field
  // RfAntennaChangePreviewRow already has, so the review table can show
  // which site a "Matched" row resolved to.
  matched_site_id: string | null
}

// A table from parse-preview that wasn't classified by any of this
// module's detectors -- currently always empty (2026-09-26: the
// recommendation-table importer that used to populate this was
// removed); kept in the response shape in case a future table type
// wants the same "visible even when not classified" reporting.
export interface RfReportUnmatchedTable {
  header: string[]
  row_count: number
  parsed: boolean
}

// Best-effort Lot name / Network / Period-covered suggestion scraped
// from the document's own title page (2026-09-15 follow-up) -- the
// import form pre-fills from this but keeps every field editable.
export interface RfReportSuggestedMetadata {
  lot_name: string
  network: string
  period_covered: string
}

// POST /api/v2/rf-reports/parse-preview/ response.
export interface RfReportParsePreview {
  antenna_changes: RfAntennaChangePreviewRow[]
  lot_kpis: RfLotKpiPreviewRow[]
  cell_kpis: RfCellKpiPreviewRow[]
  tables_scanned: number
  tables_matched: number
  tables_unmatched: RfReportUnmatchedTable[]
  suggested_metadata: RfReportSuggestedMetadata
  suggested_notes: string
}

// One reviewed antenna-change row as sent to confirm-import
// (RfOptimizationReportCreate.antenna_changes below).
export interface RfAntennaChangeInput {
  sn: number | null
  cell_name: string
  sector: number | null
  before_change: string
  after_change: string
  result: string
  antenna_type: string
  antenna_shared_with: string
  raw_row?: Record<string, string> | null
}

// One reviewed Lot-wise KPI row as sent to confirm-import
// (RfOptimizationReportCreate.lot_kpis below).
export interface RfLotKpiInput {
  kpi_name: string
  target?: string
  pre_value?: string
  post_value?: string
  remark?: string
}

// One reviewed worst-cell KPI row as sent to confirm-import
// (RfOptimizationReportCreate.cell_kpis below).
export interface RfCellKpiInput {
  enb_id?: string
  enodeb_name?: string
  cell_name?: string
  sector?: number | null
  metric_name: string
  pre_value?: string
  post_value?: string
}

export interface SectorConfigChange {
  id: number
  sn: number | null
  cell_name: string
  sector: number | null
  sector_label: string | null
  site_id: string | null
  before_change: string
  after_change: string
  result: string
  antenna_type: string
  antenna_shared_with: string
  raw_row: Record<string, string> | null
  created_at: string
}

export interface RfReportAttachment {
  id: number
  original_filename: string
  category: RfReportAttachmentCategory
  url: string | null
  is_compressed: boolean
  size_bytes: number | null
  uploaded_by_name: string | null
  uploaded_at: string
}

// GET/POST /api/v2/rf-reports/ item shape.
export interface RfOptimizationReport {
  id: number
  lot_name: string
  title: string
  vendor: string
  period_covered: string
  network: string
  notes: string
  imported_by: number | null
  imported_by_name: string | null
  imported_at: string
  antenna_changes_detail: SectorConfigChange[]
  lot_kpis_detail: (RfLotKpiPreviewRow & { id: number })[]
  cell_kpis_detail: (RfCellKpiPreviewRow & { id: number })[]
  attachments: RfReportAttachment[]
  // Which OptimizationActivity(s) reference this report directly
  // (2026-09-23) -- the reverse of OptimizationActivity.source_report.
  activities: { id: number; name: string; session_count: number }[]
}

// POST /api/v2/rf-reports/ request body -- confirm-import.
export interface RfOptimizationReportCreate {
  lot_name: string
  title?: string
  vendor?: string
  period_covered?: string
  network?: string
  notes?: string
  antenna_changes?: RfAntennaChangeInput[]
  lot_kpis?: RfLotKpiInput[]
  cell_kpis?: RfCellKpiInput[]
}

// GET /api/v2/dt-sessions/<id>/serving-cells/ — the distinct serving
// cells this session's samples were attributed to, joined to Site coords
// + Sector azimuth. Loaded once per session; the coverage map's hover
// connector looks up a clicked sample's cell here by `site_id`.
export interface DtServingCell {
  pci: number | null
  site_id: string
  site_name: string
  site_lat: number | null
  site_lng: number | null
  cell_name: string | null
  sector: string | null
  local_cell_id: number | null
  azimuth: number | null
  // Antenna wedge visualization (2026-09-27) — see Sector.beamwidth/
  // Sector.radius's docstring in models.py. DtCoverageMap.tsx's
  // SectorWedgeOverlay draws a theoretical coverage wedge under the real
  // RSRP dots only when both are non-null. max_tx_power_dbm (2026-09-27
  // follow-up — the real "Maximum TX Power (dBm)" column, confirmed
  // present in the WSD-shaped xlsx source) is shown in the wedge's
  // tooltip when present, but never required to draw one.
  beamwidth: number | null
  radius: number | null
  max_tx_power_dbm: number | null
  sample_count: number
  mean_dist_km: number | null
}

// GET /api/v2/dt-sessions/compare/?a=<id>&b=<id> (2026-09-12) -- see
// DriveTestSessionViewSet.compare()'s docstring in backend-django/core/
// drive_test.py for the full contract; field names below mirror its
// Response() dict exactly.
export interface DtCompareSessionSummary {
  id: number
  name: string
  date: string | null
  tech: DtTech
}

// One matched grid cell's before/after averages + delta. `a`/`b`/`delta`
// are keyed by whichever metric names `metrics` below lists for this
// tech (a subset of 'rsrp' | 'rsrq' | 'sinr' | 'ecno' | 'rx_qual') --
// plain `Record<string, ...>` rather than DtMetric's narrower key union
// since which keys are actually present varies per tech and this shape
// is read generically (`cell.delta[metricKey]`) by DtCompareDeltaMap.
export interface DtCompareCell {
  lat: number
  lng: number
  sample_count_a: number
  sample_count_b: number
  a: Record<string, number | null>
  b: Record<string, number | null>
  delta: Record<string, number | null>
}

export interface DtCompareSummary {
  matched_cells: number
  unmatched_cells_a: number
  unmatched_cells_b: number
  avg_delta: Record<string, number | null>
  improved_pct: Record<string, number | null>
  degraded_pct: Record<string, number | null>
  unchanged_pct: Record<string, number | null>
}

export interface DtSessionCompare {
  session_a: DtCompareSessionSummary
  session_b: DtCompareSessionSummary
  metrics: string[]
  cells: DtCompareCell[]
  summary: DtCompareSummary
}

export interface DtSessionCreate {
  name: string
  tech: DtTech
  date: string
  uploaded_date: string
  meta: DtSessionMeta
  samples: DtSample[]
  mode?: string
}

// GET/PUT /permissions-matrix/ shape — excludes superadmin (see
// PermissionsMatrixView's docstring), so only admin/viewer appear here.
// 2026-10-01 ("full parity" RBAC feature) -- was hardcoded to exactly
// 'admin' | 'viewer'. The matrix now has one column per real Role
// (excluding superadmin, same bypass reasoning as always), so the key
// type widens to a plain string.
export type PermissionsMatrix = Record<string, PermissionMap>

/** Same helper the v1 client already needs for CRUD-vs-simple menus.
 *
 * `role` is required (not optional) deliberately: v1 never writes explicit
 * role_permissions rows for 'superadmin' — it's a bypass role with
 * implicit full access everywhere in the v1 server code, not one that's
 * looked up in the permissions table. Confirmed against real production
 * data (2026-07-27): a real superadmin account's `/auth/me/` response
 * comes back with `permissions: {}` — genuinely empty, not a bug. Without
 * this special case, isAllowed() would read "empty map" as "deny
 * everything" and lock superadmin out of any menu gated by it. */
export function isAllowed(
  role: Role,
  perm: PermissionValue | undefined,
  action: 'read' | 'write' | 'update' | 'delete' = 'read',
): boolean {
  if (role === 'superadmin') return true
  if (perm === undefined) return false
  if (typeof perm === 'boolean') return action === 'read' ? perm : false
  return !!perm[action]
}

// ── Advanced Site Search (2026-08-06) ───────────────────────────────────
// Ports v1's "Advanced Site Search" modal (bts_monitor.html
// openSearchModal/runSearch, ~line 1810-1904 and 8510-8621), with two
// deliberate changes: dropdown-backed options (Region/Tech/Type/Status)
// are NOT hardcoded from v1's assumed lists — real dev data confirmed
// v1's assumption (Type: Macro/Micro/Indoor/Outdoor) doesn't match v2
// (every site is `type='Macro-BTS'`); and, per a same-day follow-up
// request ("make search option related to [site info, sectors info,
// drive test data] not kpi data"), v1's 5 KPI-threshold fields were
// replaced with site/sector/drive-test fields — KPI lookups already live
// in SLA/NTA/RF Audit/Scatter/KPI Trend, this search's job is finding a
// record, not re-implementing KPI reporting. See core/views.py's
// SiteSearchView docstring for the exact per-field matching semantics.
export interface SiteSearchParams {
  q?: string
  region?: string
  city?: string
  // Live Site Directory fields (2026-09-30, "update search parameters
  // also as our application also updated") — real Site fields from the
  // 2026-08-26 sync that had no search filter until now. `deployment_status`
  // exact match, `palika` substring, `ward_no` exact integer (sent as a
  // string like every other query param here, parsed server-side).
  deployment_status?: string
  palika?: string
  ward_no?: string
  // `tech` matches EITHER Site.tech or any sector's own Sector.tech (see
  // core/views.py's SiteSearchView docstring) — needed since real 2G/3G
  // values only ever live on sector rows, not Site.tech.
  tech?: string
  // 2026-09-30 ("Site.type is dead -- wire the Type filter to Tower
  // Type") — substring match against Site.tower_type (GBT/RTP/RTT/wall
  // mount/etc, from the LTE Engineering Parameter import), not the
  // never-populated Site.type. Renamed from the old `type` param for the
  // same reason the UI label changed from "Type" to "Tower Type" — so the
  // param name doesn't silently lie about what field it actually filters.
  tower_type?: string
  cell_name?: string
  // Cell Active Status (2026-08-10, "add parameter 'cell actual status'
  // with on-air, planned, dismantle") — substring match against any
  // sector's Sector.cell_active_status. Replaces the old status/
  // status_2g/status_3g/local_cell_id/pci fields (removed same request).
  cell_active_status?: string
  // Lat/Long Available (2026-08-10, "for 'lat/long' with available and
  // not available") — `'1'` = site has both lat and lng recorded, `'0'`
  // = either is missing. Replaces the old lat/lng/radius_km proximity
  // search (removed same request — a different feature, "search near a
  // coordinate", not what this ask wants).
  has_location?: string
  has_dt?: string
  // 'all' | 'same_latlong' | 'different_latlong' (2026-08-09, "add search
  // parameter with all sector expansion, sector expansion with same
  // latlong and sector expansion with different latlong") — see
  // core/sector_expansion.py's module docstring for the full
  // classification rule (a real Nepal Telecom sector-letter naming
  // convention: baseline vs. expansion letter sets per tech, plus a Cell
  // Name "expansion" substring and GPS divergence as additional signals).
  sector_expansion?: string
}

export interface SiteSearchResult {
  id: string
  name: string
  region: string
  city: string
  district: string
  tech: string
  status: string
  status_2g: string
  status_3g: string
  sector_count: number
  has_dt: boolean
  lat: number | null
  lng: number | null
  // Sector-wise fields (2026-08-09 follow-up: "it is giving summary
  // result with sitename, need sector wise result with cell name") —
  // only present when the request had `sector_expansion` set. In that
  // mode the server returns one row PER MATCHING SECTOR (not per site),
  // `tech`/`lat`/`lng` above become the SECTOR's own effective values
  // (falls back to the site's when the sector has no override), and
  // `status`/`status_2g`/`status_3g` are blank (site-level concepts that
  // don't apply per-sector). Absent/undefined in every other search mode.
  cell_name?: string
  sector?: string
  local_cell_id?: number | null
}

export interface SiteSearchResponse {
  count: number
  total: number
  results: SiteSearchResult[]
}

// ── Dynamic top-nav (2026-08-08) ─────────────────────────────────────────
// Mirrors core/models.py's MenuItem exactly — see its docstring for what
// `access` and `permission_key` mean. Submenus support ARBITRARY depth
// (2026-08-08 follow-up) — `parent` may point at any other item, top-level
// or not; the only server-side rule is "no cycles" (MenuItemSerializer).

export type MenuLinkType = 'route' | 'external'
// 'rescue' (2026-09-03) -- role in (rescue_operator, superadmin), mirroring
// core/rescue.py's IsRescueOperator exactly. See models.py's MenuItem
// ACCESS_RESCUE comment for why this is its own tier rather than going
// through 'permission'.
export type MenuAccess = 'all' | 'permission' | 'admin' | 'superadmin' | 'rescue'

export interface MenuItem {
  id: number
  label: string
  link_type: MenuLinkType
  path: string
  parent: number | null
  order: number
  access: MenuAccess
  permission_key: string
  is_active: boolean
  // Sidebar + Dashboard (2026-08-08 follow-up) — a single emoji and a
  // one-line hover/card detail. Both blank-able; the sidebar/dashboard
  // fall back to a generic icon / just the label when empty.
  icon: string
  description: string
  // Uploaded icon image (2026-08-08, second follow-up: "i downloaded
  // icon file but cant edit or add icon in menu" — `icon` above only
  // ever accepted a typed/pasted emoji). Read-only absolute URL; null
  // when nothing's been uploaded. Takes precedence over `icon` wherever
  // an icon renders (sidebar rail, submenu rows, Dashboard shortcut
  // cards) — see MenuItem's docstring in core/models.py on the Django
  // side for the exact precedence rule.
  icon_image_url: string | null
}

/** Write shape for create/update — mirrors MenuItem but swaps the
 * read-only `icon_image_url` for the two write-only fields
 * MenuItemSerializer actually accepts: a base64 data URL to upload/
 * replace the icon image, or an explicit removal flag. Both optional —
 * omitting both leaves whatever icon image the item already has
 * untouched (the common case: editing a row without touching its
 * icon). `remove_icon_image` wins if both are somehow sent. */
export type MenuItemWrite = Omit<MenuItem, 'id' | 'icon_image_url'> & {
  icon_image_data_url?: string
  remove_icon_image?: boolean
}

/** GET /api/v2/menu-tree/'s shape — the server-filtered, nested tree
 * the sidebar renders directly. Deliberately a separate, smaller type
 * from MenuItem above (no access/permission_key/is_active/order — the
 * server already resolved all of that before responding). */
export interface MenuTreeNode {
  id: number
  label: string
  link_type: MenuLinkType
  path: string
  icon: string
  icon_image_url: string | null
  description: string
  children: MenuTreeNode[]
}

// ── Customizable Dashboard (2026-08-08) ──────────────────────────────────
// Mirrors core/dashboard.py's DashboardView response shape exactly. Two
// card `type`s share one flat shape rather than a discriminated union
// with different fields per type — `value` is simply null for a
// shortcut card and `path`/`link_type`/`description` are null for a
// stat card, which keeps DashboardPage's render/reorder logic uniform
// instead of branching on type everywhere.
export type DashboardCardType = 'stat' | 'shortcut'

export interface DashboardCard {
  key: string
  label: string
  icon: string
  // Uploaded MenuItem icon image (2026-08-08 follow-up) — null for every
  // stat card (they have no backing MenuItem) and for a shortcut card
  // whose MenuItem has no uploaded image; takes precedence over `icon`
  // when present, same rule as MenuTreeNode.
  icon_image_url: string | null
  type: DashboardCardType
  order: number
  visible: boolean
  value: number | null
  path: string | null
  link_type: MenuLinkType | null
  description: string
}

/** PUT /api/v2/dashboard/ body — only the cards actually touched by the
 * user's customize session need to be included (server does a per-card
 * upsert, not a full replace — see DashboardView.put's docstring). */
export interface DashboardCardLayoutEntry {
  card_key: string
  order: number
  visible: boolean
}

// ── Customizable branding (2026-08-08 follow-up) ─────────────────────────
// Mirrors core/serializers.py's BrandingSettingsSerializer exactly. `logo`
// itself is write-only server-side (never returned) — reads only ever see
// `logo_url` (an absolute URL, or null when no custom logo is set). Writes
// send a base64 data URL in `logo_data_url`, matching this app's existing
// file-upload convention (BackupPage.tsx) rather than multipart/form-data
// — see BrandingSettingsView's docstring on the Django side for why.
export interface BrandingSettings {
  app_name: string
  logo_url: string | null
  // Login-page text customization (2026-08-08 follow-up: "let superadmin
  // to customize the login interface texts also"). Empty string means
  // "not customized" — LoginPage.tsx falls back to its own hardcoded
  // default for each, same convention as app_name/logo_url.
  login_subtitle: string
  login_username_label: string
  login_password_label: string
  login_button_text: string
  // Bottom disclaimer pill (2026-08-11 follow-up), same convention.
  login_disclaimer: string
  // Minutes of inactivity before the SPA signs itself out; 0 = never
  // (2026-08-23). Server-provided rather than a build-time VITE_ var so it
  // can be changed with an .env edit instead of an image rebuild. Optional
  // here because an older backend simply won't send it, and AuthContext
  // falls back to its own default.
  //
  // 2026-08-25: also superadmin-editable now, via the Branding page — see
  // BrandingSettingsWrite below. This read value already reflects that
  // override (the backend merges DB override + env fallback before
  // sending), so no separate field is needed for "is this overridden".
  idle_timeout_minutes?: number
  // Which sign-in methods this server offers (2026-08-23, Keycloak SSO).
  // Read-only and server-derived, unlike every field above — they are not
  // BrandingSettings columns, they are computed from KEYCLOAK_*/
  // LOCAL_LOGIN_ENABLED. They ride along on this payload because it is
  // already the one public, pre-token response LoginPage.tsx fetches, so
  // adding them here avoided a second AllowAny endpoint. Both are plainly
  // visible from the login form itself, so neither is sensitive.
  sso_enabled: boolean
  local_login_enabled: boolean
  // App-wide footer text (2026-09-30), same blank-means-default
  // convention as the login_* fields above. Rendered by both Layout.tsx
  // (every authenticated page) and LoginPage.tsx via a shared
  // FooterLine.tsx component. `footer_developed_by` blank means the
  // whole "Developed By" line is omitted, not rendered empty.
  footer_text: string
  footer_developed_by: string
}

/** PUT /api/v2/branding/ body. All fields optional/partial: omit `app_name`
 * to leave it unchanged, omit both logo fields to leave the logo unchanged,
 * set `remove_logo: true` to clear it back to the default, or set
 * `logo_data_url` to replace it. `remove_logo` wins if both are somehow
 * sent (see the view's docstring). Same "omit to leave unchanged" rule
 * applies to the four login-text fields below. */
export interface BrandingSettingsWrite {
  app_name?: string
  logo_data_url?: string
  remove_logo?: boolean
  login_subtitle?: string
  login_username_label?: string
  login_password_label?: string
  login_button_text?: string
  login_disclaimer?: string
  // 2026-08-25: 0-480 sets an override (0 = disable auto-logout), null
  // resets back to the server's IDLE_TIMEOUT_MINUTES env default. Omit to
  // leave the current setting unchanged, same "omit means unchanged" rule
  // as every other field here.
  idle_timeout_minutes?: number | null
  footer_text?: string
  footer_developed_by?: string
}

// ── External API keys (2026-08-12) ───────────────────────────────────────
// Mirrors core/api_auth.py's ApiKeySerializer exactly. These credentials
// authenticate EXTERNAL systems calling /api/external/v1/ (see
// core/external_api.py) — a distinct concern from this app's own JWT
// login, managed here only as plain superadmin CRUD over the ApiKey
// model (same shape as UsersPage/MenuAdminPage's own hooks).
export type ApiKeyScope = 'sites:read' | 'sites:write' | 'dt:read' | 'dt:write' | 'coverage:read'

export const API_KEY_SCOPES: { value: ApiKeyScope; label: string }[] = [
  { value: 'sites:read', label: 'Sites & Sectors — read' },
  { value: 'sites:write', label: 'Sites & Sectors — write' },
  { value: 'dt:read', label: 'Drive Test sessions — read' },
  { value: 'dt:write', label: 'Drive Test sessions — write' },
  { value: 'coverage:read', label: 'Telemetry Coverage — read' },
]

export interface ApiKeyRow {
  id: number
  name: string
  key_prefix: string
  scopes: ApiKeyScope[]
  is_active: boolean
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  created_by_name: string | null
}

/** POST /api/v2/api-keys/ body. */
export interface ApiKeyCreate {
  name: string
  scopes: ApiKeyScope[]
  expires_at?: string | null
}

/** PATCH /api/v2/api-keys/<id>/ body — everything but the key material
 * itself (`key_prefix`, and the never-returned `key_hash`) can be
 * edited after creation. */
export type ApiKeyUpdate = Partial<Pick<ApiKeyRow, 'name' | 'scopes' | 'is_active' | 'expires_at'>>

/** The ONE response shape that includes `key` — the full plaintext API
 * key, returned only from the create call, never retrievable again
 * afterward (see ApiKey's docstring in core/models.py). Every other read
 * of an ApiKeyRow omits it entirely; there's nothing to omit from,
 * because it was never stored. */
export interface ApiKeyCreateResponse extends ApiKeyRow {
  key: string
}

// ── Live Site Directory sync (2026-08-26, multi-source since 2026-09-08) ──
// GET/POST /api/v2/sites/sync-live/sources/, GET/PATCH/DELETE
// /api/v2/sites/sync-live/sources/<id>/, POST .../sources/<id>/sync/ — see
// LiveSiteSource's docstring (core/models.py) for the multi-source design:
// each row is its own connection (URL/credentials/auth scheme), its own
// schedule (sync_interval_minutes), and its own run history, all synced
// independently by the same site-sync container; every source is merged
// into the same Site table by site id. `api_key` itself is NEVER present
// in this shape — only whether one is set and its masked tail — so this
// response is safe to keep in a React Query cache without leaking the
// real secret.
export interface LiveSiteSource {
  id: number
  name: string
  api_url: string
  auth_scheme: 'Bearer' | 'Token'
  sync_interval_minutes: number
  enabled: boolean
  api_key_set: boolean
  api_key_masked: string
  created_at: string
  updated_at: string
  updated_by_name: string | null
  last_run_at: string | null
  last_success_at: string | null
  last_created: number | null
  last_updated: number | null
  last_warnings: string[] | null
  last_error: string
}

/** POST (create) / PATCH (edit) body. `api_key` is optional on an edit —
 * omit it (or send '') to keep whatever key is already stored, see
 * LiveSiteSourceDetailView's docstring — but is the only way to set one
 * in the first place on create, since there's nothing to fall back to. */
export interface LiveSiteSourceInput {
  name?: string
  api_url?: string
  auth_scheme?: 'Bearer' | 'Token'
  sync_interval_minutes?: number
  enabled?: boolean
  api_key?: string
}

/** POST .../sources/<id>/sync/ response (2026-09-09 — runs in the
 * background, not inline: a real sync against a large source can take
 * well over a minute, longer than any sensible HTTP timeout, so this
 * endpoint only STARTS the sync and returns immediately). `source` is a
 * snapshot from the moment of the click, not the finished result — the
 * actual created/updated/warnings/error land on the source row itself
 * (last_run_at and friends) once the background sync finishes, picked
 * up by useLiveSiteSources()'s own 15s poll. See
 * LiveSiteSourceSyncView's docstring (core/site_import.py). */
export interface LiveSiteSourceSyncStartResponse {
  started: true
  source: LiveSiteSource
}

// ── Crowdsourced telemetry admin (2026-08-31) ───────────────────────────
// Backs the two new sidebar pages. The ingest keys authenticate a
// SEPARATE public surface at /api/telemetry/v1/ (not this JWT /api/v2/
// one) — same relationship ApiKeyRow has to /api/external/v1/.

export interface TelemetryIngestKeyRow {
  id: number
  name: string
  key_prefix: string
  is_active: boolean
  rate_limit_per_min: number
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

export interface TelemetryIngestKeyCreate {
  name: string
  rate_limit_per_min?: number
  expires_at?: string | null
}

export type TelemetryIngestKeyUpdate = Partial<
  Pick<TelemetryIngestKeyRow, 'name' | 'is_active' | 'rate_limit_per_min' | 'expires_at'>
>

/** The full `tel_…` key is returned ONLY from the create call and never
 * again — mirrors ApiKeyCreateResponse. */
export interface TelemetryIngestKeyCreateResponse extends TelemetryIngestKeyRow {
  key: string
}

export interface TelemetryStats {
  keys: { total: number; active: number }
  batches: { count: number; sample_total: number; last_received_at: string | null }
  samples: { last_24h: number; last_7d: number }
  coverage_bins: number
  by_network_7d: { network_type: string; samples: number }[]
}

export interface TelemetryCoverageBin {
  lat: number | null
  lng: number | null
  geohash: string
  network_type: string
  region: string
  sample_count: number
  device_count: number | null
  rsrp_mean: number | null
  rsrp_p10: number | null
  rsrp_min: number | null
  rsrq_mean: number | null
  sinr_mean: number | null
  // cqi_mean (2026-09-15) -- LTE/NR-only Channel Quality Indicator mean,
  // 0-15 scale, higher is better (see backend TelemetryCoverageBin.cqi_mean).
  cqi_mean: number | null
  last_ts: string | null
}

export interface TelemetryCoverageResponse {
  /** 'bins' = already-aggregated TelemetryCoverageBin rows; 'samples' =
   * aggregated on the fly from recent raw TelemetrySample rows because no
   * bin matched the filter yet (fresh deploy, retention not run). */
  source: 'bins' | 'samples'
  bins: TelemetryCoverageBin[]
  truncated: boolean
  networks: string[]
  regions: string[]
}

export interface TelemetryCoverageParams {
  network_type?: string
  region?: string
  days?: number
  limit?: number
}

export interface TelemetryLiveSample {
  device_id: string
  ts: number
  received_at: string
  lat: number | null
  lng: number | null
  network_type: string
  // Raw operator identifier (2026-09-02) -- bare MCC/MNC, same convention
  // as UsersPage's operator_mncs column: no fabricated operator-name
  // mapping, just the codes the sample actually carried.
  mcc: string
  mnc: string
  rsrp_dbm: number | null
  rsrq_db: number | null
  sinr_db: number | null
  // rssi_dbm (2026-09-03, "need to collect any 2g, 3g or 4g data") --
  // GSM/UMTS (2G/3G) samples only ever populate this, never
  // rsrp_dbm/rsrq_db/sinr_db (LTE/NR-only fields) -- see
  // CellSampleCollector.kt's parseCellInfo() on the SDK side. Without this,
  // a real 2G/3G reading had nowhere to display at all.
  rssi_dbm: number | null
  // rx_qual/rscp_dbm/ecio_db (2026-09-03, "for 2g, rx level and rx qual
  // and for 3g rscp and ec/io") -- proper RAN-standard 2G/3G metrics:
  // GSM RxQual class (0-7) and WCDMA RSCP/Ec-Io. rscp_dbm/ecio_db are
  // only ever populated on Android 10+ devices (see
  // CellSampleCollector.kt), null otherwise same as any unsupported field.
  rx_qual: number | null
  rscp_dbm: number | null
  ecio_db: number | null
  // cqi_derived (2026-10-04) -- LTE CQI estimated from this sample's SINR,
  // 0-15, higher is better. An estimate, not a measured value (see backend
  // telemetry.py's cqi_from_sinr). Null for non-LTE samples.
  cqi_derived?: number | null
  // GPS accuracy of this fix in metres (2026-10-04). Route endpoint only.
  gps_accuracy_m?: number | null
  // Moving-average coordinates for route lines (2026-10-04). Route endpoint
  // only, present when ?smooth= is requested.
  lat_smooth?: number | null
  lng_smooth?: number | null
  trigger_reason: string
  // Serving-cell identity (already sent by the backend; added to this type
  // 2026-10-07 for lib/declusterPlot.ts -- tells "the same site measured
  // twice at one spot" apart from "two different sites happened to be
  // measured from the same spot." Blank when nothing matched within 5 km.
  serving_site_id?: string | null
  serving_sector?: string | null
}

// VoLTE/VoNR call-quality dev/pilot sample (2026-10-02) -- see
// core/volte_quality.py's module docstring. `mos_estimate` is a
// server-computed ITU-T G.107 E-model ESTIMATE, never a true
// perceptually-measured MOS -- always label it "Estimated MOS" in the UI,
// never a bare "MOS". Both `r_factor`/`mos_estimate` are null when the
// codec has no entry at all, or a required raw input was missing -- never
// a fabricated number. `mos_is_provisional` (true for EVS/AMR-NB today)
// marks a value computed from a deliberately APPROXIMATED codec entry
// (real constants run through a different scale's formula, or a
// different codec's constants used as a proxy) -- the UI must visually
// distinguish this from a verified estimate (AMR-WB/G.711/G.729), never
// show both with the same confidence.
export interface VolteCallQualitySample {
  device_id: string
  ts: string
  received_at: string
  network_type: string
  codec: string
  call_duration_s: number | null
  packet_loss_pct: number | null
  jitter_ms: number | null
  rtt_ms: number | null
  quality_level: string
  r_factor: number | null
  mos_estimate: number | null
  mos_is_provisional: boolean
}

export interface VolteQualityListResponse {
  samples: VolteCallQualitySample[]
}

export interface TelemetryLiveSamplesResponse {
  samples: TelemetryLiveSample[]
  count: number
  window_minutes: number
  devices: string[]
  // Delta-fetch cursor (2026-10-02 perf follow-up) -- pass back as `since`
  // on the next poll to fetch only samples newer than this response,
  // instead of re-fetching the whole window every 10s. The SERVER's
  // clock, not the client's -- see useTelemetryLiveSamples' own handling.
  server_time: string
}

export interface TelemetryLiveSamplesParams {
  minutes?: number
  limit?: number
  device_id?: string
  // Optional area filter (2026-09-02) -- narrows both `samples` and
  // `devices` in the response to within `radius_km` of (lat, lng), via
  // core/telemetry_admin.py's TelemetryLiveSamplesView PostGIS filter.
  // Powers TelemetryDriveTestSessionsPage's "search an area, enroll only
  // the devices found there" flow. Pass all three together or none.
  lat?: number
  lng?: number
  radius_km?: number
}

// Scoped drive-test sessions over live telemetry (2026-09-01) — see
// core/telemetry_admin.py's TelemetryDriveTestSession* views and
// core/models.py's TelemetryDriveTestSession docstring.
export interface TelemetryDriveTestSession {
  id: number
  name: string
  device_ids: string[]
  area_min_lat: number | null
  area_max_lat: number | null
  area_min_lng: number | null
  area_max_lng: number | null
  // Optional per-session consent gate (2026-09-02) -- when true, the
  // samples endpoint only returns data from devices that separately
  // opted in via the SDK's setDriveTestConsent(). Set at creation only.
  require_consent: boolean
  // Optional auto-end cap in minutes (2026-10-07) -- mirrors the mobile
  // SDK's own share-window cap. Null = unlimited (must be ended by hand
  // or by a drive_stop marker from a single enrolled device -- see
  // core/collection.py's record_collection_sessions()).
  max_duration_minutes: number | null
  status: 'active' | 'ended'
  started_at: string
  ended_at: string | null
  created_by_name: string | null
}

export interface TelemetryDriveTestSessionCreateInput {
  name: string
  device_ids: string[]
  area_min_lat?: number | null
  area_max_lat?: number | null
  area_min_lng?: number | null
  area_max_lng?: number | null
  require_consent?: boolean
  max_duration_minutes?: number | null
}

export interface TelemetryDriveTestConsentSummary {
  consented: number
  pending: number
}

export interface TelemetryDriveTestSpeedResult {
  device_id: string
  ts: string
  ping_median_ms: number | null
  jitter_ms: number | null
  download_mbps: number | null
  upload_mbps: number | null
  network_type: string
  rsrp_dbm: number | null
}

export interface TelemetryDriveTestSessionSamplesResponse {
  session: TelemetryDriveTestSession
  samples: TelemetryLiveSample[]
  // Speed test results from this session's enrolled devices (2026-10-07) --
  // from the public Speed test card, scoped by the same device + time window
  // as `samples`.
  speed_results: TelemetryDriveTestSpeedResult[]
  count: number
  require_consent: boolean
  consent_summary: TelemetryDriveTestConsentSummary | null
  // Delta-fetch cursor -- see TelemetryLiveSamplesResponse's own identical field.
  server_time: string
}

export interface TelemetryDriveTestSessionEndResponse extends TelemetryDriveTestSession {
  // Present whenever `request_opt_out: true` was sent — how many of this
  // session's enrolled devices got a TelemetryRemoteOptOutRequest left
  // for them (core/telemetry_admin.py's TelemetryDriveTestSessionEndView).
  // Each device applies it itself on its next upload, not immediately.
  opt_out_requested_count?: number
}

// Emergency switch (2026-10-05) — mirrors core/emergency.py's
// EmergencyStatusView/EmergencyDeclareView/EmergencyEndView. Replaced the
// old RescueConsentPolicy 'optional' mode entirely: rescue search is off
// by default, and a superadmin declaring an emergency is the only way to
// turn it on, for a capped number of days. It never creates a new
// phone-number link — it only lets an existing, already-opted-in
// subscriber be found while active, and lets a case trace skip the
// device Accept (core/device_trace.py).
export interface EmergencyStatus {
  active: boolean
  id?: number
  reason?: string
  declared_at?: string
  expires_at?: string
  declared_by?: string | null
  default_days: number
  max_days: number
}

export interface EmergencyDeclareParams {
  reason: string
  days: number
}

// Rescue-location lookup (2026-09-03) -- mirrors core/rescue.py's
// RescueLookupView exactly. Both params are required server-side: there
// is no browse/list mode, only ever "this one number, for this stated
// reason" (see that view's docstring on why case_reference exists and is
// never validated against anything -- it just makes every audit-log row
// say WHY, not only WHO/WHEN).
export interface RescueLookupParams {
  msisdn: string
  case_reference: string
}

// `found: false` is the ONLY thing ever returned for a number that has no
// matching, currently-in-scope SubscriberLastLocation row -- deliberately
// identical whether that's because the number was never enrolled, consent
// was withdrawn, or it belongs to a different operator than the caller is
// scoped to (RescueLookupView never reveals which). No fields beyond
// `found` exist in that case.
export interface RescueLookupResult {
  found: boolean
  lat?: number | null
  lng?: number | null
  accuracy_m?: number | null
  source?: string
  last_seen_ts?: string
}

// Bulk rescue lookup (2026-09-04) -- mirrors core/rescue.py's
// RescueBulkLookupView exactly. For a list of numbers obtained some OTHER
// way (an HLR/VLR area extract run through the operator's own
// core-network tooling -- see that view's docstring), checks each one
// against this app's own enrolled-subscriber records at once. Same
// found/not-found semantics as the single lookup above, per number.
export interface RescueBulkLookupParams {
  msisdns: string[]
  case_reference: string
}

export interface RescueBulkLookupResultRow extends RescueLookupResult {
  msisdn: string
}

export interface RescueBulkLookupResponse {
  results: RescueBulkLookupResultRow[]
  requested_count: number
  invalid_count: number
  found_count: number
}

// Superadmin-only enrolled-device list (2026-10-07) -- mirrors
// core/rescue.py's RescueEnrolledListView, a provisional, explicit
// exception to this feature's own "never browse/list" rule (see that
// view's docstring).
// Superadmin device-location trace (2026-10-08) -- mirrors
// core/device_lookup.py's DeviceLocationTraceView. A deliberate, separate
// lane from Rescue Lookup: no case reference, no prior rescue-location
// consent -- resolves whatever MSISDN/IMEI a device uploaded as its own
// identity to that device's latest regular telemetry fix.
export interface DeviceLocationTraceResult {
  found: boolean
  device_hash?: string
  lat?: number
  lng?: number
  network_type?: string
  ts?: string
  received_at?: string
  phone_model?: string | null
  manufacturer?: string | null
}

// On-demand area sample (2026-10-08) -- mirrors core/area_sample.py. The
// readings carry no device id; `devices` on the results is only a count.
export interface AreaSampleRequest {
  id: number
  label: string
  lat: number
  lng: number
  radius_km: number
  lookback_hours: number
  devices_in_area: number
  pushes_sent: number
  created_at: string
  requested_by: string | null
  // Only on the create response: how many of devices_in_area are sharing now.
  devices_sharing?: number
}

export interface AreaSampleCreateInput {
  lat: number
  lng: number
  radius_km: number
  label?: string
}

export interface AreaSampleReading {
  ts: string
  lat: number
  lng: number
  gps_accuracy_m: number | null
  network_type: string
  pci: number | null
  rsrp_dbm: number | null
  rsrq_db: number | null
  sinr_db: number | null
  rssi_dbm: number | null
  rscp_dbm: number | null
  ecio_db: number | null
  rx_qual: number | null
  cqi: number | null
  cqi_derived: number | null
  serving_site_id: string | null
  serving_sector: string | null
}

export interface AreaSampleResults {
  request: AreaSampleRequest
  devices: number
  samples: AreaSampleReading[]
  open: boolean
  open_until: string
}

// Superadmin registered-device list (2026-10-08) -- mirrors
// core/device_trace.py's RegisteredDeviceListView: every DeviceCredential
// (the "has this phone registered for NTC trace requests" record),
// joined to DeviceIdentity for phone model/manufacturer where available.
// Separate from RescueEnrolledRow below (a different table/consent lane).
export interface RegisteredDeviceRow {
  device_hash: string
  msisdn: string | null
  app_version: string | null
  has_fcm_token: boolean
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  phone_model: string | null
  manufacturer: string | null
}

export interface RescueEnrolledRow {
  device_hash: string
  msisdn: string | null
  lat: number | null
  lng: number | null
  accuracy_m: number | null
  source: string | null
  last_seen_ts: string | null
  phone_model: string | null
  manufacturer: string | null
}

// Superadmin-editable copy for the drive-test consent prompt (2026-09-02)
// — mirrors core/consent.py's DriveTestConsentMessageAdminView /
// core/models.py's DriveTestConsentConfig. Separate from
// TelemetryDriveTestConsentSummary above, which is the subscriber's
// ANSWER (accepted/pending counts) — this is the wording shown before
// they answer. The SDK itself renders no consent UI; a host app that
// wants this centrally-editable text fetches it itself (this project's
// own demo app does) and is equally free to hardcode its own instead.
export interface DriveTestConsentMessage {
  message: string
  updated_at?: string
}

// ── Login/access audit trail (2026-10-01) ───────────────────────────────
// Mirrors core/auth_log.py's AuthEventLogSerializer/AuthEventLog exactly
// -- see that module's docstring for the full design. Superadmin-only
// feed of every sign-in attempt, local or SSO, successful or not.
export type AuthEventType =
  | 'login_success' | 'login_failed' | 'login_locked' | 'login_disabled'
  | 'sso_login_success' | 'sso_login_failed' | 'logout'

export interface AuthEventLogEntry {
  id: number
  event: AuthEventType
  // Raw attempted username, kept even when it never resolved to a real
  // account -- see the model's own docstring for why that matters for
  // "unauthentic access tried" specifically.
  username: string
  user: number | null
  // Resolved account's display name, or the raw `username` when there is
  // no account -- always has SOMETHING to show in a "Who" column.
  user_display: string
  is_success: boolean
  ip_address: string | null
  user_agent: string
  detail: string
  created_at: string
}

export interface AuthEventLogPageResponse {
  count: number
  next: string | null
  previous: string | null
  results: AuthEventLogEntry[]
}

export interface AuthEventLogParams {
  page?: number
  page_size?: number
  event?: AuthEventType
  username?: string
  /** `'1'` restricts to successful events, `'0'` to failures/logout-only
   * exclusions -- see AuthEventLogListView's own docstring. */
  success?: '1' | '0'
}

// ── Unified Audit Log (2026-10-01) ──────────────────────────────────────
// Mirrors core/audit.py's AuditLogListView exactly -- merges AuthEventLog
// (access events, above) and the new AuditEvent (data-change events) into
// one feed. Replaces AccessLogPage.tsx's old narrower view; the
// AuthEventLog* types above stay (the underlying /auth-events/ endpoint
// is unchanged) but are no longer rendered by any page.
export type AuditLogSource = 'access' | 'data_change'

// is_suspicious/suspicious_reason (2026-10-02, Phase E attack-attempt
// detection) -- flags a burst of >=3 failed-login-type access events from
// the SAME IP within a trailing 15 minutes, across potentially different
// usernames. See core/audit.py's _annotate_suspicious() docstring.
export interface AuditLogEntry {
  id: string
  source: AuditLogSource
  created_at: string
  actor: string
  action: string
  resource: string
  detail: string
  ip_address: string | null
  payload: unknown
  is_suspicious: boolean
  suspicious_reason: string
}

export interface AuditLogPageResponse {
  count: number
  next: string | null
  previous: string | null
  results: AuditLogEntry[]
}

export interface AuditLogParams {
  page?: number
  page_size?: number
  /** Free text across actor/action/resource/detail. */
  q?: string
  /** YYYY-MM-DD, inclusive. */
  date_from?: string
  date_to?: string
  source?: AuditLogSource
}

// Active IP blocking (2026-10-02, Phase E2) -- see core/ip_block.py's
// module docstring. `blocked_by_username: null` means an AUTOMATIC block
// (the 3-failures-in-15-minutes auto-trigger); a real username means a
// superadmin manually blocked this IP -- the UI must show these
// differently, never collapse both into one look.
export interface BlockedIpEntry {
  id: number
  ip_address: string
  reason: string
  blocked_at: string
  blocked_by_username: string | null
  is_active: boolean
  unblocked_at: string | null
  unblocked_by_username: string | null
}

// Device-bound, consent-gated tracing (2026-10-04) -- mirrors the operator
// payload from core/device_trace.py's _operator_view(). The device-facing
// shape never carries msisdn or case_reference, so it has no type here.
export type TraceRequestStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'REVOKED' | 'COMPLETED'
export type TraceConsentMethod = '' | 'APP' | 'PHONE_CALL' | 'POLICY_BYPASS'

export interface TraceRequestEntry {
  id: string
  msisdn: string
  case_reference: string
  status: TraceRequestStatus
  consent_method: TraceConsentMethod
  consent_at: string | null
  consent_recorded_by: string | null
  phone_consent_ref: string
  phone_consent_at: string | null
  policy_mode: string
  ttl_minutes: number
  expires_at: string | null
  created_at: string
  ended_at: string | null
  requested_by: string | null
}

export interface TraceRequestCreateResponse extends TraceRequestEntry {
  push_sent: boolean
}

export interface TraceFix {
  ts: string
  lat: number
  lng: number
  accuracy_m: number | null
  network_type: string
  cell_id: number | null
  pci: number | null
  tac: number | null
  mcc: string
  mnc: string
  rsrp_dbm: number | null
  rsrq_db: number | null
  sinr_db: number | null
  rssi_dbm: number | null
  cqi: number | null
}

export interface TraceSpeedResult {
  ran_at: string
  ping_median_ms: number | null
  jitter_ms: number | null
  download_mbps: number | null
  upload_mbps: number | null
  network_type: string
  rsrp_dbm: number | null
}

export interface TraceSession {
  id: string
  source: string
  sample_count: number
  started_at: string
  last_sample_at: string | null
  ended_at: string | null
}

export interface CollectionSessionRow {
  id: string
  source: string
  drive_session_id: string | null
  trace_id: string | null
  user_type: string
  sample_count: number
  started_at: string
  last_sample_at: string | null
  ended_at: string | null
  device_hash?: string | null
}

// One row's route plot (2026-10-07) -- core/collection.py's
// CollectionSessionSamplesView. Same field set regardless of whether the
// row is a trace or a drive (the view normalizes both source tables to
// this one shape), so the Collections page needs no source-specific map.
export interface CollectionSessionSample {
  ts: string
  lat: number
  lng: number
  accuracy_m: number | null
  network_type: string
  pci: number | null
  rsrp_dbm: number | null
  rsrq_db: number | null
  sinr_db: number | null
  // `cqi` is what the phone reported (often null). `cqi_derived` is the
  // server's estimate from SINR, LTE only. Show `cqi` when present.
  cqi: number | null
  cqi_derived: number | null
  // Serving-cell identity (2026-10-07) -- null on trace-sourced rows
  // (TraceLocationSample has no serving-cell resolution of its own); use
  // `pci` as the coarser same-cell fallback for those, same reasoning
  // core/collection.py's CollectionSessionSamplesView documents.
  serving_site_id: string | null
  serving_sector: string | null
}

export interface TraceRequestDetail extends TraceRequestEntry {
  sample_count: number
  speed_results: TraceSpeedResult[]
  session: TraceSession | null
}
