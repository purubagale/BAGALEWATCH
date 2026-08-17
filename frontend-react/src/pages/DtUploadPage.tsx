import type { ChangeEvent, DragEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { apiErrorMessage } from '../api/client'
import { useAppendDtSamples, useCreateDtSession, useDeleteDtSession, useDtSessions, useSites } from '../api/queries'
import type { DtCallSummary, DtDownloadSummary, DtSample, DtSessionCreate, DtSessionDetail, DtSessionListItem, DtSessionMeta, DtTech, SiteListItem } from '../api/types'
import { isAllowed } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import DtCallDownloadSummary from '../components/DtCallDownloadSummary'
import DtCoverageMap from '../components/DtCoverageMap'
import { DT_SESSION_HISTORY_PATH } from '../constants/opaqueRoutes'
import { subsampleForMap } from '../lib/dtBands'
import { computeSessionMeta, csvTextToRows, haversineKm, parseTemplateRows } from '../lib/dtTemplateParser'
import { trpaAnalyzeFile, trpaSummarizeCallEvents, trpaSummarizeDownloadEvents, type TrpaEventRow, type TrpaRow } from '../lib/trpAnalysis'
import { readXlsxRowsForTech } from '../lib/xlsxReader'

// Sends a large DT session's samples in bounded batches instead of one
// giant POST (2026-08-14 fix — a real 25-file .trp upload produced
// 363,082 samples and hit "Could not save this session (HTTP 413)": the
// single JSON body was well past nginx's default 1MB cap, and even with
// that cap raised, a single request validating 300k+ nested items in DRF
// risks the request just timing out instead. MUST match the backend's
// own DT_SAMPLES_BATCH_SIZE (core/serializers.py) — that constant is
// enforced server-side too (both on create() and the append action), so
// a mismatch here would just mean more/fewer round trips, not a
// correctness bug, but keeping them equal avoids pointless small-batch
// overhead.
const SAMPLES_BATCH_SIZE = 5000

// Split out of the former single-page DtDataManagerPage.tsx (2026-08-09
// request: "manage upload, manage session and explore in different sub
// menu item... not in different tab on same page") — this page is just
// the old 'upload' tab's content, now its own route. See
// DtSessionHistoryPage.tsx/DtExplorePage.tsx for the other two former
// tabs, and App.tsx for how the three are grouped back together under
// one "DT Data Manager" parent menu item via MenuSectionGate.

// Best-effort district resolver for auto-naming, ported from v1's
// `_resolveDtDistrict()` (bts_monitor.html ~7581-7611) — but only its
// tier-2 fallback (nearest real Site's `district` field by haversine
// distance from the upload's GPS centroid). v1's tier-1 is a real point-
// in-polygon check against `NEPAL_DISTRICT_BOUNDARIES`, a large embedded
// dataset that only covers 30 of 77 districts (see project memory
// project_rsrp_2g3g_boundary_features) and hasn't been ported into v2 at
// all (that's Phase 4d/Explore-by-coordinate territory). Nearest-site-
// district is real data, not fabricated — just a coarser approximation
// than a real polygon would give near a district border.
function resolveDistrict(samples: DtSample[], sites: SiteListItem[]): string | null {
  const withGps = samples.filter((s) => s.lat != null && s.lng != null)
  if (!withGps.length || !sites.length) return null
  const cLat = withGps.reduce((sum, s) => sum + (s.lat as number), 0) / withGps.length
  const cLng = withGps.reduce((sum, s) => sum + (s.lng as number), 0) / withGps.length
  let best: SiteListItem | null = null
  let bestDist = Infinity
  for (const s of sites) {
    if (s.lat == null || s.lng == null || !s.district) continue
    const d = haversineKm(cLat, cLng, s.lat, s.lng)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  return best?.district ?? null
}

// .trp binary upload (2026-08-14, "add feature to upload multiple .trp
// file (4g,3g,2g) and extract data and save it as session as working in
// v1. but... donot erase any data"). Reuses lib/trpAnalysis.ts's
// trpaAnalyzeFile() — built earlier for the read-only TRP File Analysis
// diagnostic page — as the actual decoder, rather than writing a second
// .trp parser. That engine auto-detects each file's technology (4G/3G/2G)
// from its own declarations.cdf, so files don't need to be pre-sorted by
// tech before upload the way the CSV/XLSX template path requires.
//
// v1 parity note: v1's own .trp upload (rsrpHandleTrpFiles) only ever
// merges an ENTIRE batch into one session using the first file's detected
// tech — a multi-tech batch gets silently mislabeled (see bts_monitor.html
// ~7799-7806). This port is deliberately more correct: files are grouped
// by their OWN detected tech first, so a mixed 4G+2G batch produces one 4G
// session and one 2G session rather than one mislabeled session — this is
// the "(4g,3g,2g)" part of the request, not a corner case to special-case
// away.
//
// "donot erase any data" — the actual save path per grouped session is
// createSession.mutateAsync(...) → POST /api/v2/dt-sessions/, the exact
// same additive-only call the CSV/XLSX template path already uses below.
// The backend contract has no bulk-replace/erase operation at all (only
// single-row Create/Destroy — see DriveTestSessionViewSet); the only way
// an existing session is ever removed here is the same single-session,
// user-confirmed "Replace Old" duplicate dialog already used by the
// template path, applied per detected-duplicate group. No code path in
// this feature can touch a session it didn't just create or that the user
// didn't just explicitly pick "Replace Old" for.
const NEPAL_BOUNDS = { latMin: 26, latMax: 31, lngMin: 79, lngMax: 89 }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function int(v: unknown): number | null {
  const n = num(v)
  return n != null ? Math.round(n) : null
}

/** Maps one decoded TRP serving-cell sample (TrpaRow, keyed by trpAnalysis's
 * per-tech field dictionary) into the fixed DriveTestSample schema. `rsrp`
 * always carries the generic dBm-scale signal reading regardless of tech —
 * same convention dtTemplateParser.ts's parseTemplateRows uses. Only
 * serving-cell readings are converted (not neighbor sightings) — v1's
 * neighbor-cell PCI-to-site labeling (_rsrpMatchServingCell) depends on a
 * full site/sector/azimuth lookup that hasn't been ported into v2 at all;
 * carrying neighbor rows through with no site label would just be
 * unlabeled noise on the coverage map, so this stays serving-only, matching
 * what the CSV/XLSX template path has always produced. Returns null for a
 * sample missing GPS, outside Nepal's bounds, or missing its primary
 * signal reading (same fail-open-per-record behavior v1's saveDtSession
 * uses, not a fail-the-whole-file error). */
function trpRowToDtSample(row: TrpaRow, tech: DtTech): DtSample | null {
  const lat = row.lat
  const lng = row.lon
  if (lat == null || lng == null) return null
  if (lat < NEPAL_BOUNDS.latMin || lat > NEPAL_BOUNDS.latMax || lng < NEPAL_BOUNDS.lngMin || lng > NEPAL_BOUNDS.lngMax) return null

  let primary: number | null = null
  let rsrq: number | null = null
  let sinr: number | null = null
  let pci: number | null = null
  let dl: number | null = null
  let rxQual: number | null = null
  let bcch: number | null = null
  let bsic: number | null = null
  let rscp: number | null = null
  let ecno: number | null = null
  let scr: number | null = null

  if (tech === '4G') {
    primary = num(row.rsrp)
    rsrq = num(row.rsrq)
    sinr = num(row.sinr)
    pci = int(row.pci)
    // Real DL throughput, when TEMS declared it — a genuine field this
    // engine confirmed against a real 4G DL capture (see trpAnalysis.ts's
    // module comment), not the never-verified extraction CLAUDE.md flags
    // as broken in v1's own binary decoder.
    dl = num(row.pdschThroughput)
  } else if (tech === '3G') {
    primary = num(row.rscp)
    rscp = primary
    ecno = num(row.ecno)
    scr = int(row.scramblingCode)
  } else {
    primary = num(row.rssiFull) ?? num(row.rssiSub)
    rxQual = num(row.rxQualFull) ?? num(row.rxQualSub)
    bcch = int(row.bcch)
    bsic = int(row.bsic)
  }
  if (primary == null) return null

  return {
    ts: row.isoTs,
    date: row.isoTs.slice(0, 10),
    lat, lng,
    rsrp: primary,
    rsrq, sinr, dl, pci,
    serving_site_id: null,
    serving_site_name: null,
    serving_sector: null,
    serving_cell_name: null,
    serving_local_cell_id: null,
    serving_dist_km: null,
    cell_role: 'serving',
    rx_qual: rxQual,
    bcch, bsic, rscp, ecno,
    scrambling_code: scr,
  }
}

interface PendingTrpSession {
  tech: DtTech
  samples: DtSample[]
  // DtSessionMeta, not ReturnType<typeof computeSessionMeta> — this now
  // gets an `events` key merged in afterward (see buildTrpSessions below)
  // that computeSessionMeta's own fixed return shape doesn't declare.
  meta: DtSessionMeta
  sessionName: string
  driveTestDate: string
  sourceFiles: string[]
  // How many raw radio samples the decoder actually found across all of
  // this tech's source file(s), before the group-level cap in
  // buildTrpSessions below (if it even triggered) cut it down to what's
  // in `samples` — shown in the review UI so any reduction is visible,
  // never silent.
  rawDecodedCount: number
  // Whether TRP_SAVE_SAMPLE_CAP actually triggered for this session
  // (2026-08-17 fix — see TRP_SAVE_SAMPLE_CAP's comment). rawDecodedCount
  // can legitimately be larger than samples.length for a totally
  // different, unrelated reason: trpRowToDtSample() returns null for any
  // raw row missing valid GPS or a valid signal reading, and that
  // filtering happens regardless of the cap. Without this flag the
  // review-screen note below can't tell "some rows lacked usable data"
  // apart from "this session was actually thinned," which produced a
  // real, confusing false-positive ("crossed the 50,000-sample cap") on
  // a 168-raw-row session that never got anywhere near the cap.
  wasCapped: boolean
}

// REVISED 2026-08-15 (same day, later): the flat "≤1 sample/sec, every
// upload, no matter how small" decimation this function used to do was
// the direct cause of a follow-up report — "plot from .trp upload is
// giving very less points. need clear plot in dt path" — filed right
// after that fix shipped. The original problem it was solving ("this
// system gives millions of points and takes time to extract and load")
// was real but was specifically about PATHOLOGICAL multi-file/multi-hour
// sessions (the known 363,082-row case) — flatly decimating EVERY
// session, including small/typical single-file tests that never had a
// performance problem, threw away real spatial density and made routes
// look sparse/broken instead of continuous. Two independent problems
// were being solved with one blanket rule; they need different fixes:
//   - render performance (map DOM/canvas cost) is already fully handled,
//     independently, by DtCoverageMap's own subsampleForMap() at draw
//     time (see project_v2_audit_2026_08_15) — that cap doesn't care how
//     many rows are stored, only how many get drawn.
//   - upload/storage size for a genuinely huge multi-file capture is the
//     only thing left needing a save-time cap.
// So decimateTrpRows() is gone; instead buildTrpSessions() below applies
// a single group-level (per tech, AFTER concatenating every source file)
// cap via the same evenly-strided subsampleForMap() the map already
// uses, at a much more generous ceiling — see TRP_SAVE_SAMPLE_CAP. A
// typical single- or few-file test (real samples measured so far top out
// around 1,400 rows per ~40s file) now passes through with its FULL
// decoded density, matching what the user wants ("clear plot"); only a
// combined session actually crossing the cap gets thinned, and even then
// down to a ceiling well above what the map itself would ever draw at
// once. Deliberately still scoped to the DT session save path only — NOT
// inside trpAnalysis.ts's shared engine, which the separate TRP File
// Analysis diagnostic page (TrpAnalysisPage.tsx) also uses and still
// wants every real decoded sample for its own deep per-file stats.
const TRP_SAVE_SAMPLE_CAP = 50000

// Auto-detects which of the standard NTC drive-test types a session is,
// from the SAME structural event evidence trpaSummarizeCallEvents/
// trpaSummarizeDownloadEvents already computed — no separate detection
// logic (2026-08-15, "make it identifiable... during session save": two
// real uploaded 4G sessions from the same date/district both landed as
// "DT_trp_20260611_Chitwan_4G" with nothing to tell them apart in Session
// History). A download-only capture (Data.Ftp.* events, no Call.* events)
// is 'DL'; a call capture on a 4G-classified session is 'Fallback' (a
// voice call test whose overall serving-cell tech reads 4G is, by NTC's
// own real test methodology already described earlier in this
// conversation, the CSFB/fallback test — the call itself falls back to
// 2G/3G mid-call while the surrounding serving-cell samples stay
// predominantly 4G); a call capture on a 2G/3G-classified session is
// 'Voice' (the plain non-fallback voice test). Returns null (no suffix)
// when neither summary is present, matching this feature's existing
// "only label what the log actually contains" convention.
function detectTrpTestType(tech: DtTech, callSummary: DtCallSummary | null, downloadSummary: DtDownloadSummary | null): string | null {
  if (downloadSummary && !callSummary) return 'DL'
  if (callSummary && !downloadSummary) return tech === '4G' ? 'Fallback' : 'Voice'
  if (callSummary && downloadSummary) return 'Mixed'
  return null
}

/** Groups every successfully-parsed .trp file's serving samples by that
 * file's OWN detected tech (see the module comment above for why this
 * differs from v1) and turns each group into one ready-to-review session —
 * auto-named `DT_trp_%dtDate%_%district%_%tech%[_%testType%]`, matching
 * v1's own uploadKind:'trp' naming convention (bts_monitor.html
 * ~5912-5929) with a new test-type suffix appended when detectable (see
 * detectTrpTestType above) — computed client-side here instead of
 * server-side.
 *
 * Also reduces each file's decoded compound events (trpAnalysis.ts's
 * TrpaEventRow) down to `meta.callSummary`/`meta.downloadSummary` — the
 * aggregate KPI counts (attempted/success/drop/rejected/etc., see
 * trpaSummarizeCallEvents/trpaSummarizeDownloadEvents' own comments for
 * exactly how each is derived from real TEMS event structure) rather than
 * the raw per-event list this originally stored (2026-08-15 follow-up:
 * "i need to store only the data like total no. of call attempted...").
 * Events from every file in a tech-group are pooled before summarizing —
 * a "4G Fallback" session built from several .trp files gets one combined
 * call summary across all of them, same as its GPS/signal stats already
 * are. */
function buildTrpSessions(
  results: { fileName: string; tech: DtTech; servingRows: TrpaRow[]; events: TrpaEventRow[] }[],
  sites: SiteListItem[],
): PendingTrpSession[] {
  const byTech = new Map<DtTech, { samples: DtSample[]; files: string[]; events: TrpaEventRow[]; rawDecodedCount: number }>()
  for (const { fileName, tech, servingRows, events } of results) {
    // Full fidelity here — no per-file decimation. See TRP_SAVE_SAMPLE_CAP
    // comment above: any needed reduction happens once, below, at the
    // combined-tech-group level.
    const samples = servingRows
      .map((r) => trpRowToDtSample(r, tech))
      .filter((s): s is DtSample => s != null)
    if (!samples.length) continue
    const grp = byTech.get(tech) ?? { samples: [], files: [], events: [], rawDecodedCount: 0 }
    grp.samples.push(...samples)
    grp.files.push(fileName)
    grp.events.push(...events)
    grp.rawDecodedCount += servingRows.length
    byTech.set(tech, grp)
  }
  const order: DtTech[] = ['4G', '3G', '2G']
  const sessions: PendingTrpSession[] = []
  for (const tech of order) {
    const grp = byTech.get(tech)
    if (!grp) continue
    // Sort chronologically first so an evenly-strided cap (if it triggers)
    // still preserves the route's full geographic extent instead of
    // favoring whichever file happened to be concatenated first.
    const chronological = [...grp.samples].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    const wasCapped = chronological.length > TRP_SAVE_SAMPLE_CAP
    const samples = subsampleForMap(chronological, TRP_SAVE_SAMPLE_CAP)
    const meta: DtSessionMeta = computeSessionMeta(samples, grp.files)
    const callSummary = trpaSummarizeCallEvents(grp.events)
    if (callSummary) meta.callSummary = callSummary
    const downloadSummary = trpaSummarizeDownloadEvents(grp.events)
    if (downloadSummary) meta.downloadSummary = downloadSummary
    const testType = detectTrpTestType(tech, callSummary, downloadSummary)
    if (testType) meta.testType = testType
    const dtDates = grp.samples.map((s) => (s.ts ? s.ts.slice(0, 10) : null)).filter((d): d is string => !!d)
    const driveTestDate = dtDates.length ? dtDates.sort().pop()! : new Date().toISOString().slice(0, 10)
    const district = resolveDistrict(grp.samples, sites) ?? 'Unknown'
    const sessionName = `DT_trp_${driveTestDate.replace(/-/g, '')}_${district.replace(/\s+/g, '')}_${tech}${testType ? `_${testType}` : ''}`
    sessions.push({ tech, samples, meta, sessionName, driveTestDate, sourceFiles: grp.files, rawDecodedCount: grp.rawDecodedCount, wasCapped })
  }
  return sessions
}

type DupAction = 'cancel' | 'keep' | 'replace'

// Header + sample rows per tech for the downloadable template. Columns:
// [S.N, Time, Date, Latitude, Longitude, ...signal columns].
// Two real corrections made to this template in one day (2026-07-28):
// 1. Switched from a combined "DateTime" column to separate Time/Date —
//    the DateTime version round-tripped fine through the parser but
//    displayed wrong once reopened in Excel.
// 2. Even with separate columns, Excel STILL mis-displays a raw
//    "12:59:07.500"-style Time cell on open — it auto-detects the cell as
//    a time/duration value and reformats it down to just "59:07.5",
//    silently dropping the hour. Confirmed by the user re-downloading and
//    reopening the template. Standard fix: prefix Time/Date cells with a
//    leading apostrophe in the CSV text, which tells Excel "this is
//    literal text, don't auto-convert it" — same trick spreadsheet tools
//    have used forever for exactly this class of problem. Applied in
//    `downloadTemplate()` below. `parseTemplateRows` (dtTemplateParser.ts)
//    strips a leading apostrophe before parsing, so the prefixed template
//    still round-trips correctly if re-uploaded as-is.
// 3. 2G/3G column names updated to match the user's real reference
//    format exactly ("Agg. Active RSCP (dBm)"/"Agg. Active Ec/Io (dB)"
//    for 3G, "RxLevSub (dBm) - .Server"/"RxQual Sub" for 2G) — traced by
//    hand through the existing flexible substring matcher and both new
//    names already match correctly (e.g. "aggactivercscpdbm".includes
//    ("rscp")), so no parser changes were needed, only the template text.
//    Scrambling Code / BCCH / BSIC dropped from the 3G/2G templates since
//    the user's real reference format doesn't carry them — still parsed
//    if present in a real upload (optional fields), just not shown here.
const TEMPLATES: Record<DtTech, { header: string[]; sample: string[][]; fname: string }> = {
  '4G': {
    header: ['S.N', 'Time', 'Date', 'Latitude', 'Longitude', 'Serving Cell RSRP (dBm)', 'Serving Cell RSRQ (dB)', 'Serving Cell RS SINR (dB)'],
    sample: [
      ['1', '4:24:57.000', '6/12/2026', '27.0234980', '84.8843140', '-74.9', '-8.0', '10.0'],
      ['2', '4:24:59.000', '6/12/2026', '27.0234980', '84.8843140', '-74.8', '-8.7', '10.2'],
    ],
    fname: 'dt_import_template_4g.csv',
  },
  '3G': {
    header: ['S.N', 'Time', 'Date', 'Latitude', 'Longitude', 'Agg. Active RSCP (dBm)', 'Agg. Active Ec/Io (dB)'],
    sample: [
      ['1', '12:59:07.500', '6/11/2026', '28.22957075', '83.94927798', '-101.33', '-10.13'],
      ['2', '12:59:08.500', '6/11/2026', '28.22957075', '83.94927798', '-102.75', '-11.55'],
    ],
    fname: 'dt_import_template_3g.csv',
  },
  '2G': {
    header: ['S.N', 'Time', 'Date', 'Latitude', 'Longitude', 'RxLevSub (dBm) - .Server', 'RxQual Sub'],
    sample: [
      ['1', '17:53:39.000', '7/2/2026', '27.6790895', '85.3496500', '-68.2', '5'],
      ['2', '17:53:41.000', '7/2/2026', '27.6790540', '85.3496300', '-65.9', '5'],
    ],
    fname: 'dt_import_template_2g.csv',
  },
}

// Column indices 1 (Time) and 2 (Date) get a leading apostrophe so Excel
// treats them as literal text instead of auto-converting/truncating them
// as a time or date value on open — see the TEMPLATES comment above.
function csvCell(v: string, colIdx: number): string {
  return colIdx === 1 || colIdx === 2 ? `'${v}` : v
}

function downloadTemplate(tech: DtTech) {
  const t = TEMPLATES[tech]
  const lines = [
    t.header.join(','),
    ...t.sample.map((row) => row.map((v, i) => csvCell(v, i)).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = t.fname
  a.click()
  URL.revokeObjectURL(a.href)
}

type UploadMode = 'template' | 'trp'
type TrpFileStatus = 'pending' | 'analyzing' | 'ok' | 'error'
interface TrpQueueEntry {
  fileName: string
  status: TrpFileStatus
  tech: DtTech | null
  error: string | null
}

export default function DtUploadPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<UploadMode>('template')
  const [tech, setTech] = useState<DtTech>('4G')
  const [sessionName, setSessionName] = useState('')
  const [uploadedFile, setUploadedFile] = useState<{ name: string } | null>(null)
  const [parsedSamples, setParsedSamples] = useState<DtSample[] | null>(null)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [dupPrompt, setDupPrompt] = useState<{ existing: DtSessionListItem; driveTestDate: string; gpsCount: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // .trp upload state (separate from the template state above, on
  // purpose — keeps the already-verified template flow untouched rather
  // than folding both upload kinds into one shared, riskier state shape).
  const [trpQueue, setTrpQueue] = useState<TrpQueueEntry[]>([])
  const [trpSessions, setTrpSessions] = useState<PendingTrpSession[]>([])
  const [trpActiveIdx, setTrpActiveIdx] = useState(0)
  const [trpBusy, setTrpBusy] = useState(false)
  const [trpStatusMsg, setTrpStatusMsg] = useState<string | null>(null)
  const [trpSaveErr, setTrpSaveErr] = useState<string | null>(null)
  const [trpSavedCount, setTrpSavedCount] = useState(0)
  const [trpDupPrompt, setTrpDupPrompt] = useState<{ idx: number; existing: DtSessionListItem; driveTestDate: string; gpsCount: number } | null>(null)
  const trpFileInputRef = useRef<HTMLInputElement>(null)

  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null)

  const qc = useQueryClient()
  const { data: sites } = useSites()
  const { data: sessions } = useDtSessions()
  const createSession = useCreateDtSession()
  const deleteSession = useDeleteDtSession()
  const appendSamples = useAppendDtSamples()
  // True for the whole chunked save sequence, not just the first request
  // — createSession/appendSamples' own isPending flags each go back to
  // false between individual batch requests, which would otherwise make
  // the Save button flicker enabled between batches of a large session.
  const savingBusy = createSession.isPending || appendSamples.isPending || saveProgress !== null

  // Shared by both upload kinds (template + .trp) — creates the session
  // shell (meta is already the FULL, correct aggregate computed
  // client-side from every sample, so the shell alone is enough for the
  // History list to show correct summary stats immediately), then
  // streams the samples in to the append-samples endpoint in
  // SAMPLES_BATCH_SIZE-sized chunks. Small uploads (most template
  // uploads) still round-trip in 1-2 requests total; this only changes
  // behavior for genuinely large sessions like a multi-file .trp batch.
  // If a batch fails partway through, the session already exists with
  // whatever landed before the failure — never touches or removes
  // anything else, same additive-only guarantee as everywhere else in
  // this feature, but the caller should surface that this ONE session
  // may be incomplete (see the callers' catch blocks below).
  async function saveSessionChunked(
    shell: Omit<DtSessionCreate, 'samples'>,
    samples: DtSample[],
  ): Promise<DtSessionDetail> {
    const total = samples.length
    setSaveProgress(total > SAMPLES_BATCH_SIZE ? { done: 0, total } : null)
    const created = await createSession.mutateAsync({ ...shell, samples: samples.slice(0, SAMPLES_BATCH_SIZE) })
    let done = Math.min(SAMPLES_BATCH_SIZE, total)
    if (total > SAMPLES_BATCH_SIZE) setSaveProgress({ done, total })
    for (let i = SAMPLES_BATCH_SIZE; i < total; i += SAMPLES_BATCH_SIZE) {
      const batch = samples.slice(i, i + SAMPLES_BATCH_SIZE)
      await appendSamples.mutateAsync({ id: created.id, samples: batch })
      done = Math.min(i + batch.length, total)
      setSaveProgress({ done, total })
    }
    setSaveProgress(null)
    qc.invalidateQueries({ queryKey: ['dt-sessions'] })
    return created
  }

  const canWrite = !!user && isAllowed(user.role, user.permissions.rsrpmgr, 'write')
  const canReplace = !!user && isAllowed(user.role, user.permissions.rsrpmgr, 'update')

  const meta = useMemo(() => (parsedSamples ? computeSessionMeta(parsedSamples, uploadedFile ? [uploadedFile.name] : []) : null), [parsedSamples, uploadedFile])
  const driveTestDate = useMemo(() => {
    if (!parsedSamples) return ''
    const dates = parsedSamples.map((s) => (s.ts ? s.ts.slice(0, 10) : null)).filter((d): d is string => !!d)
    return dates.length ? dates.sort().pop()! : new Date().toISOString().slice(0, 10)
  }, [parsedSamples])

  function resetUpload() {
    setUploadedFile(null)
    setParsedSamples(null)
    setParseErr(null)
    setSaveErr(null)
    setSavedMsg(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleFile(file: File) {
    setParseErr(null)
    setSavedMsg(null)
    setSaveErr(null)
    try {
      let rows: string[][]
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        const buf = await file.arrayBuffer()
        rows = await readXlsxRowsForTech(buf, tech)
      } else {
        const text = await file.text()
        rows = csvTextToRows(text)
      }
      const records = parseTemplateRows(rows, tech)
      if (!records.length) throw new Error('No valid GPS-tagged rows found in this file.')
      setUploadedFile({ name: file.name })
      setParsedSamples(records)
      // Auto-name every fresh upload — v1 parity (bts_monitor.html's
      // saveDtSession(): `DT_Excel_%dtDate%_%districtname%_%techtype%`
      // for the CSV/XLSX template path). v1 has no manual-name field at
      // all for this upload kind; the field here stays editable
      // afterward, but always starts from the same auto-generated name
      // on a new upload, same as v1's actual behavior — not the raw
      // filename this used to fall back to.
      const dtDates = records.map((r) => (r.ts ? r.ts.slice(0, 10) : null)).filter((d): d is string => !!d)
      const dtDate = dtDates.length ? dtDates.sort().pop()! : new Date().toISOString().slice(0, 10)
      const district = resolveDistrict(records, sites ?? []) ?? 'Unknown'
      setSessionName(`DT_Excel_${dtDate.replace(/-/g, '')}_${district.replace(/\s+/g, '')}_${tech}`)
    } catch (e) {
      setUploadedFile(null)
      setParsedSamples(null)
      setParseErr(e instanceof Error ? e.message : 'Could not parse this file.')
    }
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) handleFile(f)
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.classList.remove('drag-over')
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  // Duplicate detection (ported from v1's saveDtSession, 2026-07-22): a
  // likely re-upload is flagged only when file name(s) + drive-test date +
  // point count ALL match an already-saved session — any one alone isn't
  // enough (see the comment in bts_monitor.html for why). Factored out to
  // `findDuplicateFor` so the .trp upload flow below can reuse the exact
  // same check per detected-tech session group, instead of only the
  // single active template upload.
  function findDuplicateFor(fileKey: string, forDate: string, gpsCount: number): DtSessionListItem | undefined {
    if (!sessions) return undefined
    return sessions.find((s) => {
      const names = s.meta?.fileNames
      const sFileKey = names && names.length ? [...names].sort().join('|') : s.name
      return sFileKey === fileKey && s.date === forDate && s.meta?.gpsCount === gpsCount
    })
  }
  function findDuplicate(): DtSessionListItem | undefined {
    if (!meta) return undefined
    const fileKey = uploadedFile ? uploadedFile.name : sessionName
    return findDuplicateFor(fileKey, driveTestDate, meta.gpsCount)
  }

  async function doSave() {
    if (!parsedSamples || !meta) return
    setSaveErr(null)
    setSavedMsg(null)
    try {
      const created = await saveSessionChunked(
        {
          name: sessionName || uploadedFile?.name || 'DT Session',
          tech,
          date: driveTestDate,
          uploaded_date: new Date().toISOString().slice(0, 10),
          meta,
        },
        parsedSamples,
      )
      // Jump to the Session History page with the new session pre-
      // selected (2026-08-09: these were one page/tab before — now
      // separate routes, so a query param stands in for what used to be
      // `setTab('history'); setSelectedSessionId(created.id)`. See
      // DtSessionHistoryPage.tsx, which reads this on mount.
      navigate(`${DT_SESSION_HISTORY_PATH}?session=${created.id}`)
      resetUpload()
      setSessionName('')
    } catch (e) {
      setSaveProgress(null)
      setSaveErr(apiErrorMessage(e, 'Could not save the session — if some batches already landed, the partial session is visible (and removable) from Session History rather than silently lost.'))
    }
  }

  async function handleSaveClick() {
    const dup = findDuplicate()
    if (dup && meta) {
      setDupPrompt({ existing: dup, driveTestDate, gpsCount: meta.gpsCount })
      return
    }
    await doSave()
  }

  async function resolveDup(action: DupAction) {
    const dup = dupPrompt
    setDupPrompt(null)
    if (action === 'cancel' || !dup) return
    if (action === 'replace') {
      try {
        await deleteSession.mutateAsync(dup.existing.id)
      } catch (e) {
        setSaveErr(apiErrorMessage(e, 'Could not remove the old session.'))
        return
      }
    }
    await doSave()
  }

  // ── .trp upload flow ──────────────────────────────────────────────────
  async function analyzeTrpFiles(fileList: FileList) {
    const files = Array.from(fileList).filter((f) => /\.(trp|nmf)$/i.test(f.name))
    if (!files.length) {
      setTrpStatusMsg('No .trp/.nmf files selected.')
      return
    }
    const entries: TrpQueueEntry[] = files.map((f) => ({ fileName: f.name, status: 'pending', tech: null, error: null }))
    setTrpQueue(entries)
    setTrpSessions([])
    setTrpActiveIdx(0)
    setTrpSaveErr(null)
    setTrpSavedCount(0)
    setTrpBusy(true)
    setTrpStatusMsg(`Analyzing ${files.length} file(s)…`)

    // Sequential (not Promise.all) — same reasoning TrpAnalysisPage.tsx
    // already documents: a large batch shouldn't hold every file's
    // ArrayBuffer in memory at once, and the queue table updates live.
    const working = [...entries]
    const okResults: { fileName: string; tech: DtTech; servingRows: TrpaRow[]; events: TrpaEventRow[] }[] = []
    for (let i = 0; i < files.length; i++) {
      working[i] = { ...working[i], status: 'analyzing' }
      setTrpQueue([...working])
      try {
        const buf = await files[i].arrayBuffer()
        const result = await trpaAnalyzeFile(buf, files[i].name)
        working[i] = { ...working[i], status: 'ok', tech: result.tech }
        okResults.push({ fileName: files[i].name, tech: result.tech, servingRows: result.servingRows, events: result.events })
      } catch (e) {
        working[i] = { ...working[i], status: 'error', error: e instanceof Error ? e.message : String(e) }
      }
      setTrpQueue([...working])
    }
    setTrpBusy(false)
    const failCount = working.filter((r) => r.status === 'error').length
    if (!okResults.length) {
      setTrpStatusMsg(`All ${files.length} file(s) failed to parse — see status above.`)
      return
    }
    const built = buildTrpSessions(okResults, sites ?? [])
    if (!built.length) {
      setTrpStatusMsg('File(s) parsed, but no valid Nepal-bounded GPS+signal samples were extracted from any of them.')
      return
    }
    setTrpSessions(built)
    setTrpActiveIdx(0)
    setTrpStatusMsg(
      (failCount ? `Parsed ${okResults.length}/${files.length} file(s) — ${failCount} failed. ` : '') +
        `${built.length} session${built.length > 1 ? 's' : ''} ready to review below (grouped by detected technology).`,
    )
  }

  function onTrpFileInput(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length) analyzeTrpFiles(e.target.files)
  }
  function onTrpDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.classList.remove('drag-over')
    if (e.dataTransfer.files && e.dataTransfer.files.length) analyzeTrpFiles(e.dataTransfer.files)
  }
  function resetTrpUpload() {
    setTrpQueue([])
    setTrpSessions([])
    setTrpActiveIdx(0)
    setTrpSaveErr(null)
    setTrpStatusMsg(null)
    setTrpSavedCount(0)
    if (trpFileInputRef.current) trpFileInputRef.current.value = ''
  }
  function updateActiveTrpName(name: string) {
    setTrpSessions((prev) => prev.map((s, i) => (i === trpActiveIdx ? { ...s, sessionName: name } : s)))
  }

  // Saves ONE grouped session — via saveSessionChunked (additive-only,
  // batched for large sessions, see that function's own comment) — then
  // advances to the next one in the queue. Never touches any session
  // besides the one just created; a real 25-file/363k-sample .trp batch
  // is exactly the case saveSessionChunked exists for.
  async function doSaveTrp(idx: number) {
    const s = trpSessions[idx]
    if (!s) return
    setTrpSaveErr(null)
    try {
      await saveSessionChunked(
        {
          name: s.sessionName || `DT Session (${s.tech})`,
          tech: s.tech,
          date: s.driveTestDate,
          uploaded_date: new Date().toISOString().slice(0, 10),
          meta: s.meta,
        },
        s.samples,
      )
      setTrpSavedCount((c) => c + 1)
      setTrpActiveIdx(idx + 1)
    } catch (e) {
      setSaveProgress(null)
      setTrpSaveErr(apiErrorMessage(e, 'Could not save this session — if some batches already landed, the partial session is visible (and removable) from Session History rather than silently lost. Other sessions in this batch are unaffected.'))
    }
  }

  function handleTrpSaveClick(idx: number) {
    const s = trpSessions[idx]
    if (!s) return
    const fileKey = [...s.sourceFiles].sort().join('|')
    // meta.gpsCount is always set here (computeSessionMeta always sets it —
    // see buildTrpSessions) but DtSessionMeta's own type declares it
    // optional (it's a general-purpose untyped-JSON-blob shape), so this
    // narrows with `?? 0` rather than a non-null assertion.
    const gpsCount = s.meta.gpsCount ?? 0
    const dup = findDuplicateFor(fileKey, s.driveTestDate, gpsCount)
    if (dup) {
      setTrpDupPrompt({ idx, existing: dup, driveTestDate: s.driveTestDate, gpsCount })
      return
    }
    doSaveTrp(idx)
  }

  async function resolveTrpDup(action: DupAction) {
    const dup = trpDupPrompt
    setTrpDupPrompt(null)
    if (!dup) return
    if (action === 'cancel') {
      // Skip only this one grouped session — the others in the same
      // batch (e.g. a 2G group alongside a duplicate 4G group) still get
      // reviewed on their own. Matches "Cancel Upload" in the single-file
      // template dialog, just scoped to one item of a queue instead of
      // the whole upload.
      setTrpActiveIdx(dup.idx + 1)
      return
    }
    if (action === 'replace') {
      try {
        await deleteSession.mutateAsync(dup.existing.id)
      } catch (e) {
        setTrpSaveErr(apiErrorMessage(e, 'Could not remove the old session.'))
        return
      }
    }
    await doSaveTrp(dup.idx)
  }

  function skipTrpSession(idx: number) {
    setTrpActiveIdx(idx + 1)
  }

  if (!user) return null

  return (
    <div className="admin-page" style={{ maxWidth: 'none' }}>
      <h1>DT Session Upload</h1>
      <p className="muted">
        {mode === 'template'
          ? 'Upload a CSV/TXT/XLSX drive-test template (Lat/Long/Time/Date or a combined Date-Time column, plus signal columns — column names matched flexibly).'
          : 'Upload one or more TEMS Investigation .trp/.nmf drive-test files — each is decoded and its radio technology (4G/3G/2G) auto-detected, then grouped into one session per technology found. Mixing 4G/3G/2G files in one selection is fine.'}
        {' '}Existing saved sessions are never modified or removed by an upload — a session is only ever deleted if
        you explicitly choose "Replace Old" for a detected duplicate.
      </p>

      {!canWrite && <div className="page-status">You have read-only access to DT sessions.</div>}
      {canWrite && (
        <>
          <div className="feat-tabs" style={{ marginBottom: 10 }}>
            <div className={mode === 'template' ? 'feat-tab active' : 'feat-tab'} onClick={() => setMode('template')}>
              Template (CSV/XLSX)
            </div>
            <div className={mode === 'trp' ? 'feat-tab active' : 'feat-tab'} onClick={() => setMode('trp')}>
              .trp Files (4G/3G/2G)
            </div>
          </div>

          {mode === 'template' && (
            <>
              <div className="report-toolbar">
                <div className="feat-tabs" style={{ borderBottom: 'none' }}>
                  {(['4G', '3G', '2G'] as DtTech[]).map((t) => (
                    <div
                      key={t}
                      className={t === tech ? 'feat-tab active' : 'feat-tab'}
                      onClick={() => {
                        setTech(t)
                        resetUpload()
                      }}
                    >
                      {t}
                    </div>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Session name (auto-filled after upload, editable)"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  style={{ marginLeft: 'auto', minWidth: 220 }}
                />
                <button className="btn-secondary btn-small" type="button" onClick={() => downloadTemplate(tech)}>
                  ⬇ Download {tech} Template
                </button>
              </div>

              <div
                className="dt-drop-zone"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.currentTarget.classList.add('drag-over')
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadedFile ? (
                  <span>{uploadedFile.name}</span>
                ) : (
                  <>
                    <span>Drop a {tech} template CSV/TXT/XLSX here, or click to browse</span>
                    <div className="dt-drop-zone-hint">Recommended header (column names matched flexibly): {TEMPLATES[tech].header.join(', ')}</div>
                  </>
                )}
                <input ref={fileInputRef} type="file" accept=".csv,.txt,.xlsx,.xls" onChange={onFileInput} style={{ display: 'none' }} />
              </div>

              {parseErr && <div className="form-error">{parseErr}</div>}
              {saveErr && <div className="form-error">{saveErr}</div>}
              {savedMsg && <div className="form-success">{savedMsg}</div>}

              {parsedSamples && meta && (
                <>
                  <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                    <div className="report-card">
                      <div className="report-card-val">{meta.gpsCount}</div>
                      <div className="report-card-label">GPS Points</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{meta.routeKm} km</div>
                      <div className="report-card-label">Route Distance</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{meta.avgRsrp ?? '—'}</div>
                      <div className="report-card-label">Avg Signal (dBm)</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{driveTestDate}</div>
                      <div className="report-card-label">Drive-Test Date</div>
                    </div>
                  </div>

                  <DtCoverageMap samples={parsedSamples} tech={tech} />

                  {saveProgress && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                      Saving {saveProgress.done.toLocaleString()} / {saveProgress.total.toLocaleString()} points…
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn-primary" type="button" onClick={handleSaveClick} disabled={savingBusy}>
                      {savingBusy ? 'Saving…' : 'Save Session'}
                    </button>
                    <button className="btn-secondary" type="button" onClick={resetUpload}>
                      Discard
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {mode === 'trp' && (
            <>
              <div
                className="dt-drop-zone"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.currentTarget.classList.add('drag-over')
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
                onDrop={onTrpDrop}
                onClick={() => trpFileInputRef.current?.click()}
              >
                <span>Drop one or more .trp/.nmf files here, or click to browse</span>
                <div className="dt-drop-zone-hint">Technology (4G/3G/2G) is auto-detected per file — no need to sort files first.</div>
                <input ref={trpFileInputRef} type="file" accept=".trp,.nmf" multiple onChange={onTrpFileInput} style={{ display: 'none' }} />
              </div>

              {trpStatusMsg && <div className="page-status">{trpStatusMsg}</div>}
              {trpSaveErr && <div className="form-error">{trpSaveErr}</div>}

              {trpQueue.length > 0 && (
                <details style={{ marginTop: 10 }} open={trpBusy}>
                  <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)' }}>
                    Upload Queue ({trpQueue.length}) — {trpQueue.filter((r) => r.status === 'ok').length} parsed
                    {trpQueue.some((r) => r.status === 'error') ? `, ${trpQueue.filter((r) => r.status === 'error').length} failed` : ''}
                  </summary>
                  <div className="report-table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>File</th>
                          <th>Status</th>
                          <th>Tech</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trpQueue.map((r) => (
                          <tr key={r.fileName}>
                            <td>{r.fileName}</td>
                            <td>
                              {r.status === 'ok' && <span style={{ color: 'var(--status-success)' }}>✓ parsed</span>}
                              {r.status === 'error' && <span title={r.error ?? ''} style={{ color: 'var(--status-danger)', cursor: 'help' }}>✕ {r.error ?? 'failed'}</span>}
                              {(r.status === 'pending' || r.status === 'analyzing') && (
                                <span className="muted">{r.status === 'analyzing' ? '⏳ analyzing…' : 'queued'}</span>
                              )}
                            </td>
                            <td>{r.tech ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {trpSessions.length > 0 && trpActiveIdx < trpSessions.length && (
                <>
                  <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
                    Reviewing session {trpActiveIdx + 1} of {trpSessions.length}
                    {trpSavedCount > 0 ? ` · ${trpSavedCount} already saved this batch` : ''}
                  </div>
                  <div className="report-toolbar">
                    <span style={{ background: 'var(--brand-primary-soft)', color: 'var(--link-accent)', padding: '3px 10px', borderRadius: 999, fontSize: 11 }}>
                      {trpSessions[trpActiveIdx].tech} · from {trpSessions[trpActiveIdx].sourceFiles.length} file(s)
                      {trpSessions[trpActiveIdx].meta.testType ? ` · ${trpSessions[trpActiveIdx].meta.testType}` : ''}
                    </span>
                    <input
                      type="text"
                      value={trpSessions[trpActiveIdx].sessionName}
                      onChange={(e) => updateActiveTrpName(e.target.value)}
                      style={{ marginLeft: 'auto', minWidth: 260 }}
                    />
                  </div>

                  <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                    <div className="report-card">
                      <div className="report-card-val">{trpSessions[trpActiveIdx].meta.gpsCount}</div>
                      <div className="report-card-label">GPS Points</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{trpSessions[trpActiveIdx].meta.routeKm} km</div>
                      <div className="report-card-label">Route Distance</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{trpSessions[trpActiveIdx].meta.avgRsrp ?? '—'}</div>
                      <div className="report-card-label">Avg Signal (dBm)</div>
                    </div>
                    <div className="report-card">
                      <div className="report-card-val">{trpSessions[trpActiveIdx].driveTestDate}</div>
                      <div className="report-card-label">Drive-Test Date</div>
                    </div>
                  </div>

                  {trpSessions[trpActiveIdx].rawDecodedCount > trpSessions[trpActiveIdx].samples.length && (
                    <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                      Decoded {trpSessions[trpActiveIdx].rawDecodedCount.toLocaleString()} raw radio samples from the
                      source file(s); saving {trpSessions[trpActiveIdx].samples.length.toLocaleString()}
                      {trpSessions[trpActiveIdx].wasCapped
                        ? ` (this combined session crossed the ${TRP_SAVE_SAMPLE_CAP.toLocaleString()}-sample save cap, so it was evenly thinned across the full route rather than saved in full — the original .trp file(s) are unaffected).`
                        : ' (the rest had no valid GPS fix and/or no valid signal reading in the source file and were skipped — not a cap, every usable row is saved).'}
                    </div>
                  )}

                  <DtCoverageMap samples={trpSessions[trpActiveIdx].samples} tech={trpSessions[trpActiveIdx].tech} />

                  <DtCallDownloadSummary
                    callSummary={trpSessions[trpActiveIdx].meta.callSummary}
                    downloadSummary={trpSessions[trpActiveIdx].meta.downloadSummary}
                  />

                  {saveProgress && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                      Saving {saveProgress.done.toLocaleString()} / {saveProgress.total.toLocaleString()} points…
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn-primary" type="button" onClick={() => handleTrpSaveClick(trpActiveIdx)} disabled={savingBusy}>
                      {savingBusy ? 'Saving…' : 'Save Session'}
                    </button>
                    <button className="btn-secondary" type="button" onClick={() => skipTrpSession(trpActiveIdx)}>
                      Skip
                    </button>
                  </div>
                </>
              )}

              {trpSessions.length > 0 && trpActiveIdx >= trpSessions.length && (
                <div className="form-success" style={{ marginTop: 12 }}>
                  Done — {trpSavedCount} of {trpSessions.length} session(s) saved from this batch.{' '}
                  <button className="btn-secondary btn-small" type="button" onClick={resetTrpUpload} style={{ marginLeft: 8 }}>
                    Upload More
                  </button>
                  {trpSavedCount > 0 && (
                    <button className="btn-secondary btn-small" type="button" onClick={() => navigate(DT_SESSION_HISTORY_PATH)} style={{ marginLeft: 8 }}>
                      Go to Session History
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {dupPrompt && (
        <div className="modal-overlay show" style={{ zIndex: 500 }}>
          <div className="modal-box" style={{ maxWidth: 440 }}>
            <div className="modal-hdr"><h2>⚠️ Possible Duplicate Session</h2></div>
            <div className="modal-body">
              <p className="muted" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>
                This upload matches an already-saved session on file name, drive-test date, and point count.
              </p>
              <div className="dt-dup-card">
                <div className="dt-dup-card-label">Already Saved</div>
                <div className="dt-dup-card-name">{dupPrompt.existing.name}</div>
                <div className="dt-dup-card-sub">{dupPrompt.existing.date} · {dupPrompt.existing.meta?.gpsCount ?? 0} pts</div>
              </div>
              <div className="dt-dup-card">
                <div className="dt-dup-card-label" style={{ color: '#eab308' }}>New Upload</div>
                <div className="dt-dup-card-name">{sessionName || uploadedFile?.name}</div>
                <div className="dt-dup-card-sub">{dupPrompt.driveTestDate} · {dupPrompt.gpsCount} pts</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary btn-small" onClick={() => resolveDup('cancel')}>Cancel Upload</button>
              <button type="button" className="btn-secondary btn-small" onClick={() => resolveDup('keep')}>Keep Both</button>
              {canReplace && (
                <button type="button" className="btn-danger btn-small" onClick={() => resolveDup('replace')}>Replace Old</button>
              )}
            </div>
          </div>
        </div>
      )}

      {trpDupPrompt && (
        <div className="modal-overlay show" style={{ zIndex: 500 }}>
          <div className="modal-box" style={{ maxWidth: 440 }}>
            <div className="modal-hdr"><h2>⚠️ Possible Duplicate Session</h2></div>
            <div className="modal-body">
              <p className="muted" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>
                This {trpSessions[trpDupPrompt.idx]?.tech} session matches an already-saved session on file name(s),
                drive-test date, and point count. Any other sessions in this batch are unaffected either way.
              </p>
              <div className="dt-dup-card">
                <div className="dt-dup-card-label">Already Saved</div>
                <div className="dt-dup-card-name">{trpDupPrompt.existing.name}</div>
                <div className="dt-dup-card-sub">{trpDupPrompt.existing.date} · {trpDupPrompt.existing.meta?.gpsCount ?? 0} pts</div>
              </div>
              <div className="dt-dup-card">
                <div className="dt-dup-card-label" style={{ color: '#eab308' }}>New Upload</div>
                <div className="dt-dup-card-name">{trpSessions[trpDupPrompt.idx]?.sessionName}</div>
                <div className="dt-dup-card-sub">{trpDupPrompt.driveTestDate} · {trpDupPrompt.gpsCount} pts</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary btn-small" onClick={() => resolveTrpDup('cancel')}>Cancel This One</button>
              <button type="button" className="btn-secondary btn-small" onClick={() => resolveTrpDup('keep')}>Keep Both</button>
              {canReplace && (
                <button type="button" className="btn-danger btn-small" onClick={() => resolveTrpDup('replace')}>Replace Old</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
