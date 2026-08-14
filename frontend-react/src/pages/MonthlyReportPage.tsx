import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useMonthlyReport, useSites } from '../api/queries'
import { renderMarkdown } from '../lib/markdown'

function monthOptions(): { value: string; label: string }[] {
  const now = new Date()
  const opts: { value: string; label: string }[] = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    opts.push({ value, label })
  }
  return opts
}

// Ports v1's Monthly Report generator (bts_monitor.html
// generateMonthlyReport(), ~line 12664-12738) — the report text itself
// is built server-side (core/reports.py's build_monthly_report()); this
// page is the filter form + rendered markdown output. Note the month
// picker is a label only (v1 has no time-series storage, so every month
// produces an identical report from the current snapshot) — that's a
// faithful port of v1's actual behavior, not a bug here.
export default function MonthlyReportPage() {
  const months = useMemo(monthOptions, [])
  const [month, setMonth] = useState(months[0].value)
  const [style, setStyle] = useState<'executive' | 'board' | 'technical'>('executive')
  const [region, setRegion] = useState('all')
  const { data: sites } = useSites()
  const { data: report, isLoading, error } = useMonthlyReport(month, style, region)

  const regions = [...new Set((sites ?? []).map((s) => s.region).filter(Boolean))].sort()

  function downloadTxt() {
    if (!report) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([report.markdown], { type: 'text/plain' }))
    a.download = `NT_Monthly_${month}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="admin-page">
      <h1>Monthly Report</h1>

      <div className="report-toolbar">
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
          <option value="executive">Executive</option>
          <option value="board">Board</option>
          <option value="technical">Technical</option>
        </select>
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="all">All Regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="btn-secondary btn-small" onClick={downloadTxt} disabled={!report}>
          Download .txt
        </button>
      </div>

      {isLoading && <div className="page-status">Generating report…</div>}
      {error && <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not generate the monthly report.')}</div>}
      {report && (
        <>
          <p className="muted">
            {report.meta.site_count} sites · {report.meta.region === 'all' ? 'All regions' : report.meta.region} · {report.meta.month_name}
          </p>
          <div className="md-report" dangerouslySetInnerHTML={{ __html: renderMarkdown(report.markdown) }} />
        </>
      )}
    </div>
  )
}
