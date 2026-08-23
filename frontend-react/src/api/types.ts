// Mirrors core/serializers.py — kept in one place so a field rename on
// the Django side is a one-file fix here, not a hunt through components.

export type Role = 'superadmin' | 'admin' | 'viewer'

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
  name: string
  dept: string
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
}

export interface SiteDetail extends SiteListItem {
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
}

// ── Phase 2: write payload shapes ───────────────────────────────────────
// These mirror SiteWriteSerializer/UserWriteSerializer exactly (see
// core/serializers.py) — a PUT is NOT a partial patch for sites (matches
// v1's _upsert_site: omitted optional fields clear to null/blank), so
// the form always sends the complete SiteDetail-shaped object back.

export type SectorWrite = Omit<Sector, 'id'>

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

// Site/Sector import (2026-08-05) — see core/site_import.py's module
// docstring. `kind: 'sites'` is pure add-only (existing sites are never
// touched; `updated`/`sites_added` stay 0). `kind: 'sectors'` is a
// 3-way contract per a same-day follow-up request: add a missing
// sector, UPDATE an existing sector if the row's values genuinely
// differ (else left alone, counted in `skipped`), and auto-create the
// parent site (`sites_added`) from the row's own lat/lng if it doesn't
// exist yet.
export interface ImportSitesResult {
  added: number
  updated: number
  skipped: number
  sites_added: number
  errors: string[]
}

export interface AdminUser {
  id: number
  username: string
  role: Role
  name: string
  dept: string
  is_active: boolean
  last_login: string | null
  date_joined: string
  auth_source: AuthSource
}

export interface UserWrite {
  username: string
  password?: string
  role: Role
  name: string
  dept: string
  is_active?: boolean
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
  serving_site_id: string | null
  serving_site_name: string | null
  serving_sector: string | null
  serving_cell_name: string | null
  serving_local_cell_id: number | null
  serving_dist_km: number | null
  cell_role: DtCellRole
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
}

export interface DtSessionDetail extends DtSessionListItem {
  samples: DtSample[]
}

export interface DtSessionCreate {
  name: string
  tech: DtTech
  date: string
  uploaded_date: string
  meta: DtSessionMeta
  samples: DtSample[]
}

// GET/PUT /permissions-matrix/ shape — excludes superadmin (see
// PermissionsMatrixView's docstring), so only admin/viewer appear here.
export type PermissionsMatrix = Record<'admin' | 'viewer', PermissionMap>

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
  // `tech` matches EITHER Site.tech or any sector's own Sector.tech (see
  // core/views.py's SiteSearchView docstring) — needed since real 2G/3G
  // values only ever live on sector rows, not Site.tech.
  tech?: string
  type?: string
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
export type MenuAccess = 'all' | 'permission' | 'admin' | 'superadmin'

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
}

// ── External API keys (2026-08-12) ───────────────────────────────────────
// Mirrors core/api_auth.py's ApiKeySerializer exactly. These credentials
// authenticate EXTERNAL systems calling /api/external/v1/ (see
// core/external_api.py) — a distinct concern from this app's own JWT
// login, managed here only as plain superadmin CRUD over the ApiKey
// model (same shape as UsersPage/MenuAdminPage's own hooks).
export type ApiKeyScope = 'sites:read' | 'sites:write' | 'dt:read' | 'dt:write'

export const API_KEY_SCOPES: { value: ApiKeyScope; label: string }[] = [
  { value: 'sites:read', label: 'Sites & Sectors — read' },
  { value: 'sites:write', label: 'Sites & Sectors — write' },
  { value: 'dt:read', label: 'Drive Test sessions — read' },
  { value: 'dt:write', label: 'Drive Test sessions — write' },
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
