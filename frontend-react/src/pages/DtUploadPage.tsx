import type { ChangeEvent, DragEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useCreateDtSession, useDeleteDtSession, useDtSessions, useSites } from '../api/queries'
import type { DtSample, DtSessionListItem, DtTech, SiteListItem } from '../api/types'
import { isAllowed } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import DtCoverageMap from '../components/DtCoverageMap'
import { DT_SESSION_HISTORY_PATH } from '../constants/opaqueRoutes'
import { computeSessionMeta, csvTextToRows, haversineKm, parseTemplateRows } from '../lib/dtTemplateParser'
import { readXlsxRowsForTech } from '../lib/xlsxReader'

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

export default function DtUploadPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tech, setTech] = useState<DtTech>('4G')
  const [sessionName, setSessionName] = useState('')
  const [uploadedFile, setUploadedFile] = useState<{ name: string } | null>(null)
  const [parsedSamples, setParsedSamples] = useState<DtSample[] | null>(null)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [dupPrompt, setDupPrompt] = useState<{ existing: DtSessionListItem; driveTestDate: string; gpsCount: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: sites } = useSites()
  const { data: sessions } = useDtSessions()
  const createSession = useCreateDtSession()
  const deleteSession = useDeleteDtSession()

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
  // enough (see the comment in bts_monitor.html for why).
  function findDuplicate(): DtSessionListItem | undefined {
    if (!sessions || !meta) return undefined
    const fileKey = uploadedFile ? uploadedFile.name : sessionName
    return sessions.find((s) => {
      const names = s.meta?.fileNames
      const sFileKey = names && names.length ? [...names].sort().join('|') : s.name
      return sFileKey === fileKey && s.date === driveTestDate && s.meta?.gpsCount === meta.gpsCount
    })
  }

  async function doSave() {
    if (!parsedSamples || !meta) return
    setSaveErr(null)
    setSavedMsg(null)
    try {
      const created = await createSession.mutateAsync({
        name: sessionName || uploadedFile?.name || 'DT Session',
        tech,
        date: driveTestDate,
        uploaded_date: new Date().toISOString().slice(0, 10),
        meta,
        samples: parsedSamples,
      })
      // Jump to the Session History page with the new session pre-
      // selected (2026-08-09: these were one page/tab before — now
      // separate routes, so a query param stands in for what used to be
      // `setTab('history'); setSelectedSessionId(created.id)`. See
      // DtSessionHistoryPage.tsx, which reads this on mount.
      navigate(`${DT_SESSION_HISTORY_PATH}?session=${created.id}`)
      resetUpload()
      setSessionName('')
    } catch (e) {
      setSaveErr(apiErrorMessage(e, 'Could not save the session.'))
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

  if (!user) return null

  return (
    <div className="admin-page" style={{ maxWidth: 'none' }}>
      <h1>DT Session Upload</h1>
      <p className="muted">
        Upload a CSV/TXT/XLSX drive-test template (Lat/Long/Time/Date or a combined Date-Time column, plus signal
        columns — column names matched flexibly). TRP/GPX binary file upload is a separate follow-up — this covers
        the template path.
      </p>

      {!canWrite && <div className="page-status">You have read-only access to DT sessions.</div>}
      {canWrite && (
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

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn-primary" type="button" onClick={handleSaveClick} disabled={createSession.isPending}>
                  {createSession.isPending ? 'Saving…' : 'Save Session'}
                </button>
                <button className="btn-secondary" type="button" onClick={resetUpload}>
                  Discard
                </button>
              </div>
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
    </div>
  )
}
