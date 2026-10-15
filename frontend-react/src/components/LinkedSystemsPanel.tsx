import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useDeleteLinkedSystem, useLinkedSystems, useNewLinkedSystemSecret, useProblemNotifications,
  useRetryProblemNotification, useSaveLinkedSystem, useTestLinkedSystem,
} from '../api/queries'
import type { LinkedSystem, LinkedSystemMode } from '../api/types'

// Linked systems (2026-10-15, superadmin, on API Access): NTC systems that
// send problem reports, the address where each is told about its reports,
// and whether that happens automatically, only when an engineer presses
// "Send update", or not at all. Each update is signed with the system's
// secret, shown once. Below: every update sent, with Retry for a failed one.

const MODES: { key: LinkedSystemMode; label: string; hint: string }[] = [
  { key: 'auto', label: 'Automatic', hint: 'Whenever a report\'s status or likely cause changes' },
  { key: 'manual', label: 'Manual', hint: 'Only when an engineer presses "Send update" on a report' },
  { key: 'off', label: 'Off', hint: 'Never; the system can still ask for the status' },
]
const STATUS_LABEL: Record<string, string> = { pending: 'Waiting', sent: 'Sent', failed: 'Failed' }
const EVENT_LABEL: Record<string, string> = {
  status: 'Status changed', cause: 'Likely cause', manual: 'Sent by hand', test: 'Test',
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—'
}

export default function LinkedSystemsPanel() {
  const { data, isLoading, error } = useLinkedSystems()
  const save = useSaveLinkedSystem()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<LinkedSystemMode>('manual')
  const [shownSecret, setShownSecret] = useState<{ name: string; secret: string } | null>(null)
  const [logSystem, setLogSystem] = useState('')
  const systems = data?.results ?? []
  const unlinked = (data?.key_names ?? []).filter((n) => !systems.some((s) => s.name === n))

  const add = () => {
    save.mutate({ name, notify_url: url, notify_mode: mode }, {
      onSuccess: (s) => {
        if (s.secret) setShownSecret({ name: s.name, secret: s.secret })
        setName('')
        setUrl('')
      },
    })
  }

  return (
    <section>
      <h2>Linked systems: status updates</h2>
      <p className="muted">
        An NTC system that sends problem reports can be told about them as they change. Give each system the address
        that receives the updates and choose how they go. Each update is signed with the system's secret
        (header <code>X-DTWatch-Signature: sha256=…</code>, an HMAC-SHA256 of <code>&lt;X-DTWatch-Timestamp&gt;.&lt;body&gt;</code>),
        so the system can check it came from here. A failed update is tried again for about a day.
      </p>

      {shownSecret && (
        <div className="form-success" style={{ marginBottom: 10 }}>
          Signing secret for <b>{shownSecret.name}</b>, shown only now; give it to that system's team:{' '}
          <code style={{ userSelect: 'all' }}>{shownSecret.secret}</code>{' '}
          <button type="button" className="btn-secondary btn-small" onClick={() => setShownSecret(null)}>Done</button>
        </div>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      {systems.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>System</th><th>Address for updates</th><th>Updates</th><th>Reports</th>
                <th>Last sent</th><th>Waiting / failed</th><th />
              </tr>
            </thead>
            <tbody>
              {systems.map((s) => <SystemRow key={s.id} s={s} onSecret={setShownSecret} onLog={setLogSystem} />)}
            </tbody>
          </table>
        </div>
      )}

      <h3>Add a linked system</h3>
      <div className="edit-grid">
        <label>
          System (its API key's name)
          <input list="linked-key-names" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={unlinked[0] ?? 'Name of the API key'} />
          <datalist id="linked-key-names">
            {unlinked.map((n) => <option key={n} value={n} />)}
          </datalist>
        </label>
        <label>
          Address for updates
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://crm.ntc.net.np/dtwatch-updates" />
        </label>
        <label>
          Updates
          <select value={mode} onChange={(e) => setMode(e.target.value as LinkedSystemMode)}>
            {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}: {m.hint}</option>)}
          </select>
        </label>
        <div>
          <button type="button" className="btn-primary btn-small" disabled={!name.trim() || save.isPending} onClick={add}>
            Add
          </button>
        </div>
      </div>
      {save.error && <p className="error">{apiErrorMessage(save.error)}</p>}

      <DeliveryLog system={logSystem} systems={systems} onSystem={setLogSystem} />
    </section>
  )
}

