import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useRegisteredDevices } from '../api/queries'
import { sameNumber } from '../lib/msisdnMatch'

// Registered Devices (2026-10-08) -- superadmin-only. The "where can I
// see the list of devices that are registered in my dtwatch application"
// answer: lists every DeviceCredential (core/device_trace.py's
// RegisteredDeviceListView), the actual record created by the mobile
// app's "Register this phone" flow -- distinct from Rescue Enrolled
// Devices (a separate opt-in lane, SubscriberLastLocation) and from
// DeviceIdentity (crowd/staff phone model info, no registration meaning
// of its own).
export default function RegisteredDevicesPage() {
  const { data, isLoading, error } = useRegisteredDevices()
  const rows = data?.results ?? []
  // ?msisdn= (from a Subscriber Profile): that number's phones only, any spelling (2026-10-15).
  const [params, setParams] = useSearchParams()
  const only = params.get('msisdn')
  // A phone that registered again keeps its older registration (2026-10-28);
  // those rows are hidden unless asked for.
  const [showReplaced, setShowReplaced] = useState(false)
  const forNumber = only ? rows.filter((r) => sameNumber(r.msisdn, only)) : rows
  const replacedCount = forNumber.filter((r) => r.replaced_at).length
  const shown = showReplaced ? forNumber : forNumber.filter((r) => !r.replaced_at)

  return (
    <div className="admin-page">
      <h1>Registered Devices</h1>
      <p className="muted">
        Every phone that has registered for NTC trace requests (the mobile app's "Register this phone" action) --
        the number is typed in the app; "verified" means the phone proved it with a code sent by SMS. A device with
        no push token can't receive a push trace
        request, only poll for one. This list is separate from Rescue Enrolled Devices, which tracks a different
        opt-in (the Rescue Location beacon), not registration.
      </p>

      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="form-error form-error-inline">{apiErrorMessage(error, 'Could not load registered devices.')}</p>}

      {data && (
        <p className="muted" style={{ fontSize: 11 }}>
          {data.count} registration{data.count === 1 ? '' : 's'}.
          {replacedCount > 0 && (
            <label style={{ marginLeft: 12 }}>
              <input type="checkbox" checked={showReplaced} onChange={(e) => setShowReplaced(e.target.checked)} />{' '}
              Show {replacedCount} replaced by a newer registration from the same phone
            </label>
          )}
        </p>
      )}

      {only && (
        <div className="pd-chip" style={{ marginBottom: 10 }}>
          Showing only {only}: {forNumber.length} of {rows.length}
          <button type="button" onClick={() => { const q = new URLSearchParams(params); q.delete('msisdn'); setParams(q, { replace: true }) }}
            title="Show every number">Show all</button>
        </div>
      )}
      {data && rows.length === 0 && <p className="page-status">No devices are currently registered.</p>}
      {only && rows.length > 0 && forNumber.length === 0 && <p className="page-status">No phone is registered with this number.</p>}

      {shown.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>MSISDN</th>
              <th>Device hash</th>
              <th>App version</th>
              <th>Push token</th>
              <th>Registered</th>
              <th>Last seen</th>
              <th>Status</th>
              <th>Phone model</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.device_hash} style={r.replaced_at ? { opacity: 0.6 } : undefined}>
                <td>{r.msisdn ?? '—'}{r.msisdn && (r.msisdn_verified_at
                  ? <span className="sec-on" title={`Verified by SMS ${new Date(r.msisdn_verified_at).toLocaleString()}`}>verified</span>
                  : <span className="sec-off" title="Typed in the app, not proved by SMS">not verified</span>)}</td>
                <td>{r.device_hash.slice(0, 16)}...</td>
                <td>{r.app_version ?? '—'}</td>
                <td>{r.has_fcm_token ? 'Yes' : 'No'}</td>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : '—'}</td>
                <td>{r.revoked_at ? `Revoked ${new Date(r.revoked_at).toLocaleString()}`
                  : r.replaced_at ? `Replaced ${new Date(r.replaced_at).toLocaleString()}` : 'Active'}</td>
                <td>{[r.manufacturer, r.phone_model].filter(Boolean).join(' ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
