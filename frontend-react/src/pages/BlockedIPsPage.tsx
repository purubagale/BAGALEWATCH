import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useBlockedIps, useCreateBlockedIp, useUnblockIp } from '../api/queries'
import { useAuth } from '../auth/AuthContext'

// Active IP blocking (2026-10-02, Phase E2 -- "can we block the ip, if
// mistakenly blocked, superadmin can unblock") -- escalates the Audit
// Log's own attack-attempt detection (a passive ⚠ flag) into active
// enforcement at the login endpoint. See core/ip_block.py's module
// docstring for the full design: an IP crossing 3 failed local-login
// attempts within 15 minutes is auto-blocked; this page is where a
// superadmin reviews every block (automatic or manual) and reverses a
// false positive.
export default function BlockedIPsPage() {
  const { user: me } = useAuth()
  const { data, isLoading, error } = useBlockedIps()
  const createBlock = useCreateBlockedIp()
  const unblock = useUnblockIp()
  const [newIp, setNewIp] = useState('')
  const [newReason, setNewReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can manage blocked IPs.</div>
  }

  async function handleBlock() {
    setFormError(null)
    if (!newIp.trim()) {
      setFormError('IP address is required.')
      return
    }
    try {
      await createBlock.mutateAsync({ ip_address: newIp.trim(), reason: newReason.trim() || 'Manually blocked' })
      setNewIp('')
      setNewReason('')
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not block this IP.'))
    }
  }

  async function handleUnblock(ip: string) {
    setRowError(null)
    try {
      await unblock.mutateAsync(ip)
    } catch (err) {
      setRowError(apiErrorMessage(err, 'Could not unblock this IP.'))
    }
  }

  const rows = data ?? []
  const active = rows.filter((r) => r.is_active)
  const historical = rows.filter((r) => !r.is_active)

  return (
    <div className="admin-page">
      <h1>Blocked IPs</h1>
      <p className="muted">
        Superadmin-only. An IP is automatically blocked after 3 failed local-login attempts within 15 minutes
        (across potentially different accounts) -- the same signal the Audit Log's ⚠ flag already shows. SSO sign-in
        is not affected -- Keycloak owns its own brute-force posture. Unblocking is reversible and visible here
        afterward, for exactly the "mistakenly blocked" case.
      </p>

      {error && <div className="page-status page-status-error">Could not load blocked IPs.</div>}
      {isLoading && <div className="page-status">Loading…</div>}

      {data && (
        <>
          <h2>Active ({active.length})</h2>
          {rowError && <div className="form-error" style={{ marginBottom: 8 }}>{rowError}</div>}
          <table className="admin-table" style={{ marginBottom: 20 }}>
            <thead>
              <tr>
                <th>IP Address</th>
                <th>Reason</th>
                <th>Blocked At</th>
                <th>Blocked By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((row) => (
                <tr key={row.id}>
                  <td className="admin-table-key">{row.ip_address}</td>
                  <td>{row.reason}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(row.blocked_at).toLocaleString()}</td>
                  <td>{row.blocked_by_username ?? <span className="muted">Automatic</span>}</td>
                  <td className="admin-table-actions">
                    <button
                      className="btn-secondary btn-small"
                      onClick={() => handleUnblock(row.ip_address)}
                      disabled={unblock.isPending}
                    >
                      Unblock
                    </button>
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td colSpan={5} className="page-status">No IPs are currently blocked.</td>
                </tr>
              )}
            </tbody>
          </table>

          <section>
            <h2>Manually block an IP</h2>
            {formError && <div className="form-error">{formError}</div>}
            <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <label>
                IP address
                <input value={newIp} onChange={(e) => setNewIp(e.target.value)} placeholder="203.0.113.5" />
              </label>
              <label>
                Reason
                <input value={newReason} onChange={(e) => setNewReason(e.target.value)} placeholder="e.g. Known scanner" />
              </label>
            </div>
            <div className="admin-page-actions">
              <button className="btn-primary" onClick={handleBlock} disabled={createBlock.isPending}>
                {createBlock.isPending ? 'Blocking…' : 'Block IP'}
              </button>
            </div>
          </section>

          {historical.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>Previously blocked, since unblocked ({historical.length})</h2>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>IP Address</th>
                    <th>Reason</th>
                    <th>Blocked At</th>
                    <th>Blocked By</th>
                    <th>Unblocked At</th>
                    <th>Unblocked By</th>
                  </tr>
                </thead>
                <tbody>
                  {historical.map((row) => (
                    <tr key={row.id}>
                      <td className="admin-table-key">{row.ip_address}</td>
                      <td>{row.reason}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(row.blocked_at).toLocaleString()}</td>
                      <td>{row.blocked_by_username ?? <span className="muted">Automatic</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{row.unblocked_at ? new Date(row.unblocked_at).toLocaleString() : '—'}</td>
                      <td>{row.unblocked_by_username ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}
