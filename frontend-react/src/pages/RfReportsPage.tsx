import { useRef, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useConfirmRfReportImport, useDeleteRfReport, useParseRfReport, useRfReports,
  useSites, useUploadRfReportAttachments,
} from '../api/queries'
import type {
  IssueSeverity, RfAntennaChangePreviewRow, RfOptimizationReport, RfOptimizationReportCreate,
  RfRecommendationPreviewRow, RfReportAttachmentCategory, RfReportUnmatchedTable,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import SearchableSelect from '../components/SearchableSelect'
import { ISSUE_SEVERITY_LABELS, ISSUE_SEVERITY_ORDER } from '../lib/issueLabels'

// Vendor RNO (Radio Network Optimization) report importer (2026-09-15
// request: "How can we utilize this report or data of this report in
// our application for network optimization and repository"). See
// RfOptimizationReport's docstring in core/models.py and
// core/rf_reports.py's module docstring for the full design.
//
// Scope, per the user's own explicit choice: only the antenna
// change-log table and the open recommendation tables are parsed into
// structured rows -- NOT the ~30 per-cell KPI pre/post tables the same
// vendor reports also carry. Minutes-of-Meeting content is deliberately
// NOT parsed at all (2026-09-15 follow-up: "should be handled with just
// attachment") -- it's a plain file upload via the attachments section
// below, same as the source .docx itself.
//
// Flow: pick a .docx -> parse-preview (nothing saved yet) -> review/edit
// every detected row and resolve each recommendation to a real Site
// (required -- Issue.site is a mandatory FK, see
// _RecommendationInputSerializer's docstring in serializers.py) ->
// confirm-import persists the report + SectorConfigChange rows + one
// Issue per recommendation. A parse can take a while for real files
// (218-528MB seen) -- python-docx has to open the whole document.

type AntennaRowState = RfAntennaChangePreviewRow & { include: boolean }
type RecommendationRowState = RfRecommendationPreviewRow & {
  include: boolean
  title: string
  description: string
  siteId: string | null
  severity: IssueSeverity
}

const ATTACHMENT_CATEGORY_LABELS: Record<RfReportAttachmentCategory, string> = {
  source: 'Source report',
  mom: 'Minutes of Meeting',
  other: 'Other',
}

export default function RfReportsPage() {
  const { user } = useAuth()
  const canManage = user?.role === 'superadmin' || user?.role === 'admin'

  const { data: reports, isLoading, error } = useRfReports()
  const { data: sites } = useSites()
  const deleteReport = useDeleteRfReport()

  const [showImport, setShowImport] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  if (!canManage) {
    return (
      <div className="admin-page">
        <h1>RF Reports</h1>
        <div className="page-status">Only admins and superadmins can view vendor report imports.</div>
      </div>
    )
  }

  if (isLoading) return <div className="page-status">Loading RF reports…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load RF reports.')}</div>

  return (
    <div className="admin-page">
      <h1>RF Reports</h1>
      <p className="muted">
        Import a vendor Radio Network Optimization report — the antenna change log and open
        recommendation tables become structured records here; everything is reviewed before anything is saved.
      </p>

      {!showImport && (
        <button type="button" className="btn-primary btn-small" onClick={() => setShowImport(true)}>
          + Import a report
        </button>
      )}

      {showImport && (
        <ImportWizard sites={sites ?? []} onDone={() => setShowImport(false)} onCancel={() => setShowImport(false)} />
      )}

      <table className="admin-table" style={{ marginTop: 20 }}>
        <thead>
          <tr>
            <th>Lot</th>
            <th>Network</th>
            <th>Title</th>
            <th>Vendor</th>
            <th>Antenna Changes</th>
            <th>Recommendations</th>
            <th>Imported By</th>
            <th>Imported</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(reports ?? []).map((report) => (
            <ReportRow
              key={report.id}
              report={report}
              expanded={expandedId === report.id}
              onToggle={() => setExpandedId(expandedId === report.id ? null : report.id)}
              onDelete={async () => {
                if (!window.confirm(`Delete the "${report.lot_name}" import? This does not delete the Issues it created.`)) return
                await deleteReport.mutateAsync(report.id)
              }}
            />
          ))}
          {!reports?.length && (
            <tr>
              <td colSpan={9} className="page-status">No reports imported yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ReportRow({
  report, expanded, onToggle, onDelete,
}: {
  report: RfOptimizationReport
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <>
      <tr>
        <td>
          <button type="button" className="btn-link" onClick={onToggle}>
            {expanded ? '▾' : '▸'} {report.lot_name}
          </button>
        </td>
        <td>{report.network || '—'}</td>
        <td>{report.title || '—'}</td>
        <td>{report.vendor || '—'}</td>
        <td>{report.antenna_changes_detail.length}</td>
        <td>{report.recommendation_count}</td>
        <td>{report.imported_by_name ?? '—'}</td>
        <td>{new Date(report.imported_at).toLocaleDateString()}</td>
        <td className="admin-table-actions">
          <button className="btn-danger btn-small" onClick={onDelete}>Delete</button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9}>
            <ReportDetail report={report} />
          </td>
        </tr>
      )}
    </>
  )
}

function ReportDetail({ report }: { report: RfOptimizationReport }) {
  const uploadAttachments = useUploadRfReportAttachments(report.id)
  const [category, setCategory] = useState<RfReportAttachmentCategory>('mom')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function onFilesChosen(files: FileList | null) {
    if (!files || !files.length) return
    await uploadAttachments.mutateAsync({ files: Array.from(files), category })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div style={{ padding: '12px 0' }}>
      {report.notes && <p className="muted">{report.notes}</p>}

      <h3>Antenna Changes ({report.antenna_changes_detail.length})</h3>
      {report.antenna_changes_detail.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Cell Name</th>
                <th>Sector Match</th>
                <th>Before (Azimuth/MT/ET)</th>
                <th>After (Azimuth/MT/ET)</th>
                <th>Result</th>
                <th>Antenna Type</th>
                <th>Shared With</th>
              </tr>
            </thead>
            <tbody>
              {report.antenna_changes_detail.map((row) => (
                <tr key={row.id}>
                  <td>{row.cell_name}</td>
                  <td>{row.sector_label ?? <span className="muted">No match</span>}</td>
                  <td>{row.before_change}</td>
                  <td>{row.after_change}</td>
                  <td>{row.result}</td>
                  <td>{row.antenna_type}</td>
                  <td>{row.antenna_shared_with}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No antenna change rows were imported for this report.</p>
      )}

      <h3>
        Recommendations ({report.recommendation_count})
      </h3>
      <p className="muted">Each recommendation was imported as an Issue — see the Issues page to track them through to resolution.</p>

      <h3>Attachments ({report.attachments.length})</h3>
      <ul className="plain-list">
        {report.attachments.map((att) => (
          <li key={att.id}>
            <span className="issue-badge">{ATTACHMENT_CATEGORY_LABELS[att.category]}</span>{' '}
            {att.url ? <a href={att.url} target="_blank" rel="noreferrer">{att.original_filename}</a> : att.original_filename}
            {att.is_compressed && <span className="muted"> (compressed)</span>}
            {' — '}{att.uploaded_by_name ?? 'unknown'}, {new Date(att.uploaded_at).toLocaleDateString()}
          </li>
        ))}
        {!report.attachments.length && <li className="muted">No attachments yet — add the source document or a Minutes of Meeting file below.</li>}
      </ul>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={category} onChange={(e) => setCategory(e.target.value as RfReportAttachmentCategory)}>
          {(Object.entries(ATTACHMENT_CATEGORY_LABELS) as [RfReportAttachmentCategory, string][]).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => onFilesChosen(e.target.files)}
          disabled={uploadAttachments.isPending}
        />
        {uploadAttachments.isPending && <span className="muted">Uploading…</span>}
      </div>
      {uploadAttachments.isError && (
        <div className="form-error">{apiErrorMessage(uploadAttachments.error, 'Could not upload attachment.')}</div>
      )}
    </div>
  )
}

function ImportWizard({
  sites, onDone, onCancel,
}: {
  sites: { id: string; name: string }[]
  onDone: () => void
  onCancel: () => void
}) {
  const parseReport = useParseRfReport()
  const confirmImport = useConfirmRfReportImport()
  const uploadAttachments = useUploadRfReportAttachments()

  const [lotName, setLotName] = useState('')
  const [title, setTitle] = useState('')
  const [vendor, setVendor] = useState('')
  const [periodCovered, setPeriodCovered] = useState('')
  const [network, setNetwork] = useState('')
  const [notes, setNotes] = useState('')

  const [antennaRows, setAntennaRows] = useState<AntennaRowState[]>([])
  const [recRows, setRecRows] = useState<RecommendationRowState[]>([])
  const [tablesUnmatched, setTablesUnmatched] = useState<RfReportUnmatchedTable[]>([])
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // Kept so the original upload can be re-sent as a compressed 'source'
  // attachment right after confirm-import succeeds (2026-09-15
  // follow-up: "allow system to save report (with size compressed)
  // also with attachment"), without asking the engineer to pick the
  // same file a second time.
  const [sourceFile, setSourceFile] = useState<File | null>(null)

  const siteOptions = sites.map((s) => `${s.name || s.id} (${s.id})`)
  function siteIdFromLabel(label: string): string | null {
    const match = sites.find((s) => `${s.name || s.id} (${s.id})` === label)
    return match ? match.id : null
  }
  function siteLabelFromId(id: string | null): string {
    if (!id) return ''
    const match = sites.find((s) => s.id === id)
    return match ? `${match.name || match.id} (${match.id})` : ''
  }

  async function onFileChosen(file: File | null) {
    if (!file) return
    setConfirmError(null)
    setSourceFile(file)
    const preview = await parseReport.mutateAsync(file)
    setAntennaRows(preview.antenna_changes.map((row) => ({ ...row, include: true })))
    setRecRows(preview.recommendations.map((row) => ({
      ...row,
      include: true,
      title: row.title,
      description: row.description,
      siteId: row.matched_site_id,
      severity: 'medium',
    })))
    setTablesUnmatched(preview.tables_unmatched)
    // Best-effort suggestions (2026-09-15 follow-up) -- only fill a
    // field the engineer hasn't already typed something into, and only
    // when something was actually found (an empty suggestion just
    // leaves the field as-is, same as before this existed).
    if (preview.suggested_metadata.lot_name) setLotName((v) => v || preview.suggested_metadata.lot_name)
    if (preview.suggested_metadata.network) setNetwork((v) => v || preview.suggested_metadata.network)
    if (preview.suggested_metadata.period_covered) setPeriodCovered((v) => v || preview.suggested_metadata.period_covered)
    if (preview.suggested_notes) setNotes((v) => v || preview.suggested_notes)
  }

  function updateAntenna(index: number, patch: Partial<AntennaRowState>) {
    setAntennaRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function updateRec(index: number, patch: Partial<RecommendationRowState>) {
    setRecRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  async function handleConfirm() {
    setConfirmError(null)
    if (!lotName.trim()) {
      setConfirmError('Lot name is required.')
      return
    }
    const includedRecs = recRows.filter((r) => r.include)
    const missingSite = includedRecs.find((r) => !r.siteId)
    if (missingSite) {
      setConfirmError(`Choose a site for recommendation "${missingSite.title}" (or uncheck it) before importing.`)
      return
    }
    const payload: RfOptimizationReportCreate = {
      lot_name: lotName.trim(),
      title: title.trim(),
      vendor: vendor.trim(),
      period_covered: periodCovered.trim(),
      network: network.trim(),
      notes: notes.trim(),
      antenna_changes: antennaRows.filter((r) => r.include).map((r) => ({
        sn: r.sn,
        cell_name: r.cell_name,
        sector: r.matched_sector_id,
        before_change: r.before_change,
        after_change: r.after_change,
        result: r.result,
        antenna_type: r.antenna_type,
        antenna_shared_with: r.antenna_shared_with,
        raw_row: r.raw_row,
      })),
      recommendations: includedRecs.map((r) => ({
        site: r.siteId as string,
        sector: r.matched_sector_id,
        title: r.title,
        description: r.description,
        severity: r.severity,
      })),
    }
    let created: RfOptimizationReport
    try {
      created = await confirmImport.mutateAsync(payload)
    } catch (err) {
      setConfirmError(apiErrorMessage(err, 'Could not confirm this import.'))
      return
    }
    // Auto-attach the original source document, compressed, as this
    // report's 'source' attachment (2026-09-15 follow-up: "allow system
    // to save report (with size compressed) also with attachment if
    // needed in future for full access"). Best-effort: the import
    // itself already succeeded above (`created` now exists in the
    // database), so a failure here must NOT reopen/re-show the review
    // form -- doing so would risk a second "Confirm Import" click
    // creating a duplicate report. Surface it as a one-time alert
    // instead and close the wizard either way; the file can always be
    // added later from the report's own Attachments section.
    if (sourceFile) {
      try {
        await uploadAttachments.mutateAsync({ files: [sourceFile], category: 'source', reportId: created.id })
      } catch (err) {
        window.alert(
          `Import succeeded, but the source document couldn't be attached automatically (${apiErrorMessage(err, 'upload failed')}). You can add it from the "${created.lot_name}" report's Attachments section.`,
        )
      }
    }
    onDone()
  }

  const hasPreview = antennaRows.length > 0 || recRows.length > 0

  return (
    <section style={{ marginTop: 16, marginBottom: 24 }}>
      <h2>Import a report</h2>

      {!hasPreview && (
        <div>
          <input
            type="file"
            accept=".docx"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            disabled={parseReport.isPending}
          />
          {parseReport.isPending && (
            <p className="page-status">
              Parsing the document… this can take a few minutes for a large report (real files seen: 200-500MB+).
            </p>
          )}
          {parseReport.isError && (
            <div className="form-error">{apiErrorMessage(parseReport.error, 'Could not parse this document.')}</div>
          )}
        </div>
      )}

      {hasPreview && (
        <>
          <div className="edit-grid">
            <label>
              Lot name
              <input type="text" value={lotName} onChange={(e) => setLotName(e.target.value)} placeholder="e.g. LOT6" />
            </label>
            <label>
              Title (optional)
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Vendor (optional)
              <input type="text" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </label>
            <label>
              Period covered (optional)
              <input type="text" value={periodCovered} onChange={(e) => setPeriodCovered(e.target.value)} placeholder="e.g. Phase I" />
            </label>
            <label>
              Network (optional)
              <input type="text" value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="e.g. Network II" />
            </label>
            <label>
              Notes (optional)
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          <p className="muted">
            Lot name, Network and Period covered are pre-filled from the document's own title page when found — double-check them either way.
          </p>

          {tablesUnmatched.length > 0 && (
            <details style={{ marginBottom: 12 }}>
              <summary className="muted">
                {tablesUnmatched.length} table{tablesUnmatched.length === 1 ? '' : 's'} looked recommendation-like but weren't fully recognized
                {' — '}{tablesUnmatched.filter((t) => t.parsed).length} parsed anyway, {tablesUnmatched.filter((t) => !t.parsed).length} skipped (click to see headers)
              </summary>
              <ul className="plain-list">
                {tablesUnmatched.map((t, i) => (
                  <li key={i} className="muted">
                    {t.parsed ? '✓ parsed' : '✗ skipped'} ({t.row_count} rows) — {t.header.join(' | ') || '(no header text)'}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <h3>Antenna Changes ({antennaRows.filter((r) => r.include).length} of {antennaRows.length} included)</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th />
                  <th>Cell Name</th>
                  <th>Match</th>
                  <th>Before (Azimuth/MT/ET)</th>
                  <th>After (Azimuth/MT/ET)</th>
                  <th>Result</th>
                  <th>Antenna Type</th>
                  <th>Shared With</th>
                </tr>
              </thead>
              <tbody>
                {antennaRows.map((row, i) => (
                  <tr key={i}>
                    <td><input type="checkbox" checked={row.include} onChange={(e) => updateAntenna(i, { include: e.target.checked })} /></td>
                    <td><input type="text" value={row.cell_name} onChange={(e) => updateAntenna(i, { cell_name: e.target.value })} /></td>
                    <td>
                      {row.matched_sector_id ? (
                        <button type="button" className="btn-secondary btn-small" onClick={() => updateAntenna(i, { matched_sector_id: null, matched_site_id: null })}>
                          Matched — clear
                        </button>
                      ) : <span className="muted">No match</span>}
                    </td>
                    <td><input type="text" value={row.before_change} onChange={(e) => updateAntenna(i, { before_change: e.target.value })} /></td>
                    <td><input type="text" value={row.after_change} onChange={(e) => updateAntenna(i, { after_change: e.target.value })} /></td>
                    <td><input type="text" value={row.result} onChange={(e) => updateAntenna(i, { result: e.target.value })} /></td>
                    <td><input type="text" value={row.antenna_type} onChange={(e) => updateAntenna(i, { antenna_type: e.target.value })} /></td>
                    <td><input type="text" value={row.antenna_shared_with} onChange={(e) => updateAntenna(i, { antenna_shared_with: e.target.value })} /></td>
                  </tr>
                ))}
                {!antennaRows.length && (
                  <tr><td colSpan={8} className="page-status">No antenna change table was found in this document.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h3>Recommendations ({recRows.filter((r) => r.include).length} of {recRows.length} included)</h3>
          <p className="muted">
            Each included row becomes an Issue — a site is required for every one. For a brand-new site
            proposal there's no real "existing" site yet, so this just anchors the Issue to the nearest
            real site for tracking; the nearest one is pre-selected by distance when found, but always
            double-check and change it if it's not the right one.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th />
                  <th>Title</th>
                  <th>Description</th>
                  <th>Site (required)</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {recRows.map((row, i) => (
                  <tr key={i}>
                    <td><input type="checkbox" checked={row.include} onChange={(e) => updateRec(i, { include: e.target.checked })} /></td>
                    <td><input type="text" value={row.title} onChange={(e) => updateRec(i, { title: e.target.value })} /></td>
                    <td><textarea rows={2} value={row.description} onChange={(e) => updateRec(i, { description: e.target.value })} /></td>
                    <td style={{ minWidth: 220 }}>
                      <SearchableSelect
                        value={siteLabelFromId(row.siteId)}
                        onChange={(label) => updateRec(i, { siteId: siteIdFromLabel(label) })}
                        options={siteOptions}
                        placeholder="Choose a site…"
                        searchPlaceholder="Search sites…"
                        ariaLabel="Site"
                      />
                      {row.site_match_type === 'exact' && <div className="muted">matched by name</div>}
                      {row.site_match_type === 'nearest' && (
                        <div className="muted">
                          nearest{row.site_match_distance_km != null ? ` — ~${row.site_match_distance_km} km away` : ''}, please confirm
                        </div>
                      )}
                    </td>
                    <td>
                      <select value={row.severity} onChange={(e) => updateRec(i, { severity: e.target.value as IssueSeverity })}>
                        {ISSUE_SEVERITY_ORDER.map((value) => (
                          <option key={value} value={value}>{ISSUE_SEVERITY_LABELS[value]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {!recRows.length && (
                  <tr><td colSpan={5} className="page-status">No recommendation table was found in this document.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {confirmError && <div className="form-error">{confirmError}</div>}
          <div className="admin-page-actions">
            <button className="btn-secondary" onClick={onCancel} disabled={confirmImport.isPending || uploadAttachments.isPending}>Cancel</button>
            <button className="btn-primary" onClick={handleConfirm} disabled={confirmImport.isPending || uploadAttachments.isPending}>
              {confirmImport.isPending ? 'Importing…' : uploadAttachments.isPending ? 'Attaching source document…' : 'Confirm Import'}
            </button>
          </div>
        </>
      )}

      {!hasPreview && (
        <div className="admin-page-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </section>
  )
}
