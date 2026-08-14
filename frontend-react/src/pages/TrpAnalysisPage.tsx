import type { ChangeEvent, DragEvent } from 'react'
import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  trpaAnalyzeFile,
  trpaCombineResults,
  type TrpaCombined,
  type TrpaFileResult,
} from '../lib/trpAnalysis'

// TRP File Analysis (2026-08-11, "Add this feature from v1 as trp file
// analysis in separate submenu in DT data Manager") — deep per-file
// diagnostics for TEMS Investigation .trp drive-test files, ported from
// bts_monitor.html's own "TRP File Analysis" modal. This is a read-only
// diagnostic tool (nothing is saved to the backend, everything happens
// in the browser and is exported as a local file), so — same convention
// as DtExplorePage.tsx, the other read-only DT submenu — there's no
// isAllowed()/canWrite gate inside the page itself; reaching this route
// at all already requires whatever permission the "DT Data Manager"
// parent menu item is gated on (see migration 0028's own docstring).
//
// AI Report tab (v1's 4th tab, narrative summary via an LLM) was
// deliberately NOT ported — v2 has no AI-proxy backend/API key wiring at
// all yet (confirmed via a repo-wide grep before starting this), and
// building that is a separate, non-trivial piece of infrastructure the
// user explicitly chose to defer when asked. Everything else — Summary,
// Serving Timeseries, Neighbor Sightings, Best Server Comparison, XLSX/
// CSV export, multi-file combining, the opt-in "extract every possible
// field" raw dump — is a full port.

type FileStatus = 'pending' | 'analyzing' | 'ok' | 'error'
interface QueueEntry {
  fileName: string
  file: File
  status: FileStatus
  result: TrpaFileResult | null
  error: string | null
}

const MAX_DISPLAY_ROWS = 500
// Total raw-extraction memory budget is shared across the WHOLE batch
// (not per file) so it stays roughly bounded no matter how many files are
// uploaded — v1 fixed a browser OOM crash (2026-07-24) caused by a
// per-file-only budget that scaled up linearly with file count. Floor of
// 500k cells/file so a large batch still gets some raw detail per file
// rather than shrinking toward zero.
const TOTAL_RAW_CELL_BUDGET = 8000000

function esc(v: unknown): string {
  return v == null ? '' : String(v)
}

interface Column {
  key: string
  label: string
  fmt?: (v: unknown) => string
}

function DataTable({ rows, columns }: { rows: Record<string, unknown>[]; columns: Column[] }) {
  if (!rows.length) {
    return <div className="page-status">No data extracted for this section.</div>
  }
  const shown = rows.slice(0, MAX_DISPLAY_ROWS)
  return (
    <>
      <div className="report-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>{esc(c.fmt ? c.fmt(r[c.key]) : r[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_DISPLAY_ROWS && (
        <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
          Showing first {MAX_DISPLAY_ROWS} of {rows.length.toLocaleString()} rows — use Export for the full combined dataset.
        </div>
      )}
    </>
  )
}

