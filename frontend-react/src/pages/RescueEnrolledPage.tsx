import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useRescueEnrolledList } from '../api/queries'
import { sameNumber } from '../lib/msisdnMatch'

// Rescue Enrolled Devices (2026-10-07) -- superadmin-only, PROVISIONAL
// list of everyone currently opted in to the Rescue Location beacon (see
// core/rescue.py's RescueEnrolledListView docstring for exactly why this
// is an explicit, acknowledged exception to the feature's own "never
// browse/list, only one number at a time" rule, kept superadmin-only and
// logged like a real lookup rather than treated as a free read). Per the
// request that created this page: "for now, need to test, if further any
// governance rule matters then will remove it" -- this page, its MenuItem,
// and the backend view are all easy to delete together if that happens.
export default function RescueEnrolledPage() {
  const list = useRescueEnrolledList()
  const [loadError, setLoadError] = useState<string | null>(null)

  async function load() {
    setLoadError(null)
    try {
      await list.mutateAsync()
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Could not load the enrolled-device list.'))
    }
  }

  const rows = list.data?.results ?? []
  // ?msisdn= (from a Subscriber Profile): that number's devices only, any spelling (2026-10-15).
  const [params, setParams] = useSearchParams()
  const only = params.get('msisdn')
  const shown = only ? rows.filter((r) => sameNumber(r.msisdn, only)) : rows

  return (
    <div className="admin-page">
      <h1>Rescue Enrolled Devices</h1>
      <p className="muted">
        Every device currently opted in to rescue location sharing: phone number, device, last known position, and
        phone model where the device has sent it. Requires an active emergency, same as Rescue Lookup. Loading this
        list is permanently logged with your account, exactly like a single lookup.
      </p>

      <div className="admin-page-actions" style={{ marginBottom: 12 }}>
        <button className="btn-primary" onClick={load} disabled={list.isPending}>
          {list.isPending ? 'Loading…' : rows.length ? 'Reload list' : 'Load enrolled devices'}
        </button>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}

      {list.data && (
        <p className="muted" style={{ fontSize: 11 }}>
          {list.data.count} device{list.data.count === 1 ? '' : 's'} currently enrolled.
        </p>
      )}

      {list.data && rows.length === 0 && <p className="page-status">No devices are currently enrolled.</p>}
      {only && list.data && (
        <div className="pd-chip" style={{ marginBottom: 10 }}>
          Showing only {only}: {shown.length} of {rows.length}
          <button type="button" onClick={() => { const q = new URLSearchParams(params); q.delete('msisdn'); setParams(q, { replace: true }) }}
            title="Show every number">Show all</button>
        </div>
      )}

      {shown.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>MSISDN</th>
              <th>Device hash</th>
              <th>Last position</th>
              <th>Accuracy</th>
              <th>Source</th>
              <th>Last seen</th>
              <th>Phone model</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.device_hash}>
                <td>{r.msisdn ?? '—'}</td>
                <td>{r.device_hash.slice(0, 16)}...</td>
                <td>{r.lat != null && r.lng != null ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : '—'}</td>
                <td>{r.accuracy_m != null ? `${r.accuracy_m.toFixed(0)} m` : '—'}</td>
                <td>{r.source ?? '—'}</td>
                <td>{r.last_seen_ts ? new Date(r.last_seen_ts).toLocaleString() : '—'}</td>
                <td>{[r.manufacturer, r.phone_model].filter(Boolean).join(' ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
