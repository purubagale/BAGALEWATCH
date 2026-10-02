import { useState } from 'react'
import { exportAuditLogCsv, useAuditLog } from '../api/queries'
import type { AuditLogEntry, AuditLogSource } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Unified Audit Log (2026-10-01, "add feature of audit log with All
// system activity, data changes, and access events") -- replaces the
// narrower AccessLogPage.tsx (login/access only) with one feed merging
// that same access-event source with the new AuditEvent data-change
// trail -- see core/audit.py's AuditLogListView docstring for exactly
// how the two are combined server-side. Same server-side-paginated,
// superadmin-only, "efficient tracking" posture as the page it replaces.
function ActionBadge({ source, action }: { source: AuditLogSource; action: string }) {
  // Access events read as clearly success/fail (LOGIN_FAILED, LOGOUT,
  // etc.) -- data-change events (SITE.CREATED, BACKUP.RESTORED) aren't
  // inherently either, so they get the neutral variant instead of
  // defaulting to a misleading green/red.
  const variant =
    source === 'data_change'
      ? 'neutral'
      : /FAIL|LOCK|DISABLED/.test(action)
        ? 'fail'
        : 'success'
  return <span className={`auth-event-badge auth-event-badge-${variant}`}>{action}</span>
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function AuditLogPage() {
  const { user: me } = useAuth()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [source, setSource] = useState<AuditLogSource | ''>('')
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const pageSize = 50

  const { data, isLoading, error } = useAuditLog({
    page, page_size: pageSize,
    q: q || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    source: source || undefined,
  })

  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can view the audit log.</div>
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.count / pageSize)) : 1

  function resetToFirstPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  async function handleExport() {
    setExportError(null)
    setExporting(true)
    try {
      const blob = await exportAuditLogCsv({
        q: q || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined, source: source || undefined,
      })
      downloadBlob(blob, `audit_log_${new Date().toISOString().slice(0, 10)}.csv`)
    } catch {
      setExportError('Could not export the audit log.')
    } finally {
      setExporting(false)
    }
  }

  function payloadPreview(row: AuditLogEntry): string {
    if (!row.payload) return row.detail || '—'
    const text = JSON.stringify(row.payload)
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
  }

  return (
    <div className="admin-page">
      <h1>Audit Log</h1>
      <p className="muted">
        All system activity in one place — data changes (sites, users, roles, permissions, backups, and more) and
        access events (every sign-in attempt, local or SSO, successful or not). Superadmin-only. Retained for 30
        days, then pruned automatically.
      </p>

      <div className="edit-grid" style={{ marginBottom: 12 }}>
        <label>
          Search
          <input
            value={q}
            onChange={(e) => resetToFirstPage(setQ)(e.target.value)}
            placeholder="Actor, action, resource, or detail"
          />
        </label>
        <label>
          From
          <input type="date" value={dateFrom} onChange={(e) => resetToFirstPage(setDateFrom)(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={dateTo} onChange={(e) => resetToFirstPage(setDateTo)(e.target.value)} />
        </label>
        <label>
          Type
          <select value={source} onChange={(e) => resetToFirstPage(setSource)(e.target.value as AuditLogSource | '')}>
            <option value="">All</option>
            <option value="access">Access events</option>
            <option value="data_change">Data changes</option>
          </select>
        </label>
      </div>

      <div className="admin-page-actions" style={{ marginBottom: 12 }}>
        <button className="btn-secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : '⬇ Export CSV'}
        </button>
        {exportError && <span className="form-error form-error-inline">{exportError}</span>}
      </div>

      {error && <div className="page-status page-status-error">Could not load the audit log.</div>}
      {isLoading && !data && <div className="page-status">Loading…</div>}

      {data && (
        <>
          <div className="report-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Detail / Payload</th>
                  <th>IP Address</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.actor}</td>
                    <td>
                      <ActionBadge source={row.source} action={row.action} />
                    </td>
                    <td className="admin-table-key">{row.resource || '—'}</td>
                    <td className="muted" title={payloadPreview(row)} style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {payloadPreview(row)}
                    </td>
                    <td className="admin-table-key">{row.ip_address || '—'}</td>
                  </tr>
                ))}
                {data.results.length === 0 && (
                  <tr>
                    <td colSpan={6} className="page-status">No audit log entries match these filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, fontSize: 12 }}>
            <span className="muted">{data.count} total entries</span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button type="button" disabled={!data.previous} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                ← Previous
              </button>
              <span className="muted">
                Page {page} of {totalPages}
              </span>
              <button type="button" disabled={!data.next} onClick={() => setPage((p) => p + 1)}>
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
