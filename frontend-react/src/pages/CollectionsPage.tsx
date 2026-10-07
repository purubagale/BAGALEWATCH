import { useState } from 'react'
import { useCollectionSessions } from '../api/queries'

// Collections (2026-10-06): every drive and trace the phones have sent, by source.
// Device identity appears only for users with device.view_identity; the server
// leaves device_hash out of the response for everyone else.

const SOURCE_LABEL: Record<string, string> = {
  crowd_drive: 'Crowd drive',
  staff_drive: 'Staff drive',
  operator_investigation: 'Operator investigation',
  operator_case: 'Operator case',
  drive_test: 'Drive test (team)',
}

export default function CollectionsPage() {
  const [source, setSource] = useState('')
  const { data, isLoading, error } = useCollectionSessions(source)
  const rows = data?.results ?? []

  return (
    <div className="admin-page">
      <h1>Collections</h1>
      <p className="muted">
        Drives and traces sent from phones. A session is open while data is still arriving, and ended once it
        completes, is cancelled, or expires.
      </p>

      <label>
        Source{' '}
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="page-status">Could not load collections.</p>}

      {data && rows.length === 0 && <p className="page-status">No collections yet.</p>}

      {data && rows.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Source</th>
              <th>User type</th>
              <th>Fixes</th>
              <th>Last fix</th>
              <th>Status</th>
              <th>Device</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.started_at).toLocaleString()}</td>
                <td>{SOURCE_LABEL[row.source] ?? row.source}</td>
                <td>{row.user_type}</td>
                <td>{row.sample_count}</td>
                <td>{row.last_sample_at ? new Date(row.last_sample_at).toLocaleString() : '—'}</td>
                <td>{row.ended_at ? `Ended ${new Date(row.ended_at).toLocaleString()}` : 'Open'}</td>
                <td>{row.device_hash ? row.device_hash.slice(0, 10) : 'Restricted'}</td>
                <td>{row.trace_id ? row.trace_id.slice(0, 8) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
