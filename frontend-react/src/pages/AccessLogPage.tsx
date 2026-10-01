import { useState } from 'react'
import { useAuthEventLog } from '../api/queries'
import type { AuthEventType } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Login/access audit trail (2026-10-01, "create one menu item to display
// current log or history of the application with user or any unauthentic
// access tried in the application. add this feature with efficient
// tracking") -- read-only view over core/auth_log.py's AuthEventLog, see
// that module's docstring for the full design (what gets logged, why
// server-side pagination, why superadmin-only).
const EVENT_LABELS: Record<AuthEventType, string> = {
  login_success: 'Local login succeeded',
  login_failed: 'Local login failed',
  login_locked: 'Local login locked out',
  login_disabled: 'Local login — account disabled',
  sso_login_success: 'SSO login succeeded',
  sso_login_failed: 'SSO login failed',
  logout: 'Signed out',
}

function EventBadge({ event, isSuccess }: { event: AuthEventType; isSuccess: boolean }) {
  return (
    <span className={`auth-event-badge ${isSuccess ? 'auth-event-badge-success' : 'auth-event-badge-fail'}`}>
      {EVENT_LABELS[event] ?? event}
    </span>
  )
}

export default function AccessLogPage() {
  const { user: me } = useAuth()
  const [page, setPage] = useState(1)
  const [username, setUsername] = useState('')
  const [event, setEvent] = useState<AuthEventType | ''>('')
  const [success, setSuccess] = useState<'' | '1' | '0'>('')
  const pageSize = 50

  const { data, isLoading, error } = useAuthEventLog({
    page, page_size: pageSize,
    username: username || undefined,
    event: event || undefined,
    success: success || undefined,
  })

  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can view the access log.</div>
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.count / pageSize)) : 1

  function resetToFirstPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  return (
    <div className="admin-page">
      <h1>Access Log</h1>
      <p className="muted">
        Every sign-in attempt, local or SSO, successful or not — including unknown usernames, locked-out accounts,
        and rejected SSO logins. Superadmin-only.
      </p>

      <div className="edit-grid" style={{ marginBottom: 12 }}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => resetToFirstPage(setUsername)(e.target.value)}
            placeholder="Search attempted or matched username"
          />
        </label>
        <label>
          Event
          <select value={event} onChange={(e) => resetToFirstPage(setEvent)(e.target.value as AuthEventType | '')}>
            <option value="">Any</option>
            {(Object.keys(EVENT_LABELS) as AuthEventType[]).map((key) => (
              <option key={key} value={key}>
                {EVENT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select value={success} onChange={(e) => resetToFirstPage(setSuccess)(e.target.value as '' | '1' | '0')}>
            <option value="">Any</option>
            <option value="1">Success only</option>
            <option value="0">Failures / lockouts only</option>
          </select>
        </label>
      </div>

      {error && <div className="page-status page-status-error">Could not load the access log.</div>}
      {isLoading && !data && <div className="page-status">Loading…</div>}

      {data && (
        <>
          <div className="report-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Who</th>
                  <th>IP Address</th>
                  <th>Detail</th>
                  <th>User Agent</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(row.created_at).toLocaleString()}</td>
                    <td>
                      <EventBadge event={row.event} isSuccess={row.is_success} />
                    </td>
                    <td>{row.user_display}</td>
                    <td className="admin-table-key">{row.ip_address || '—'}</td>
                    <td>{row.detail || '—'}</td>
                    <td className="muted" title={row.user_agent} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.user_agent || '—'}
                    </td>
                  </tr>
                ))}
                {data.results.length === 0 && (
                  <tr>
                    <td colSpan={6} className="page-status">No access log entries match these filters.</td>
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
