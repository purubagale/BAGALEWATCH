import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, apiErrorMessage, apiFetch, apiJson } from '../api/client'
import { useBackupSummary, useSites } from '../api/queries'
import { isAllowed } from '../api/types'
import type { BackupExportPayload, BackupImportResult, BackupRestoreFlags, KpiImportResult, SectorImportResult } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { csvTextToRows } from '../lib/dtTemplateParser'
import { readXlsxRows } from '../lib/xlsxReader'
import { parseKpiRows, parseSectorRows, type ParsedKpiRow, type ParsedSectorRow } from '../lib/siteImportParser'
import { resolveDistrictBackfill, type DistrictBackfillResult } from '../lib/districtBackfill'

/** Backup & Restore — Complete Project (2026-08-05), ported from v1's
 * "Backup & Restore" modal (bts_monitor.html ~1581-1700 for the UI,
 * exportProject()/restoreProject() ~14120-14312 for the logic) — v2 had
 * no equivalent page at all until this request. See core/backup.py's
 * module docstring for the full design rationale (why the export shape
 * reuses TreeState/ThresholdMap/DtBandsMap/SiteDetail rather than
 * inventing a new one, and why restore is superadmin-only even though
 * v1's own version is gated by the finer permissions matrix).
 *
 * **Deliberately not ported**: v1's "GPS Coordinate Update" / "Fix
 * Region Names" bulk-reseed tools, which re-populate lat/lng/district
 * from a 4,703-row GPS dataset baked directly into bts_monitor.html.
 * v2's Site table already comes from the live production database, not
 * a known-incomplete dataset the way v1's original problem was — see
 * the note card below, shown in-product (not just in code comments) so
 * this omission is visible to whoever opens this page, not just
 * whoever reads the source.
 *
 * **New in v2, not in v1**: v1's 3 Excel export buttons always dumped
 * every site, no filter. Per explicit user request, all three now share
 * one scope selector — All Nepal / one Region / one District — derived
 * from the site list already loaded elsewhere in the app (`useSites()`),
 * no extra endpoint needed just to populate the dropdowns. */

type ExportScope = { type: 'all' } | { type: 'region'; region: string } | { type: 'district'; district: string }

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

function filenameFromContentDisposition(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') || ''
  const match = cd.match(/filename="([^"]+)"/)
  return match ? match[1] : fallback
}

async function readFileRows(file: File, sheetHint: string): Promise<string[][]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const buf = await file.arrayBuffer()
    return readXlsxRows(buf, sheetHint)
  }
  const text = await file.text()
  return csvTextToRows(text)
}

type SectorImportTech = '4G' | '3G' | '2G'

/** One self-contained upload slot for a single tech's Sector Data file
 * (2026-08-09, "i have some seperate colums of sector information than
 * 4g... allow seperate upload of sector data for 4g, 3g and 2g rather
 * than using tech type column in single sheet"). Real 3G/2G source
 * spreadsheets have entirely different column layouts from this app's
 * own combined "Sector Data" export (Carrier, Site Band, Cell Active
 * Status columns that don't exist on the 4G side, typo'd Mech/Elec Tilt
 * headers, "Cell ID" instead of "Local Cell ID" — see
 * siteImportParser.ts's alias list, extended to match the real files the
 * user showed) — a single sheet with one Tech column couldn't represent
 * that. Each slot keeps its own file/parse/import state (mirrors what
 * used to be the single sectorRows/sectorFileName/etc. state block on
 * BackupPage itself) and tags every row with its own `tech` on the
 * request body, which core/site_import.py applies uniformly — the
 * uploaded file's own column layout no longer needs to say what tech it
 * is at all, since which of these three slots it was dropped into
 * already says that. */