function SystemRow({ s, onSecret, onLog }: {
  s: LinkedSystem; onSecret: (v: { name: string; secret: string }) => void; onLog: (name: string) => void
}) {
  const save = useSaveLinkedSystem()
  const remove = useDeleteLinkedSystem()
  const secret = useNewLinkedSystemSecret()
  const test = useTestLinkedSystem()
  const [url, setUrl] = useState(s.notify_url)
  const [testResult, setTestResult] = useState('')
  const busy = save.isPending || remove.isPending || secret.isPending || test.isPending

  return (
    <tr>
      <td>
        <b>{s.name}</b>
        {!s.is_active && <div className="muted">Paused</div>}
        {s.last_error && <div className="error" style={{ fontSize: 11.5 }}>{s.last_error}</div>}
      </td>
      <td>
        <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 240 }}
          onBlur={() => url !== s.notify_url && save.mutate({ id: s.id, notify_url: url })} />
        {testResult && <div className="muted" style={{ fontSize: 11.5 }}>{testResult}</div>}
      </td>
      <td>
        <select value={s.notify_mode} disabled={busy}
          onChange={(e) => save.mutate({ id: s.id, notify_mode: e.target.value as LinkedSystemMode })}>
          {MODES.map((m) => <option key={m.key} value={m.key} title={m.hint}>{m.label}</option>)}
        </select>
      </td>
      <td>{s.reports}</td>
      <td>{when(s.last_sent_at)}</td>
      <td>
        <button type="button" className="pd-link" onClick={() => onLog(s.name)}>{s.waiting} / {s.failed}</button>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="btn-secondary btn-small" disabled={busy || !s.notify_url}
          onClick={() => test.mutate(s.id, {
            onSuccess: (r) => setTestResult(r.ok ? `Test delivered (${r.response_code}).` : r.error),
          })}>
          Test
        </button>{' '}
        <button type="button" className="btn-secondary btn-small" disabled={busy}
          onClick={() => save.mutate({ id: s.id, is_active: !s.is_active })}>
          {s.is_active ? 'Pause' : 'Resume'}
        </button>{' '}
        <button type="button" className="btn-secondary btn-small" disabled={busy}
          onClick={() => window.confirm(`Give ${s.name} a new signing secret? The old one stops working at once.`) &&
            secret.mutate(s.id, { onSuccess: (r) => r.secret && onSecret({ name: r.name, secret: r.secret }) })}>
          New secret
        </button>{' '}
        <button type="button" className="btn-danger btn-small" disabled={busy}
          onClick={() => window.confirm(`Remove ${s.name}? Its reports stay; it is no longer sent updates.`) &&
            remove.mutate(s.id)}>
          Remove
        </button>
        {(save.error || remove.error || secret.error || test.error) && (
          <div className="error" style={{ fontSize: 11.5 }}>
            {apiErrorMessage(save.error || remove.error || secret.error || test.error)}
          </div>
        )}
      </td>
    </tr>
  )
}

function DeliveryLog({ system, systems, onSystem }: {
  system: string; systems: LinkedSystem[]; onSystem: (name: string) => void
}) {
  const { data } = useProblemNotifications(system)
  const retry = useRetryProblemNotification()
  const rows = data?.results ?? []
  return (
    <>
      <h3>Updates sent</h3>
      <div className="problem-toolbar">
        <label>
          System{' '}
          <select value={system} onChange={(e) => onSystem(e.target.value)}>
            <option value="">All</option>
            {systems.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </label>
      </div>
      {!rows.length ? <p className="muted">No updates yet.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr><th>Queued</th><th>System</th><th>Ticket</th><th>Why</th><th>Status</th><th>Tries</th><th>Answer</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td>{when(n.created_at)}</td>
                  <td>{n.system}</td>
                  <td>{n.external_ref}</td>
                  <td>{EVENT_LABEL[n.event] ?? n.event}{n.requested_by ? ` (${n.requested_by})` : ''}</td>
                  <td>
                    {STATUS_LABEL[n.status]}
                    {n.status === 'sent' && n.sent_at ? `, ${when(n.sent_at)}` : ''}
                    {n.status === 'pending' && n.next_try_at ? `, next ${when(n.next_try_at)}` : ''}
                  </td>
                  <td>{n.attempts}</td>
                  <td>{n.response_code ?? '—'}{n.last_error ? ` · ${n.last_error}` : ''}</td>
                  <td>
                    {n.status !== 'sent' && (
                      <button type="button" className="btn-secondary btn-small" disabled={retry.isPending}
                        onClick={() => retry.mutate(n.id)}>
                        Retry now
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retry.error && <p className="error">{apiErrorMessage(retry.error)}</p>}
    </>
  )
}