// Excel sheet names: <=31 chars, no \ / ? * [ ] : , must be unique.
function safeSheetName(name: string, used: Set<string>): string {
  let base = String(name || 'file').replace(/\.[^.]+$/, '')
  base = base.replace(/[\\/?*[\]:]/g, '_').trim()
  if (!base) base = 'file'
  if (base.length > 28) base = base.slice(0, 28)
  let candidate = base
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    const suffix = '_' + n
    candidate = base.slice(0, 31 - suffix.length) + suffix
    n++
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function downloadBlob(content: BlobPart, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

function exportXlsx(c: TrpaCombined) {
  const wb = XLSX.utils.book_new()
  const usedSheetNames = new Set(['files_overview', 'combined_summary', 'serving_timeseries', 'neighbor_sightings', 'best_server_comparison', 'notes'])
  let anyRawTruncated = false
  const hasRawData = c.files.some((r) => r.rawPaths && r.rawPaths.length)
  if (hasRawData) {
    for (const r of c.files) {
      if (!r.rawPaths || !r.rawPaths.length) continue
      const sheetName = safeSheetName(r.summary.fileName, usedSheetNames)
      const header = ['timestamp_utc', 'lat', 'lon', ...r.rawPaths]
      const labelRow = ['', '', '', ...r.rawPaths.map((p) => r.rawPathLabels[p] || '')]
      const rawAoa = [
        header,
        labelRow,
        ...r.rawSamples.map((s) => [s.isoTs, s.lat ?? '', s.lon ?? '', ...r.rawPaths.map((p) => (s.values[p] != null ? s.values[p] : ''))]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rawAoa), sheetName)
      if (r.rawTruncated) anyRawTruncated = true
    }
  }

  const filesCols: (keyof TrpaFileResult['summary'])[] = [
    'fileName', 'technology', 'provider', 'gpsFixCount', 'gpsSpanMApprox', 'mobility',
    'servingLevelField', 'servingLevelSamples', 'servingLevelMean', 'servingLevelP10', 'servingLevelMin', 'servingLevelMax',
    'servingQualityField', 'servingQualitySamples', 'servingQualityMean', 'servingQualityP10',
    'distinctServingCellIds', 'servingCellIds', 'distinctNeighborCellsSeen', 'neighborSightingsCompared',
    'neighborSightingsWithin6dBOrStronger', 'maxNeighborAdvantageDb', 'siteClassification', 'unverifiedTech',
  ]
  // autoDiscoveredFields/warnings columns (2026-08-11 robustness upgrade)
  // are appended after the curated summary columns rather than mixed in,
  // so the export stays byte-compatible with what a script consuming the
  // old column order would expect.
  const filesAoa = [
    [...(filesCols as string[]), 'autoDiscoveredServingFields', 'autoDiscoveredNeighborFields', 'warnings'],
    ...c.files.map((r) => [
      ...filesCols.map((k) => r.summary[k] ?? ''),
      r.autoDiscoveredServingKeys.length,
      r.autoDiscoveredNeighborKeys.length,
      r.warnings.join(' | '),
    ]),
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filesAoa), 'Files_Overview')

  const combinedAoa: (string | number | null)[][] = [
    ['Metric', 'Value'],
    ['files_count', c.files.length], ['technologies_present', c.techsPresent.join(', ')],
    ['total_gps_fix_count', c.totalGpsFixCount], ['combined_span_m_approx', c.combinedSpanM],
    ['combined_mobility', c.combinedMobility], ['mean_lat', c.meanLat], ['mean_lon', c.meanLon],
  ]
  for (const tech of c.techsPresent) {
    const t = c.byTech[tech]
    combinedAoa.push([`── ${tech} ──`, ''])
    combinedAoa.push([`${tech}_files_count`, t.filesCount])
    combinedAoa.push([`${tech}_serving_level_field`, t.levelField])
    combinedAoa.push([`${tech}_serving_level_samples`, t.servingSamples])
    combinedAoa.push([`${tech}_serving_level_mean`, t.levelMean])
    combinedAoa.push([`${tech}_serving_level_p10`, t.levelP10])
    combinedAoa.push([`${tech}_serving_level_min`, t.levelMin])
    combinedAoa.push([`${tech}_serving_level_max`, t.levelMax])
    combinedAoa.push([`${tech}_serving_quality_field`, t.qualityField])
    combinedAoa.push([`${tech}_serving_quality_samples`, t.qualitySamples])
    combinedAoa.push([`${tech}_serving_quality_mean`, t.qualityMean])
    combinedAoa.push([`${tech}_serving_quality_p10`, t.qualityP10])
    combinedAoa.push([`${tech}_distinct_serving_cell_ids`, t.distinctServingCellIds])
    combinedAoa.push([`${tech}_serving_cell_ids`, t.servingCellIds])
    combinedAoa.push([`${tech}_distinct_neighbor_cells_seen`, t.distinctNeighborCellsSeen])
    combinedAoa.push([`${tech}_neighbor_sightings_compared`, t.neighborSightingsCompared])
    combinedAoa.push([`${tech}_neighbor_sightings_within_6dB_or_stronger`, t.neighborSightingsWithin6dBOrStronger])
    combinedAoa.push([`${tech}_max_neighbor_advantage_dB`, t.maxNeighborAdvantageDb])
    combinedAoa.push([`${tech}_area_classification`, t.siteClassification])
    combinedAoa.push([`${tech}_unverified_field_mapping`, t.unverifiedTech ? 'YES — no real sample tested' : 'no'])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(combinedAoa), 'Combined_Summary')

  const servingCols = ['sourceFile', 'tech', 'isoTs', 'lat', 'lon', ...c.allServingKeys]
  const servingAoa = [servingCols, ...c.servingRows.map((row) => servingCols.map((k) => (row as Record<string, unknown>)[k] ?? ''))]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(servingAoa), 'Serving_Timeseries')

  const neighborCols = ['sourceFile', 'tech', 'isoTs', 'lat', 'lon', ...c.allNeighborKeys]
  const neighborAoa = [neighborCols, ...c.neighborRows.map((row) => neighborCols.map((k) => (row as Record<string, unknown>)[k] ?? ''))]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(neighborAoa), 'Neighbor_Sightings')

  const compareCols = ['sourceFile', 'tech', 'isoTs', 'neighborId', 'neighborLevel', 'servingLevel', 'servingQuality', 'delta', 'timeGapS', 'strongerByMargin']
  const compareAoa = [compareCols, ...c.bestServerRows.map((row) => compareCols.map((k) => (row as unknown as Record<string, unknown>)[k] ?? ''))]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(compareAoa), 'Best_Server_Comparison')

  const notesAoa: (string | number)[][] = [
    ['Methodology notes and caveats'], [''],
    ['What this workbook contains'],
    [
      'Combined analysis of ' + c.files.length +
        ' TEMS Investigation .trp drive-test file(s) by BAGALEWATCH BTS, covering a drive-test route/area. Each file was decoded independently (declarations.cdf = parameter dictionary, data.cdf = timestamped samples, reverse-engineered — .trp has no public spec) then pooled. Field-path dictionaries for 4G/2G are confirmed against real sample files; 3G/WCDMA is best-effort and unverified.',
    ],
    [''],
    ...(hasRawData
      ? [
          ['Per-file sheets (first ' + c.files.length + ' sheet(s), one per uploaded file)'],
          [
            'Every declared parameter this specific file actually carried data for — not just the curated serving/neighbor set — as a wide table: row 1 is each parameter\'s internal declaration path, row 2 is its human label where TEMS provided one, and every row after that is one timestamped sample with GPS (if available at that instant) and every field\'s value at that moment.' +
              (anyRawTruncated ? ' NOTE: at least one file\'s raw extraction exceeded the memory-safety budget and was truncated to its earliest samples — re-export that file alone if you need the tail end.' : ''),
          ],
          [''],
        ]
      : [
          ['Per-file raw data sheets'],
          ['Not included in this export — "Also extract every possible field per file" was left unchecked before analyzing. The Serving_Timeseries/Neighbor_Sightings sheets below still cover every curated field for every file.'],
          [''],
        ]),
    ['Files_Overview'], ['One row per uploaded file with that file\'s own self-contained statistics — use this to spot outlier files (e.g. one segment much weaker than the rest).'], [''],
    ['Combined_Summary'], ['Rollup statistics pooling ALL files of the same technology together. Never averaged across different technologies (RSRP/RSSI/RSCP are not comparable numbers) — each tech gets its own block.'], [''],
    ['Serving vs Neighbor'],
    ['\'Serving\' = the cell the phone was actually camped/connected on. \'Neighbor\' = other cells the phone detected but did not use. Every row is tagged with its Source File and Tech.'], [''],
    ['Stronger-neighbor flag'],
    ['\'Stronger by >6dB\' = TRUE means a neighbor\'s level exceeded the serving cell\'s level by more than 6 dB at that instant.'], [''],
    ['Area/site classification (best-effort heuristic)'],
    ['Computed per-technology from the pooled data: any neighbor >6dB stronger anywhere -> handover candidate; 3+ distinct neighbor cells with the closest one within 6dB of serving -> multi-cell overlap zone; serving level below a tech-specific weak threshold -> coverage-limited; otherwise -> stable single-server coverage. This is a diagnostic aid, not a network-planning verdict.'],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notesAoa), 'Notes')

  const stamp = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `TRP_Analysis_Combined_${c.files.length}files_${stamp}.xlsx`)
}

