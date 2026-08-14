import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useNtaReport } from '../api/queries'
import type { NtaStatus } from '../api/types'
import RowLimitSelect, { DEFAULT_ROW_LIMIT } from '../components/RowLimitSelect'

const STATUS_ICON: Record<NtaStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' }
const STATUS_BADGE_CLASS: Record<NtaStatus, string> = { pass: 'report-badge-pass', warn: 'report-badge-warn', fail: 'report-badge-fail' }
const STATUS_COLOR: Record<NtaStatus, string> = { pass: 'var(--rpt-green)', warn: 'var(--rpt-yellow)', fail: 'var(--rpt-red)' }

// Ports v1's NTA Regulatory Compliance report (bts_monitor.html
// openNtaModal/renderNtaReport/ntaCheck, ~line 12399-12503) — checking
// itself happens server-side (core/reports.py's nta_check()); this page
// is presentation. Faithfully keeps v1's "a missing KPI value counts as
// an automatic pass" behavior — see the backend docstring for why.
//
// **2026-08-07 audit fix, later made adjustable.** Defaults to
// `pane = 'all-sites'` and loads on page open — the table below rendered
// one <tr> per site with no cap, same bug class as SlaTrackerPage.tsx's
// row cap fix (found in the same audit). No CSV export exists on this
// page to fall back to, so the truncation note instead points at
// "Violations Only", which is realistically a much smaller set.
// Originally a flat 300-row cap; now a user-adjustable `rowLimit`
// (RowLimitSelect.tsx) defaulting to 50, per a same-day follow-up
// request.

export default function NtaCompliancePage() {
  const [pane, setPane] = useState<'all-sites' | 'violations'>('all-sites')
  const [rowLimit, setRowLimit] = useState(DEFAULT_ROW_LIMIT)
  const { data: report, isLoading, error } = useNtaReport(pane)

  if (isLoading) return <div className="page-status">Loading NTA compliance report…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load the NTA compliance report.')}</div>
  if (!report) return null

  const { summary, thresholds, sites } = report
  const overallStatus: NtaStatus = summary.violation > 0 ? 'fail' : summary.warning > 0 ? 'warn' : 'pass'
  const overallText = summary.violation > 0 ? `${summary.violation} VIOLATIONS` : summary.warning > 0 ? `${summary.warning} WARNINGS` : 'COMPLIANT'

  return (
    <div className="admin-page">
      <h1>NTA Regulatory Compliance</h1>
      <p className="muted">Generated: {new Date().toLocaleString()}</p>

      <span className={`report-badge ${STATUS_BADGE_CLASS[overallStatus]}`}>
        {STATUS_ICON[overallStatus]} {overallText}
      </span>

      <div className="report-summary-cards" style={{ marginTop: 14 }}>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-green)' }}>
            {summary.compliant}
          </div>
          <div className="report-card-label">Compliant</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-yellow)' }}>
            {summary.warning}
          </div>
          <div className="report-card-label">Warning</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-red)' }}>
            {summary.violation}
          </div>
          <div className="report-card-label">Violation</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-blue)' }}>
            {summary.rate}%
          </div>
          <div className="report-card-label">Compliance Rate</div>
        </div>
      </div>

      <div className="report-toolbar">
        <button className={pane === 'all-sites' ? 'btn-primary btn-small' : 'btn-secondary btn-small'} onClick={() => setPane('all-sites')}>
          All Sites
        </button>
        <button className={pane === 'violations' ? 'btn-primary btn-small' : 'btn-secondary btn-small'} onClick={() => setPane('violations')}>
          Violations Only
        </button>
        <RowLimitSelect value={rowLimit} onChange={setRowLimit} />
      </div>

      {sites.length === 0 ? (
        <div className="muted" style={{ color: pane === 'violations' ? 'var(--rpt-green)' : undefined }}>
          {pane === 'violations' ? '✓ No violations — all sites meet NTA minimum standards.' : 'No sites found.'}
        </div>
      ) : (
        <div className="report-table-wrap">
          {sites.length > rowLimit && (
            <div className="muted" style={{ marginBottom: 6 }}>
              Showing the first {rowLimit} of {sites.length} sites — choose a higher row limit above, or switch to
              "Violations Only" to see a shorter, more actionable list.
            </div>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Region</th>
                {thresholds.map((t) => (
                  <th key={t.key} title={t.penalty}>
                    {t.label.split(' ').slice(0, 2).join(' ')}
                    <br />
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {t.hi ? `≥${t.min}${t.unit}` : `≤${t.max}${t.unit}`}
                    </span>
                  </th>
                ))}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {/* Capped to the user-adjustable rowLimit, not the full `sites`. */}
              {sites.slice(0, rowLimit).map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td className="muted">{s.region}</td>
                  {s.cells.map((c) => (
                    <td key={c.key} style={{ color: STATUS_COLOR[c.status] }}>
                      {STATUS_ICON[c.status]} {c.value !== null ? c.value.toFixed(1) : '—'}
                    </td>
                  ))}
                  <td>
                    <span className={`report-badge ${STATUS_BADGE_CLASS[s.overall]}`}>{s.overall.toUpperCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
