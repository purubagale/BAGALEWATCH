import { useState } from 'react'
import { apiErrorMessage, apiJson } from '../api/client'

// Linking a phone's earlier readings to the number by hand (2026-10-15,
// core/subscriber_link.py). A reinstall gives a phone a new device id, and
// an app from before 14 October never told the server which id was its own;
// those readings then belong to no number. The server suggests ids with no
// number whose readings were taken in the same places as this number's
// phones; the superadmin links one, with the case reference.

interface Candidate {
  device_id: string
  readings: number
  first_reading: string | null
  last_reading: string | null
  squares: number
  shared_squares: number
  overlap_pct: number
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString() : '—'
}

export default function LinkEarlierReadings({ msisdn, reason, manualIds, onChanged }: {
  msisdn: string; reason: string; manualIds: string[]; onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ candidates: Candidate[]; note: string; days: number } | null>(null)

  async function find() {
    setOpen(true)
    setBusy(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ msisdn, reason })
      setResult(await apiJson(`/api/v2/subscriber-profile/link-candidates/?${qs}`))
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function change(deviceId: string, link: boolean) {
    if (link && !window.confirm('Link this device\'s readings to the number? It is recorded in the Audit Log with your case reference.')) return
    setBusy(true)
    setError(null)
    try {
      await apiJson('/api/v2/subscriber-profile/link-device/', {
        method: link ? 'POST' : 'DELETE', body: JSON.stringify({ msisdn, device_id: deviceId, reason }),
      })
      setResult(null)
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sp-link-earlier">
      {manualIds.length > 0 && (
        <div className="sp-muted" style={{ fontSize: 12 }}>
          Linked by hand: {manualIds.map((id) => (
            <span key={id}>
              <code>{id.slice(0, 10)}…</code>{' '}
              <button type="button" className="sp-linkbtn" disabled={busy} onClick={() => change(id, false)}>remove</button>{' '}
            </span>
          ))}
        </div>
      )}
      {!open && (
        <button type="button" className="sp-linkbtn" onClick={find}>
          Readings missing after a reinstall? Find this phone's earlier readings…
        </button>
      )}
      {open && (
        <div className="sp-link-panel">
          {busy && !result && <p className="sp-muted">Comparing places…</p>}
          {result?.note && <p className="sp-muted">{result.note}</p>}
          {result && !result.note && result.candidates.length === 0 && (
            <p className="sp-muted">No unlinked device took readings in the same places in the last {result.days} days.</p>
          )}
          {result && result.candidates.length > 0 && (
            <>
              <p className="sp-muted" style={{ fontSize: 12 }}>
                Devices linked to no number whose readings in the last {result.days} days were taken in the same 500 m
                squares as this number's phones, the most overlap first. Check the dates and places before linking.
              </p>
              <table className="sp-table" data-pager="off">
                <thead><tr><th>Device</th><th>Same places</th><th>Readings there</th><th>From</th><th>To</th><th /></tr></thead>
                <tbody>
                  {result.candidates.map((c) => (
                    <tr key={c.device_id}>
                      <td className="sp-mono" title={c.device_id}>{c.device_id.slice(0, 10)}…</td>
                      <td>{c.overlap_pct}% <span className="sp-muted">({c.shared_squares} of {c.squares})</span></td>
                      <td>{c.readings.toLocaleString()}</td>
                      <td>{when(c.first_reading)}</td>
                      <td>{when(c.last_reading)}</td>
                      <td><button type="button" className="sp-linkbtn" disabled={busy} onClick={() => change(c.device_id, true)}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <button type="button" className="sp-linkbtn" onClick={() => { setOpen(false); setResult(null) }}>Close</button>
        </div>
      )}
      {error && <p className="error" style={{ fontSize: 12 }}>{error}</p>}
    </div>
  )
}