function exportCsv(c: TrpaCombined) {
  const rows: (string | number)[][] = [['source_file', 'tech', 'provider', 'role', 'timestamp_utc', 'lat', 'lon', 'parameter', 'parameter_path', 'value']]
  for (const r of c.files) {
    for (const row of r.servingRows) {
      for (const key of r.servingKeysFound) {
        const v = (row as Record<string, unknown>)[key]
        if (v == null) continue
        rows.push([r.summary.fileName, r.tech, r.provider, 'serving', row.isoTs, row.lat ?? '', row.lon ?? '', key, r.fieldPaths.serving[key] || '', v as string | number])
      }
    }
    for (const row of r.neighborRows) {
      for (const key of r.neighborKeysFound) {
        const v = (row as Record<string, unknown>)[key]
        if (v == null) continue
        rows.push([r.summary.fileName, r.tech, r.provider, 'neighbor', row.isoTs, row.lat ?? '', row.lon ?? '', key, r.fieldPaths.neighbor[key] || '', v as string | number])
      }
    }
  }
  const csv = rows
    .map((row) => row.map((v) => {
      const sv = String(v)
      return /[",\n]/.test(sv) ? '"' + sv.replace(/"/g, '""') + '"' : sv
    }).join(','))
    .join('\n')
  const stamp = new Date().toISOString().slice(0, 10)
  downloadBlob(csv, `TRP_SignalData_Combined_${c.files.length}files_${stamp}.csv`, 'text/csv')
}

type Tab = 'serving' | 'neighbor' | 'compare'

export default function TrpAnalysisPage() {
  const [extractRaw, setExtractRaw] = useState(false)
  const [queue, setQueue] = useState<QueueEntry[]>([])
  const [combined, setCombined] = useState<TrpaCombined | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('serving')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function analyzeFiles(fileList: FileList) {
    const files = Array.from(fileList)
    const entries: QueueEntry[] = files.map((f) => ({ fileName: f.name, file: f, status: 'pending', result: null, error: null }))
    setQueue(entries)
    setCombined(null)
    setBusy(true)
    const rawCellBudget = extractRaw ? Math.max(500000, Math.floor(TOTAL_RAW_CELL_BUDGET / Math.max(1, files.length))) : 0
    setStatusMsg(`Analyzing ${files.length} file(s)…` + (extractRaw && files.length > 6 ? ' (full raw extraction is on for a large batch — may be slow/memory-heavy; uncheck the box above if you run into issues)' : ''))

    // Mutated in place + re-set each step so the queue table updates live —
    // same sequential-with-progress approach v1 uses (one file at a time,
    // not Promise.all, so a huge batch doesn't try to hold every file's
    // ArrayBuffer in memory at once).
    const working = [...entries]
    for (let i = 0; i < working.length; i++) {
      working[i] = { ...working[i], status: 'analyzing' }
      setQueue([...working])
      try {
        const buffer = await working[i].file.arrayBuffer()
        const result = await trpaAnalyzeFile(buffer, working[i].fileName, { extractRaw, rawCellBudget })
        working[i] = { ...working[i], status: 'ok', result }
      } catch (err) {
        working[i] = { ...working[i], status: 'error', error: err instanceof Error ? err.message : String(err) }
      }
      setQueue([...working])
    }

    const okResults = working.filter((r) => r.status === 'ok').map((r) => r.result as TrpaFileResult)
    const failCount = working.filter((r) => r.status === 'error').length
    setBusy(false)
    if (!okResults.length) {
      setStatusMsg(`All ${files.length} file(s) failed to analyze — see status column above.`)
      return
    }
    setStatusMsg(null)
    const c = trpaCombineResults(okResults)
    setCombined(c)
    setTab('serving')
    if (failCount) setStatusMsg(`Analyzed ${okResults.length}/${files.length} file(s) — ${failCount} failed (see status above)`)
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length) analyzeFiles(e.target.files)
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.classList.remove('drag-over')
    if (e.dataTransfer.files && e.dataTransfer.files.length) analyzeFiles(e.dataTransfer.files)
  }
  function reset() {
    setQueue([])
    setCombined(null)
    setStatusMsg(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const doneCount = queue.filter((r) => r.status === 'ok').length
  const errCount = queue.filter((r) => r.status === 'error').length

  const servingCols: Column[] = combined
    ? [
        { key: 'sourceFile', label: 'Source File' },
        { key: 'tech', label: 'Tech' },
        { key: 'isoTs', label: 'Timestamp (UTC)' },
        { key: 'lat', label: 'Lat', fmt: (v) => (v != null ? (v as number).toFixed(6) : '') },
        { key: 'lon', label: 'Lon', fmt: (v) => (v != null ? (v as number).toFixed(6) : '') },
        ...combined.allServingKeys.map((k) => ({ key: k, label: k })),
      ]
    : []
  const neighborCols: Column[] = combined
    ? [
        { key: 'sourceFile', label: 'Source File' },
        { key: 'tech', label: 'Tech' },
        { key: 'isoTs', label: 'Timestamp (UTC)' },
        { key: 'lat', label: 'Lat', fmt: (v) => (v != null ? (v as number).toFixed(6) : '') },
        { key: 'lon', label: 'Lon', fmt: (v) => (v != null ? (v as number).toFixed(6) : '') },
        ...combined.allNeighborKeys.map((k) => ({ key: k, label: k })),
      ]
    : []
  const compareCols: Column[] = [
    { key: 'sourceFile', label: 'Source File' },
    { key: 'tech', label: 'Tech' },
    { key: 'isoTs', label: 'Timestamp (UTC)' },
    { key: 'neighborId', label: 'Neighbor ID' },
    { key: 'neighborLevel', label: 'Neighbor Level' },
    { key: 'servingLevel', label: 'Serving Level' },
    { key: 'servingQuality', label: 'Serving Quality' },
    { key: 'delta', label: 'Δ Neighbor−Serving (dB)' },
    { key: 'timeGapS', label: 'Time Gap (s)' },
    { key: 'strongerByMargin', label: 'Stronger by >6dB?', fmt: (v) => (v ? 'TRUE' : 'FALSE') },
  ]

  return (
    <div className="admin-page" style={{ maxWidth: 'none' }}>
      <h1>TRP File Analysis</h1>
      <p className="muted">
        Upload one or more TEMS Investigation (.trp) files from a drive-test route/area — each is decoded
        individually, then combined into one Summary, Serving Timeseries, Neighbor Sightings and Best Server
        Comparison, with a single combined export.
        <br />
        <span style={{ color: 'var(--link-accent)', fontSize: 10 }}>
          ⚡ 4G LTE and 2G GSM (voice/CSFB) field mapping is confirmed against real files; 3G/WCDMA is best-effort
          and unverified.
        </span>
      </p>

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
        <span>Select or drop every .trp file from a drive-test route/area, or click to browse</span>
        <div className="dt-drop-zone-hint">Multiple files supported — each is decoded and analyzed independently, then combined below.</div>
        <input ref={fileInputRef} type="file" accept=".trp,.nmf" multiple onChange={onFileInput} style={{ display: 'none' }} />
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer' }}>
        <input type="checkbox" checked={extractRaw} onChange={(e) => setExtractRaw(e.target.checked)} style={{ cursor: 'pointer' }} />
        Also extract every possible field per file into a raw data sheet (thorough, but memory-heavy — recommended
        only for a handful of files; leave unchecked for a fast, reliable export of many/large files)
      </label>

      {statusMsg && <div className={errCount === queue.length && queue.length > 0 ? 'form-error' : 'page-status'}>{statusMsg}</div>}

      {queue.length > 0 && (
        <details style={{ marginTop: 10 }} open={busy}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)' }}>
            Upload Queue ({queue.length}) — {doneCount} done{errCount ? `, ${errCount} failed` : ''}
          </summary>
          <div className="report-table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Status</th>
                  <th>Tech</th>
                  <th>Samples</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.fileName}>
                    <td>{r.fileName}</td>
                    <td>
                      {r.status === 'ok' && <span style={{ color: 'var(--status-success)' }}>✓ done</span>}
                      {r.status === 'error' && <span style={{ color: 'var(--status-danger)' }}>✕ failed</span>}
                      {(r.status === 'pending' || r.status === 'analyzing') && <span className="muted">{r.status === 'analyzing' ? '⏳ analyzing…' : 'queued'}</span>}
                    </td>
                    <td>{r.result ? r.result.tech : '—'}</td>
                    <td>{r.result ? `${r.result.servingRows.length} serving + ${r.result.neighborRows.length} neighbor` : r.error || '—'}</td>
                    <td>
                      {r.result && r.result.warnings.length > 0 ? (
                        <span title={r.result.warnings.join('\n')} style={{ cursor: 'help' }}>⚠ {r.result.warnings.length}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {combined && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ background: combined.techsPresent.includes('3G') ? 'var(--status-danger-bg-subtle)' : 'var(--brand-primary-soft)', color: combined.techsPresent.includes('3G') ? 'var(--status-danger-text-subtle)' : 'var(--link-accent)', padding: '3px 10px', borderRadius: 999, fontSize: 11 }}>
              {combined.files.length} file(s) · {combined.techsPresent.join(', ')}
              {combined.techsPresent.includes('3G') ? ' (3G unverified)' : ''}
            </span>
            <button type="button" className="btn-secondary btn-small" onClick={reset}>
              ↺ New Analysis
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={() => exportCsv(combined)}>
              ⬇ Export CSV (raw)
            </button>
            <button type="button" className="btn-primary btn-small" onClick={() => exportXlsx(combined)}>
              ⬇ Export XLSX
            </button>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Files ({combined.files.length})</summary>
            <div className="report-table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Tech</th>
                    <th>GPS Fixes</th>
                    <th>Serving Samples</th>
                    <th>Level Mean</th>
                    <th>Classification</th>
                    <th>Auto Fields</th>
                    <th>Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {combined.files.map((r) => {
                    const autoCount = r.autoDiscoveredServingKeys.length + r.autoDiscoveredNeighborKeys.length
                    return (
                      <tr key={r.summary.fileName}>
                        <td>{r.summary.fileName}</td>
                        <td>{r.summary.technology}</td>
                        <td>{r.summary.gpsFixCount}</td>
                        <td>{r.summary.servingLevelSamples}</td>
                        <td>{r.summary.servingLevelMean != null ? `${r.summary.servingLevelMean} ${r.summary.servingLevelUnit}` : '—'}</td>
                        <td>{r.summary.siteClassification}</td>
                        <td>{autoCount > 0 ? `+${autoCount}` : '—'}</td>
                        <td>
                          {r.warnings.length > 0 ? (
                            <span
                              title={r.warnings.join('\n')}
                              style={{ color: 'var(--status-warning-text-subtle, var(--link-accent))', cursor: 'help' }}
                            >
                              ⚠ {r.warnings.length}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>

          <details open style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              Combined Summary — {combined.files.length} file(s), area/route rollup
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '4px 12px', fontSize: 11, margin: '8px 0 10px' }}>
              <div className="muted">Technologies present</div><div>{combined.techsPresent.join(', ')}</div>
              <div className="muted">Total GPS fix count</div><div>{combined.totalGpsFixCount}</div>
              <div className="muted">Combined span / mobility</div><div>{combined.combinedSpanM} m — {combined.combinedMobility}</div>
              <div className="muted">Combined mean location</div><div>{combined.meanLat != null ? `${combined.meanLat}, ${combined.meanLon}` : '—'}</div>
            </div>
            {combined.techsPresent.map((tech) => {
              const t = combined.byTech[tech]
              return (
                <div key={tech} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--link-accent)', margin: '8px 0 4px' }}>
                    {tech} — {t.filesCount} file(s){t.unverifiedTech ? ' ⚠ unverified field mapping' : ''}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '4px 12px', fontSize: 11 }}>
                    <div className="muted">Serving level ({t.levelField}, {t.levelUnit})</div>
                    <div>{t.servingSamples ? `${t.levelMean} mean · p10 ${t.levelP10} · min ${t.levelMin} · max ${t.levelMax} (${t.servingSamples} samples)` : 'no data'}</div>
                    <div className="muted">Serving quality ({t.qualityField}{t.qualityUnit ? `, ${t.qualityUnit}` : ''})</div>
                    <div>{t.qualitySamples ? `${t.qualityMean} mean · p10 ${t.qualityP10} (${t.qualitySamples} samples)` : 'no data'}</div>
                    <div className="muted">Distinct serving cell IDs</div><div>{t.distinctServingCellIds} ({t.servingCellIds || '—'})</div>
                    <div className="muted">Distinct neighbor cells seen</div><div>{t.distinctNeighborCellsSeen}</div>
                    <div className="muted">Neighbor sightings compared</div><div>{t.neighborSightingsCompared}</div>
                    <div className="muted">Neighbor sightings &gt;6dB stronger</div><div>{t.neighborSightingsWithin6dBOrStronger}</div>
                    <div className="muted">Max neighbor advantage</div><div>{t.maxNeighborAdvantageDb != null ? `${t.maxNeighborAdvantageDb} dB` : '—'}</div>
                    <div className="muted">Area classification</div><div>{t.siteClassification}</div>
                  </div>
                </div>
              )
            })}
            {combined.techsPresent.includes('3G') && (
              <div className="form-error" style={{ marginTop: 4 }}>
                ⚠ 3G/WCDMA field-path mapping has not been verified against a real 3G .trp file — treat those
                numbers as best-effort, not confirmed.
              </div>
            )}
          </details>

          <div className="feat-tabs" style={{ marginTop: 14 }}>
            <div className={tab === 'serving' ? 'feat-tab active' : 'feat-tab'} onClick={() => setTab('serving')}>📶 Serving Timeseries</div>
            <div className={tab === 'neighbor' ? 'feat-tab active' : 'feat-tab'} onClick={() => setTab('neighbor')}>📡 Neighbor Sightings</div>
            <div className={tab === 'compare' ? 'feat-tab active' : 'feat-tab'} onClick={() => setTab('compare')}>⚖ Best Server Comparison</div>
          </div>
          <div style={{ marginTop: 10 }}>
            {tab === 'serving' && <DataTable rows={combined.servingRows as unknown as Record<string, unknown>[]} columns={servingCols} />}
            {tab === 'neighbor' && <DataTable rows={combined.neighborRows as unknown as Record<string, unknown>[]} columns={neighborCols} />}
            {tab === 'compare' && <DataTable rows={combined.bestServerRows as unknown as Record<string, unknown>[]} columns={compareCols} />}
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 10 }}>
            {combined.files.length} file(s) · {combined.servingRows.length} serving · {combined.neighborRows.length} neighbor · {combined.bestServerRows.length} compared samples
          </div>
        </>
      )}
    </div>
  )
}
