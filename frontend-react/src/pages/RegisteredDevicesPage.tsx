import { apiErrorMessage } from '../api/client'
import { useRegisteredDevices } from '../api/queries'

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

  return (
    <div className="admin-page">
      <h1>Registered Devices</h1>
      <p className="muted">
        Every phone that has registered for NTC trace requests (the mobile app's "Register this phone" action) --
        msisdn is self-declared by the device, shown as-is. A device with no FCM token can't receive a push trace
        request, only poll for one. This list is separate from Rescue Enrolled Devices, which tracks a different
        opt-in (the Rescue Location beacon), not registration.
      </p>

      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="form-error form-error-inline">{apiErrorMessage(error, 'Could not load registered devices.')}</p>}

      {data && (
        <p className="muted" style={{ fontSize: 11 }}>
          {data.count} device{data.count === 1 ? '' : 's'} registered.
        </p>
      )}

      {data && rows.length === 0 && <p className="page-status">No devices are currently registered.</p>}

      {rows.length > 0 && (
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
            {rows.map((r) => (
              <tr key={r.device_hash}>
                <td>{r.msisdn ?? '—'}</td>
                <td>{r.device_hash.slice(0, 16)}...</td>
                <td>{r.app_version ?? '—'}</td>
                <td>{r.has_fcm_token ? 'Yes' : 'No'}</td>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : '—'}</td>
                <td>{r.revoked_at ? `Revoked ${new Date(r.revoked_at).toLocaleString()}` : 'Active'}</td>
                <td>{[r.manufacturer, r.phone_model].filter(Boolean).join(' ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