function SectorImportSlot({ tech, label }: { tech: SectorImportTech; label: string }) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<ParsedSectorRow[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SectorImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError(null)
    setResult(null)
    try {
      const raw = await readFileRows(file, 'sector')
      const records = parseSectorRows(raw)
      if (!records.length) throw new Error('No rows with a Site ID and Cell Name were found in this file.')
      setRows(records)
      setFileName(file.name)
    } catch (err) {
      setRows(null)
      setFileName('')
      setError(err instanceof Error ? err.message : 'Could not parse this file.')
    }
  }

  async function confirmImport() {
    if (!rows) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiJson<SectorImportResult>('/api/v2/backup/import-sites/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'sectors', tech, rows }),
      })
      setResult(res)
      setRows(null)
      setFileName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      qc.invalidateQueries({ queryKey: ['backup-summary'] })
    } catch (err) {
      setError(apiErrorMessage(err, 'Import failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backup-import-col">
      <div className="backup-card-title" style={{ fontSize: 11, marginBottom: 6 }}>{label} (add + update)</div>
      <div className="muted" style={{ fontSize: 9, marginBottom: 8 }}>
        Missing sectors are added as {tech}. An existing sector is updated only if the row's values genuinely
        differ, otherwise left alone. A row for a site that doesn't exist yet is skipped and reported — sites are
        managed by the Live Site Directory sync, not this upload. Column headers are matched flexibly, so this
        doesn't need to match any particular template.
      </div>
      <div
        className="dt-drop-zone"
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add('drag-over')
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('drag-over')
          const f = e.dataTransfer.files[0]
          if (f) handleFile(f)
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        {fileName ? <span>{fileName}</span> : <span>Drop a {tech} Sector Data .xlsx/.csv here, or click to browse</span>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
          }}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      {result && (
        <div className="form-success">
          Added {result.added} sector{result.added === 1 ? '' : 's'}, updated {result.updated}, left unchanged{' '}
          {result.skipped}.
          {result.errors.length > 0 && (
            <div style={{ marginTop: 4, color: '#eab308' }}>{result.errors.slice(0, 5).join(' ')}</div>
          )}
        </div>
      )}
      {rows && (
        <div style={{ marginTop: 10 }}>
          <div className="backup-summary-list" style={{ marginTop: 0 }}>
            <div>Rows parsed: <strong>{rows.length}</strong></div>
            <div className="muted" style={{ fontSize: 10 }}>
              Exact new-vs-duplicate count is determined on the server (existing sectors for each site aren't
              preloaded here).
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                setRows(null)
                setFileName('')
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
            >
              Cancel
            </button>
            <button className="btn-primary btn-small" onClick={confirmImport} disabled={busy}>
              {busy ? 'Importing…' : `Import ${rows.length} sector row${rows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BackupPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { data: summary, isLoading: summaryLoading } = useBackupSummary()
  const { data: sites } = useSites()

  const [scope, setScope] = useState<ExportScope>({ type: 'all' })
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportedInfo, setExportedInfo] = useState<string | null>(null)
  const [xlsxBusy, setXlsxBusy] = useState<string | null>(null)
  const [xlsxError, setXlsxError] = useState<string | null>(null)

  const [loadedBackup, setLoadedBackup] = useState<BackupExportPayload | null>(null)
  const [loadedFileName, setLoadedFileName] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [restoreFlags, setRestoreFlags] = useState<BackupRestoreFlags>({
    sites: true, tree: true, thresholds: true, dt_bands: true,
  })
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoreResult, setRestoreResult] = useState<string[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Site/Sector import (2026-08-05, repurposed 2026-08-26) — see
  // core/site_import.py's module docstring. Originally an add-only Site
  // Details slot (identity: name/region/district/lat/lng); site identity
  // now comes only from the Live Site Directory sync (core/live_sites.py),
  // confirmed via AskUserQuestion: "no need to add site now, only need to
  // add, update sector information, kpi during import." This slot is now
  // an update-only KPI upload instead — matches existing sites by ID,
  // never creates one. Sector Data became THREE slots, one per tech, on
  // 2026-08-09 ("allow seperate upload of sector data for 4g, 3g and
  // 2g") — see SectorImportSlot below; KPI is still the one shared slot
  // here since it has no tech concept of its own.
  const [kpiRows, setKpiRows] = useState<ParsedKpiRow[] | null>(null)
  const [kpiFileName, setKpiFileName] = useState('')
  const [kpiImportError, setKpiImportError] = useState<string | null>(null)
  const [kpiImportBusy, setKpiImportBusy] = useState(false)
  const [kpiImportResult, setKpiImportResult] = useState<KpiImportResult | null>(null)
  const kpiFileInputRef = useRef<HTMLInputElement>(null)

  // Sector Data import state lives in SectorImportSlot now (2026-08-09,
  // "allow seperate upload of sector data for 4g, 3g and 2g") — one
  // instance per tech, each with its own file/parse/import state,
  // instead of a single shared block here.

  // District/region backfill (2026-08-10, "248 unassigned sites...
  // find the district... update in district field") — see
  // lib/districtBackfill.ts's module docstring. `preview` is computed
  // client-side from the already-loaded `sites` list the moment the
  // user clicks Scan; `applyResult` is the server's actual write count,
  // only set after they confirm.
  const [districtPreview, setDistrictPreview] = useState<DistrictBackfillResult | null>(null)
  const [districtBusy, setDistrictBusy] = useState(false)
  const [districtError, setDistrictError] = useState<string | null>(null)
  const [districtApplyResult, setDistrictApplyResult] = useState<{ updated: number; skipped: number } | null>(null)

  function scanDistrictBackfill() {
    setDistrictError(null)
    setDistrictApplyResult(null)
    setDistrictPreview(resolveDistrictBackfill(sites ?? []))
  }

  async function applyDistrictBackfill() {
    if (!districtPreview || districtPreview.updates.length === 0) return
    setDistrictBusy(true)
    setDistrictError(null)
    try {
      const res = await apiJson<{ updated: number; skipped: number }>('/api/v2/backup/backfill-location/', {
        method: 'POST',
        body: JSON.stringify({ updates: districtPreview.updates }),
      })
      setDistrictApplyResult(res)
      setDistrictPreview(null)
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['backup-summary'] })
    } catch (err) {
      setDistrictError(apiErrorMessage(err, 'Backfill failed.'))
    } finally {
      setDistrictBusy(false)
    }
  }

  const regions = useMemo(
    () => Array.from(new Set((sites ?? []).map((s) => s.region).filter(Boolean))).sort(),
    [sites],
  )
  const districts = useMemo(
    () => Array.from(new Set((sites ?? []).map((s) => s.district).filter(Boolean))).sort(),
    [sites],
  )
  if (!user) return null

  const canWrite = isAllowed(user.role, user.permissions.backup, 'write')
  // Restore is hard-gated to superadmin server-side (see
  // core/backup.py's BackupImportView docstring — a deliberate
  // extra-caution deviation from v1's finer matrix gating, matching
  // this app's own most-destructive action, PermissionsMatrixView.put).
  // Shown only to superadmin here too, so an admin whose matrix happens
  // to grant 'backup.update' never sees a button that would just 403.
  const canRestore = user.role === 'superadmin'

  async function handleExportProject() {
    setExportError(null)
    setExportedInfo(null)
    setExportBusy(true)
    try {
      const payload = await apiJson<BackupExportPayload>('/api/v2/backup/export/')
      const json = JSON.stringify(payload, null, 2)
      const now = new Date()
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
      downloadBlob(new Blob([json], { type: 'application/json' }), `DT-WATCH_BTS_v2_Backup_${stamp}.netwatch`)
      setExportedInfo(`Exported ${payload.meta.sitesCount} sites, ${Math.round(json.length / 1024)} KB`)
    } catch (err) {
      setExportError(apiErrorMessage(err, 'Export failed.'))
    } finally {
      setExportBusy(false)
    }
  }

  async function downloadXlsx(kind: 'details' | 'sectors' | 'kpi') {
    setXlsxError(null)
    setXlsxBusy(kind)
    try {
      const params = new URLSearchParams({ kind })
      if (scope.type === 'region') {
        params.set('scope', 'region')
        params.set('region', scope.region)
      } else if (scope.type === 'district') {
        params.set('scope', 'district')
        params.set('district', scope.district)
      } else {
        params.set('scope', 'all')
      }
      const res = await apiFetch(`/api/v2/export/sites.xlsx?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new ApiError(res.status, body)
      }
      const blob = await res.blob()
      downloadBlob(blob, filenameFromContentDisposition(res, `export_${kind}.xlsx`))
    } catch (err) {
      setXlsxError(apiErrorMessage(err, 'Export failed.'))
    } finally {
      setXlsxBusy(null)
    }
  }

  function loadBackupFile(file: File) {
    setLoadError(null)
    setRestoreResult(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(String(e.target?.result)) as BackupExportPayload
        if (data._type !== 'BAGALEWATCH_BTS_V2_BACKUP') {
          setLoadError('Not a valid DT-WATCH v2 backup file.')
          setLoadedBackup(null)
          return
        }
        setLoadedBackup(data)
        setLoadedFileName(file.name)
      } catch {
        setLoadError('Failed to parse backup file — not valid JSON.')
        setLoadedBackup(null)
      }
    }
    reader.readAsText(file)
  }

  async function handleRestore() {
    if (!loadedBackup) return
    setRestoreBusy(true)
    setRestoreError(null)
    setRestoreResult(null)
    try {
      const result = await apiJson<BackupImportResult>('/api/v2/backup/import/', {
        method: 'POST',
        body: JSON.stringify({ data: loadedBackup, restore: restoreFlags }),
      })
      setRestoreResult(result.restored)
      setLoadedBackup(null)
      setLoadedFileName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      // Every page reading sites/tree/thresholds/dt-bands should reflect
      // the restored data without a manual full reload.
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['tree'] })
      qc.invalidateQueries({ queryKey: ['thresholds'] })
      qc.invalidateQueries({ queryKey: ['dt-bands'] })
      qc.invalidateQueries({ queryKey: ['backup-summary'] })
    } catch (err) {
      setRestoreError(apiErrorMessage(err, 'Restore failed.'))
    } finally {
      setRestoreBusy(false)
    }
  }

  async function handleKpiFile(file: File) {
    setKpiImportError(null)
    setKpiImportResult(null)
    try {
      const rows = await readFileRows(file, 'kpi')
      const records = parseKpiRows(rows)
      if (!records.length) throw new Error('No rows with a Site ID were found in this file.')
      setKpiRows(records)
      setKpiFileName(file.name)
    } catch (err) {
      setKpiRows(null)
      setKpiFileName('')
      setKpiImportError(err instanceof Error ? err.message : 'Could not parse this file.')
    }
  }

  async function confirmKpiImport() {
    if (!kpiRows) return
    setKpiImportBusy(true)
    setKpiImportError(null)
    try {
      const result = await apiJson<KpiImportResult>('/api/v2/backup/import-sites/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'kpi', rows: kpiRows }),
      })
      setKpiImportResult(result)
      setKpiRows(null)
      setKpiFileName('')
      if (kpiFileInputRef.current) kpiFileInputRef.current.value = ''
      qc.invalidateQueries({ queryKey: ['sites'] })
      qc.invalidateQueries({ queryKey: ['backup-summary'] })
    } catch (err) {
      setKpiImportError(apiErrorMessage(err, 'Import failed.'))
    } finally {
      setKpiImportBusy(false)
    }
  }

  return (
    <div className="admin-page">
      <h1>Backup & Restore — Complete Project</h1>

      {/* ── Export Project ── */}
      <div className="backup-card">
        <div className="backup-card-hdr">
          <div>
            <div className="backup-card-title">📤 Export Project</div>
            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
              Downloads a single <code>.netwatch</code> file containing sites, sectors, KPI data, tree structure,
              thresholds, and band colors. Copy this file to restore on another system.
            </div>
          </div>
          {canWrite && (
            <button className="btn-primary" onClick={handleExportProject} disabled={exportBusy}>
              {exportBusy ? 'Exporting…' : '⬇ Export Now'}
            </button>
          )}
        </div>
        {exportError && <div className="form-error">{exportError}</div>}
        {exportedInfo && <div className="form-success">{exportedInfo}</div>}
        {!summaryLoading && summary && (
          <div className="backup-summary-list">
            <div>Sites in system: <strong>{summary.sites}</strong></div>
            <div>Sectors total: <strong>{summary.sectors}</strong></div>
            <div>Sites with KPI data: <strong>{summary.sites_with_kpi}</strong></div>
            <div>Tree structure: <strong>{summary.tree_custom ? 'Custom (province/district)' : 'Default regional'}</strong></div>
            <div>Thresholds: <strong>{summary.thresholds_count} configured</strong></div>
            <div>Band colors: <strong>{summary.dt_bands_count} bands defined</strong></div>
          </div>
        )}
      </div>

      {/* ── Note: GPS Coordinate Update / Fix Region Names not ported ── */}
      <div className="backup-note-card">
        ℹ v1's <strong>GPS Coordinate Update</strong> / <strong>Fix Region Names</strong> bulk-reseed tools aren't
        included here — those re-populate lat/lng/district from a 4,703-row dataset embedded in v1's HTML file, meant
        to fix known-incomplete site data. v2's Site table already comes from the live production database, not a
        stale dataset. See "Fix Missing District/Region" below for the actual gap this real deployment did hit.
      </div>

      {/* ── Fix Missing District/Region (2026-08-10) ── */}
      {canWrite && (
        <div className="backup-card">
          <div className="backup-card-title">🧭 Fix Missing District/Region</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
            A site created purely from a Sector Data upload (a row naming a site that doesn't exist yet — see the
            Sector Data cards below) only ever gets an ID and GPS coordinates, no district/region — which is why it
            shows up under "Unassigned" in the Sites tree. This scans every site with a blank district, resolves it
            from its own GPS location against Nepal's real district boundaries, and only fills in what's currently
            blank — an existing district or region is never overwritten.
          </div>
          <button type="button" className="btn-primary btn-small" onClick={scanDistrictBackfill} disabled={!sites}>
            Scan for sites missing a district
          </button>
          {districtError && <div className="form-error" style={{ marginTop: 10 }}>{districtError}</div>}
          {districtApplyResult && (
            <div className="form-success" style={{ marginTop: 10 }}>
              Updated {districtApplyResult.updated} site{districtApplyResult.updated === 1 ? '' : 's'}
              {districtApplyResult.skipped > 0 && `, left ${districtApplyResult.skipped} unchanged (already had a value)`}.
            </div>
          )}
          {districtPreview && (
            <div style={{ marginTop: 10 }}>
              <div className="backup-summary-list" style={{ marginTop: 0 }}>
                <div>
                  Can resolve the district for <strong style={{ color: '#4ade80' }}>{districtPreview.updates.length}</strong>{' '}
                  site{districtPreview.updates.length === 1 ? '' : 's'}.
                </div>
                <div className="muted" style={{ fontSize: 10 }}>
                  Region is filled in too wherever another real site already in the same district has one on
                  record — {districtPreview.updates.filter((u) => u.region).length} of{' '}
                  {districtPreview.updates.length} qualify; the rest get their district fixed only.
                </div>
                {districtPreview.unmatched.length > 0 && (
                  <div className="muted" style={{ fontSize: 10 }}>
                    {districtPreview.unmatched.length} site{districtPreview.unmatched.length === 1 ? '' : 's'} still
                    can't be resolved — no GPS recorded, or their location falls outside the 75 districts with a real
                    boundary on file (most likely Eastern Rukum or Nawalpur). These need a manual fix.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" className="btn-secondary btn-small" onClick={() => setDistrictPreview(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary btn-small"
                  onClick={applyDistrictBackfill}
                  disabled={districtBusy || districtPreview.updates.length === 0}
                >
                  {districtBusy ? 'Applying…' : `Apply to ${districtPreview.updates.length} site${districtPreview.updates.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Excel Export ── */}
      <div className="backup-card">
        <div className="backup-card-title">📊 Export to Excel (.xlsx)</div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Export site data as formatted Excel workbooks, scoped to all of Nepal, one region, or one district.
        </div>
        <div className="backup-scope-row">
          <label className="backup-scope-opt">
            <input type="radio" checked={scope.type === 'all'} onChange={() => setScope({ type: 'all' })} />
            All Nepal
          </label>
          <label className="backup-scope-opt">
            <input
              type="radio"
              checked={scope.type === 'region'}
              onChange={() => setScope({ type: 'region', region: regions[0] ?? '' })}
            />
            Region
            {scope.type === 'region' && (
              <select value={scope.region} onChange={(e) => setScope({ type: 'region', region: e.target.value })}>
                {regions.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            )}
          </label>
          <label className="backup-scope-opt">
            <input
              type="radio"
              checked={scope.type === 'district'}
              onChange={() => setScope({ type: 'district', district: districts[0] ?? '' })}
            />
            District
            {scope.type === 'district' && (
              <select value={scope.district} onChange={(e) => setScope({ type: 'district', district: e.target.value })}>
                {districts.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
          </label>
        </div>
        {xlsxError && <div className="form-error">{xlsxError}</div>}
        <div className="backup-xlsx-grid">
          <div className="backup-xlsx-card">
            <div className="backup-xlsx-card-title">🏢 Site Details</div>
            <div className="muted" style={{ fontSize: 9, marginBottom: 10 }}>
              Site ID · Name · Region · City · Province/District · Latitude · Longitude · Sector Count
            </div>
            <button className="btn-primary btn-small" style={{ width: '100%' }} onClick={() => downloadXlsx('details')} disabled={xlsxBusy !== null}>
              {xlsxBusy === 'details' ? 'Exporting…' : '⬇ Site Details'}
            </button>
          </div>
          <div className="backup-xlsx-card">
            <div className="backup-xlsx-card-title">📡 Sector Data</div>
            <div className="muted" style={{ fontSize: 9, marginBottom: 10 }}>
              Site ID · Cell Name · Sector · Tech · Local Cell ID · Lat/Long · Height · Azimuth · MT · ET · PCI
            </div>
            <button className="btn-primary btn-small" style={{ width: '100%' }} onClick={() => downloadXlsx('sectors')} disabled={xlsxBusy !== null}>
              {xlsxBusy === 'sectors' ? 'Exporting…' : '⬇ Sector Data'}
            </button>
          </div>
          <div className="backup-xlsx-card">
            <div className="backup-xlsx-card-title">📈 Site + KPI Data</div>
            <div className="muted" style={{ fontSize: 9, marginBottom: 10 }}>
              Site ID · Name · Region · RRC SR · E-RAB SR · Call Drop · DL Thru · Cell Avail · PRB · Status
            </div>
            <button className="btn-primary btn-small" style={{ width: '100%' }} onClick={() => downloadXlsx('kpi')} disabled={xlsxBusy !== null}>
              {xlsxBusy === 'kpi' ? 'Exporting…' : '⬇ Site + KPI'}
            </button>
          </div>
        </div>
      </div>

      {/* ── KPI/Sector import ── */}
      {canWrite && (
        <div className="backup-card">
          <div className="backup-card-title">📥 Import KPI & Sectors</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
            Upload an Excel or CSV file — column names are matched flexibly, so this doesn't have to be exactly
            this page's own export templates. Site identity/location (name, province, district, palika, ward,
            lat/long, deployment status, on-air technologies) is managed by the Live Site Directory sync now, not
            by upload — this section only adds/updates KPI values and sector information for sites that already
            exist. Sector Data has a separate upload for each technology (2026-08-09 follow-up) since real
            4G/3G/2G source files commonly use different column layouts — pick the slot that matches the file's
            own technology below.
          </div>
          <div className="backup-import-grid">
            <div className="backup-import-col">
              <div className="backup-card-title" style={{ fontSize: 11, marginBottom: 6 }}>📈 Site KPI (update-only)</div>
              <div className="muted" style={{ fontSize: 9, marginBottom: 8 }}>
                Matches an existing site by Site ID and updates its 4G KPI values. A row for a Site ID that doesn't
                exist is reported, not created — export "Site + KPI Data" above, fill in the "KPI Data" sheet, and
                re-upload it here.
              </div>
              <div
                className="dt-drop-zone"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.currentTarget.classList.add('drag-over')
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
                onDrop={(e) => {
                  e.preventDefault()
                  e.currentTarget.classList.remove('drag-over')
                  const f = e.dataTransfer.files[0]
                  if (f) handleKpiFile(f)
                }}
                onClick={() => kpiFileInputRef.current?.click()}
              >
                {kpiFileName ? <span>{kpiFileName}</span> : <span>Drop a Site + KPI Data .xlsx/.csv here, or click to browse</span>}
                <input
                  ref={kpiFileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleKpiFile(f)
                  }}
                />
              </div>
              {kpiImportError && <div className="form-error">{kpiImportError}</div>}
              {kpiImportResult && (
                <div className="form-success">
                  Updated {kpiImportResult.updated}, left unchanged {kpiImportResult.skipped}.
                  {kpiImportResult.errors.length > 0 && (
                    <div style={{ marginTop: 4, color: '#eab308' }}>{kpiImportResult.errors.slice(0, 5).join(' ')}</div>
                  )}
                </div>
              )}
              {kpiRows && (
                <div style={{ marginTop: 10 }}>
                  <div className="backup-summary-list" style={{ marginTop: 0 }}>
                    <div>Rows parsed: <strong>{kpiRows.length}</strong></div>
                    <div className="muted" style={{ fontSize: 10 }}>
                      Which sites actually exist (and so get updated) is determined on the server.
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                    <button
                      className="btn-secondary btn-small"
                      onClick={() => {
                        setKpiRows(null)
                        setKpiFileName('')
                        if (kpiFileInputRef.current) kpiFileInputRef.current.value = ''
                      }}
                    >
                      Cancel
                    </button>
                    <button className="btn-primary btn-small" onClick={confirmKpiImport} disabled={kpiImportBusy}>
                      {kpiImportBusy ? 'Importing…' : `Import ${kpiRows.length} KPI row${kpiRows.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 2026-08-09, "allow seperate upload of sector data for 4g,
                3g and 2g rather than using tech type column in single
                sheet" — three independent slots instead of one shared
                Sector Data column; see SectorImportSlot's own docstring
                above for why. */}
            <SectorImportSlot tech="4G" label="📡 4G Sector Data" />
            <SectorImportSlot tech="3G" label="📡 3G Sector Data" />
            <SectorImportSlot tech="2G" label="📡 2G Sector Data" />
          </div>
        </div>
      )}

      {/* ── Restore Project ── */}
      {canRestore && (
        <div className="backup-card">
          <div className="backup-card-title">📥 Restore Project</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
            Select a <code>.netwatch</code> file to restore. Choose what to restore — existing data will be{' '}
            <strong style={{ color: '#eab308' }}>replaced</strong> by the backup. This cannot be undone.
          </div>

          <div
            className="dt-drop-zone"
            onDragOver={(e) => {
              e.preventDefault()
              e.currentTarget.classList.add('drag-over')
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
            onDrop={(e) => {
              e.preventDefault()
              e.currentTarget.classList.remove('drag-over')
              const f = e.dataTransfer.files[0]
              if (f) loadBackupFile(f)
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            {loadedFileName ? (
              <span>{loadedFileName}</span>
            ) : (
              <span>Drop a .netwatch file here, or click to browse</span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".netwatch,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadBackupFile(f)
              }}
            />
          </div>

          {loadError && <div className="form-error">{loadError}</div>}
          {restoreError && <div className="form-error">{restoreError}</div>}
          {restoreResult && <div className="form-success">Restored: {restoreResult.join(', ')}.</div>}

          {loadedBackup && (
            <div style={{ marginTop: 12 }}>
              <div className="backup-summary-list" style={{ marginBottom: 12 }}>
                <div>Created: <strong>{loadedBackup._created ? new Date(loadedBackup._created).toLocaleString('en-GB') : 'Unknown'}</strong></div>
                <div>
                  Sites: <strong>{loadedBackup.meta?.sitesCount ?? 0}</strong> · Sectors:{' '}
                  <strong>{loadedBackup.meta?.sectorsCount ?? 0}</strong> · With KPI:{' '}
                  <strong>{loadedBackup.meta?.kpiCount ?? 0}</strong>
                </div>
                <div>Tree structure: <strong>{loadedBackup.tree ? 'Included' : 'Not in backup'}</strong></div>
                <div>Thresholds: <strong>{loadedBackup.thresholds ? 'Included' : 'Not in backup'}</strong></div>
                <div>Band colors: <strong>{loadedBackup.dt_bands ? 'Included' : 'Not in backup'}</strong></div>
              </div>

              <div style={{ fontSize: 10, fontWeight: 700, color: '#9aa4b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                What to restore:
              </div>
              <div className="backup-restore-grid">
                <label className="backup-restore-opt">
                  <input
                    type="checkbox"
                    checked={restoreFlags.sites}
                    onChange={(e) => setRestoreFlags((f) => ({ ...f, sites: e.target.checked }))}
                  />
                  Sites, Sectors & KPI Data
                </label>
                <label className="backup-restore-opt">
                  <input
                    type="checkbox"
                    checked={restoreFlags.tree}
                    onChange={(e) => setRestoreFlags((f) => ({ ...f, tree: e.target.checked }))}
                  />
                  Province/District Tree Structure
                </label>
                <label className="backup-restore-opt">
                  <input
                    type="checkbox"
                    checked={restoreFlags.thresholds}
                    onChange={(e) => setRestoreFlags((f) => ({ ...f, thresholds: e.target.checked }))}
                  />
                  KPI Thresholds
                </label>
                <label className="backup-restore-opt">
                  <input
                    type="checkbox"
                    checked={restoreFlags.dt_bands}
                    onChange={(e) => setRestoreFlags((f) => ({ ...f, dt_bands: e.target.checked }))}
                  />
                  DT Band Colors
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setLoadedBackup(null)
                    setLoadedFileName('')
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                >
                  Cancel
                </button>
                <button className="btn-danger" onClick={handleRestore} disabled={restoreBusy}>
                  {restoreBusy ? 'Restoring…' : '⚠ Restore Selected Data'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
