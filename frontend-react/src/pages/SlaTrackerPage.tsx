import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useSites, useSlaReport } from '../api/queries'
import RowLimitSelect, { DEFAULT_ROW_LIMIT } from '../components/RowLimitSelect'

// Ports v1's SLA Tracker (bts_monitor.html openSlaModal/renderSlaTracker,
// ~line 8365-8480) — the scoring itself is computed server-side (see
// core/reports.py's site_sla_score()); this page is purely presentation.
//
// **2026-08-07 audit fix, later made adjustable.** This page defaults to
// `region = 'all'` and loads on open with no user action needed — the
// results table below used to render one <tr> per matching site with no
// cap, same unbounded-DOM-render bug (and same real fix) as
// AdvancedSiteSearchModal.tsx's row cap, found during the memory/size/
// security audit that followed that crash. Worse here than there: this
// fires on page load, not after a click. Originally a flat 300-row cap;
// per a same-day follow-up request, now a user-adjustable `rowLimit`
// (RowLimitSelect.tsx) defaulting to 50. CSV export is untouched either
// way — full `report.sites`.

export default function SlaTrackerPage() {
  const [region, setRegion] = useState('all')
  const [rowLimit, setRowLimit] = useState(DEFAULT_ROW_LIMIT)
  const { data: report, isLoading, error } = useSlaReport(region)
  const { data: sites } = useSites()

  const regions = [...new Set((sites ?? []).map((s) => s.region).filter(Boolean))].sort()

  if (isLoading) return <div className="page-status">Loading SLA report…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load the SLA report.')}</div>
  if (!report) return null

  function exportCsv() {
    if (!report) return
    const header = ['Site ID', 'Site Name', 'Region', 'SLA Score (%)', ...report.targets.map((t) => `${t.label} (${t.unit})`)]
    const rows = report.sites.map((s) => [
      s.id,
      s.name,
      s.region,
      s.score !== null ? String(s.score) : 'NO DATA',
      ...s.kpi_results.map((k) => (k.value !== null ? k.value.toFixed(2) : '—')),
    ])
    const csv = [header, ...rows].map((r) => r.map((v) => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `SLA_Compliance_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const { summary } = report

  return (
    <div className="admin-page">
      <h1>SLA Tracker</h1>

      <div className="report-toolbar">
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="all">All Regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="btn-secondary btn-small" onClick={exportCsv}>
          Export CSV
        </button>
        <RowLimitSelect value={rowLimit} onChange={setRowLimit} />
      </div>

      <div className="report-summary-cards">
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-blue)' }}>
            {summary.total}
          </div>
          <div className="report-card-label">Total Sites</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-green)' }}>
            {summary.compliant}
          </div>
          <div className="report-card-label">SLA Compliant</div>
          <div className="report-card-sub">score ≥ 80%</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-yellow)' }}>
            {summary.partial}
          </div>
          <div className="report-card-label">Partial</div>
          <div className="report-card-sub">50–79%</div>
        </div>
        <div className="report-card">
          <div className="report-card-val" style={{ color: 'var(--rpt-red)' }}>
            {summary.breach}
          </div>
          <div className="report-card-label">SLA Breach</div>
          <div className="report-card-sub">score &lt; 50%</div>
        </div>
        <div className="report-card">
          <div
            className="report-card-val"
            style={{ color: summary.avg_score === null ? 'var(--rpt-hint)' : summary.avg_score >= 80 ? 'var(--rpt-green)' : summary.avg_score >= 50 ? 'var(--rpt-yellow)' : 'var(--rpt-red)' }}
          >
            {summary.avg_score === null ? '—' : `${summary.avg_score}%`}
          </div>
          <div className="report-card-label">Avg SLA Score</div>
        </div>
      </div>

      {report.sites.length === 0 ? (
        <div className="muted">No KPI data available for this region.</div>
      ) : (
        <div className="report-table-wrap">
          {report.sites.length > rowLimit && (
            <div className="muted" style={{ marginBottom: 6 }}>
              Showing the first {rowLimit} of {report.sites.length} sites — choose a higher row limit above, pick a
              specific region, or use Export CSV for the full list.
            </div>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Region</th>
                <th>SLA Score</th>
                {report.targets.map((t) => (
                  <th key={t.key} title={`${t.label} — target ${t.op === 'gte' ? '≥' : '≤'}${t.target}${t.unit}`}>
                    {t.label.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Capped to the user-adjustable rowLimit, not the full report.sites. */}
              {report.sites.slice(0, rowLimit).map((s) => {
                const scoreColor = s.score === null ? 'var(--rpt-hint)' : s.score >= 80 ? 'var(--rpt-green)' : s.score >= 50 ? 'var(--rpt-yellow)' : 'var(--rpt-red)'
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="muted">{s.region}</td>
                    <td style={{ color: scoreColor, fontWeight: 700 }}>{s.score === null ? 'NO DATA' : `${s.score}%`}</td>
                    {s.kpi_results.map((k) => (
                      <td key={k.key} style={{ color: k.pass === null ? 'var(--rpt-hint)' : k.pass ? 'var(--rpt-green)' : 'var(--rpt-red)', textAlign: 'center' }}>
                        {k.pass === null ? '—' : k.pass ? '✓' : '✗'}
                        <br />
                        <span className="muted" style={{ fontSize: 10 }}>
                          {k.value !== null ? `${k.value.toFixed(1)}${k.unit}` : '—'}
                        </span>
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
