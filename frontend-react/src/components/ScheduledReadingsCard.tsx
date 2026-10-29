import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useScheduledReadings } from '../api/queries'
import ScheduledReadingsMap from './ScheduledReadingsMap'

// "Help improve NTC's network" (2026-10-29, core/scheduled_readings.py):
// readings phones send at about midnight, 10 am, 2 pm and 7 pm after their
// owner opted in. Counts and averages only; no phone and no exact place is shown.

const TECHS = ['4G', '5G', '3G', '2G']

export default function ScheduledReadingsCard() {
  const [days, setDays] = useState(30)
  const { data, isLoading, error } = useScheduledReadings(days)
  return (
    <section style={{ marginTop: 20 }}>
      <h2>Readings by time of day</h2>
      <p className="muted">
        Four readings a day from phones whose owners chose "Help improve NTC's network": about midnight, 10 am, 2 pm
        and 7 pm. They carry the network, signal and serving cell with no number, and a rough area of about 500 m
        only from phones that allowed it, so they show how quality changes between quiet and busy hours.{' '}
        <label>Last <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
        </select></label>
      </p>
      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      {data && data.readings === 0 && <p className="page-status">No readings yet. They start once phones with app 1.3.0 have opted in.</p>}
      {data && data.readings > 0 && (
        <>
          <p className="muted">{data.readings.toLocaleString()} readings from {data.phones.toLocaleString()} phones;
            {' '}{data.matched_to_site.toLocaleString()} matched to a site.</p>
          <table className="admin-table">
            <thead>
              <tr><th>Time</th><th>Readings</th>{TECHS.map((t) => <th key={t}>{t}: average · weak / fair / good</th>)}</tr>
            </thead>
            <tbody>
              {data.slots.map((s) => (
                <tr key={s.slot}>
                  <td><b>{s.label}</b></td>
                  <td className="mono">{s.readings}</td>
                  {TECHS.map((t) => {
                    const v = s.techs[t]
                    if (!v) return <td key={t} className="muted">—</td>
                    const pct = (n: number) => `${Math.round((100 * n) / v.readings)}%`
                    return <td key={t} className="mono">{v.level_avg ?? '—'} dBm · {pct(v.weak)} / {pct(v.fair)} / {pct(v.good)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <ScheduledReadingsMap days={days} />
          {data.weakest_sites.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Sites with the most weak readings</h3>
              <table className="admin-table">
                <thead>
                  <tr><th>Site</th><th>District</th><th>Readings</th><th>Weak</th>
                    <th>Midnight</th><th>10 am</th><th>2 pm</th><th>7 pm</th></tr>
                </thead>
                <tbody>
                  {data.weakest_sites.map((s) => (
                    <tr key={s.site_id}>
                      <td><Link to={`/sites/${encodeURIComponent(s.site_id)}`}>{s.site_id}</Link>{s.name ? <span className="muted"> {s.name}</span> : null}</td>
                      <td>{s.district ?? '—'}</td>
                      <td className="mono">{s.readings}</td>
                      <td className="mono"><b>{s.weak_pct}%</b></td>
                      {['0', '10', '14', '19'].map((k) => (
                        <td key={k} className="mono">{s.weak_pct_by_slot[k] != null ? `${s.weak_pct_by_slot[k]}%` : '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  )
}
