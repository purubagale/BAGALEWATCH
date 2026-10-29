import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useProblemOssKpi } from '../api/queries'
import type { OssSite, OssSiteRole, OssVerdict } from '../api/types'
import { useSiteLinkBack } from '../lib/siteLinkBack'
import { CardHead } from './MetricTile'
import SiteCellKpis from './SiteCellKpis'

// OSS diagnostics (KPI) of a complaint (2026-10-29, core/problem_oss.py),
// under Site related analysis: the network KPIs of the site that served the
// complaint, the sites that served readings near the spot and the nearest
// sites. It replaces the "Core network diagnostics" card the diagnosis
// dashboard had. Asked only when opened; a row opens that site's cells.

const ROLE: Record<OssSiteRole, string> = { complaint: 'Complaint site', served: 'Served the area', nearby: 'Nearby' }
const VERDICT: Record<OssVerdict, { label: string; tone: string }> = {
  outage: { label: 'Partly down', tone: 'bad' },
  busy: { label: 'Busy', tone: 'bad' },
  near: { label: 'Close to busy', tone: 'warn' },
  ok: { label: 'Normal', tone: 'ok' },
  quiet: { label: 'Room to spare', tone: 'ok' },
  none: { label: 'No KPIs', tone: 'none' },
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d).replace(/\.0+$/, ''))
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function where(s: OssSite) {
  if (s.distance_m == null) return '—'
  const d = s.distance_m < 1000 ? `${s.distance_m} m` : `${(s.distance_m / 1000).toFixed(1)} km`
  return s.bearing_deg == null ? d : `${d} ${COMPASS[Math.round(s.bearing_deg / 45) % 8]}`
}

export default function ProblemOssKpi({ reportId }: { reportId: number }) {
  const [open, setOpen] = useState(false)
  const [radius, setRadius] = useState(3)
  const [picked, setPicked] = useState<string | null>(null)
  const q = useProblemOssKpi(reportId, radius, open)
  const siteLink = useSiteLinkBack()
  const d = q.data
  const counts = (d?.sites ?? []).reduce<Record<string, number>>((a, s) => ({ ...a, [s.verdict]: (a[s.verdict] ?? 0) + 1 }), {})
  const withKpi = (d?.sites ?? []).filter((s) => s.verdict !== 'none').length

  return (
    <section className="pdd-card oss-card">
      <CardHead icon="🛰️" title="OSS diagnostics (KPI)" sub="network KPIs of the sites around this complaint" hue="slate"
        right={open
          ? <button type="button" className="btn-secondary btn-small" onClick={() => setOpen(false)}>Hide</button>
          : <button type="button" className="btn-primary btn-small" onClick={() => setOpen(true)}>Run OSS diagnostics</button>} />
      {!open && (
        <p className="muted pdd-small" style={{ margin: 0 }}>
          Cell load, users, speed per user, drops and availability from the KPI system, for the site that served the
          complaint, the sites that served readings near the spot and the nearest sites, in the week up to the problem day.
        </p>
      )}
      {open && (
        <>
          <div className="oss-bar">
            <label className="muted">Nearby sites within{' '}
              <select value={radius} onChange={(e) => { setRadius(Number(e.target.value)); setPicked(null) }}>
                {(d?.radii_km ?? [1, 2, 3, 5]).map((r) => <option key={r} value={r}>{r} km</option>)}
              </select>
            </label>
            {d && <span className="muted">Problem day {day(d.problem_date)} · week from {day(d.week_from)}
              {d.newest_date ? ` · newest figures ${day(d.newest_date)}` : ''}</span>}
            {d && withKpi > 0 && (
              <span className="oss-summary">
                {(['outage', 'busy', 'near'] as OssVerdict[]).filter((v) => counts[v]).map((v) => (
                  <span key={v} className={`oss-pill oss-${VERDICT[v].tone}`}>{counts[v]} {VERDICT[v].label.toLowerCase()}</span>
                ))}
                {!counts.outage && !counts.busy && !counts.near && <span className="oss-pill oss-ok">No site busy or down</span>}
              </span>
            )}
          </div>
          {q.isLoading && <p className="muted">Asking…</p>}
          {q.error && <p className="error">{apiErrorMessage(q.error)}</p>}
          {d && !d.configured && <p className="muted">Network KPIs are not connected yet.</p>}
          {d && d.configured && withKpi === 0 && d.sites.length > 0 && (
            <p className="muted">None of these sites has network KPIs yet. The KPI system may not cover this region.</p>
          )}
          {d && d.sites.length > 0 && (
            <div className="oss-scroll">
              <table className="admin-table oss-table" data-pager="off">
                <thead>
                  <tr>
                    <th>Site</th><th>Why</th><th>Distance</th>
                    <th title="Busiest cell of the site around the problem time">DL PRB at the time</th>
                    <th title="Days in the week with a busy hour at or above the capacity line">Busy days</th>
                    <th title="Lowest availability of any cell that week">Availability</th>
                    <th title="Highest service drop and VoLTE drop of any cell that week">Drop / VoLTE drop</th>
                    <th title="Lowest busy-hour speed per user of any cell that week">Speed per user</th>
                    <th>Verdict</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {d.sites.map((s) => {
                    const a = s.at_problem, w = s.week, v = VERDICT[s.verdict]
                    const on = picked === s.site_id
                    return (
                      <Fragment key={s.site_id}>
                        <tr className={on ? 'oss-on' : ''}>
                          <td><Link to={siteLink(s.site_id)}><b>{s.site_id}</b></Link>
                            {s.name && <div className="muted oss-note">{s.name}</div>}</td>
                          <td>{s.roles.map((r) => <span key={r} className={`oss-role oss-role-${r}`}>{ROLE[r]}</span>)}
                            {s.readings ? <div className="muted oss-note">{s.readings.toLocaleString()} readings</div> : null}</td>
                          <td className="mono">{where(s)}</td>
                          <td className="mono">{a?.prb_dl != null ? <><b className={a.busy ? 'ck-bad' : a.prb_dl >= d.busy_prb - 10 ? 'ck-warn' : 'ck-ok'}>{fmt(a.prb_dl)}%</b>
                            <div className="muted oss-note">{a.sector ?? a.cell_name}{a.hour != null ? ` · ${String(a.hour).padStart(2, '0')}:00` : ''}</div></> : '—'}</td>
                          <td className="mono">{w ? `${w.busy_days} / ${w.days}` : '—'}</td>
                          <td className="mono">{w?.availability_min != null ? `${fmt(w.availability_min, 2)}%` : '—'}</td>
                          <td className="mono">{w ? `${fmt(w.service_drop_max, 2)} / ${fmt(w.volte_drop_max, 2)}%` : '—'}</td>
                          <td className="mono">{w?.thr_dl_user_min != null ? `${fmt(w.thr_dl_user_min)} Mbps` : '—'}</td>
                          <td><span className={`oss-pill oss-${v.tone}`} title={s.verdict_text}>{v.label}</span>
                            <div className="muted oss-note">{s.verdict_text}</div></td>
                          <td>{s.verdict !== 'none' && (
                            <button type="button" className="btn-secondary btn-small" onClick={() => setPicked(on ? null : s.site_id)}>
                              {on ? 'Hide cells' : 'Cells'}</button>)}</td>
                        </tr>
                        {on && (
                          <tr className="oss-detail"><td colSpan={10}><SiteCellKpis siteId={s.site_id} /></td></tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {d && d.sites.some((s) => s.figures_from) && (
            <p className="muted pdd-small">Sites with no figures in the complaint's week show their newest figures instead; the verdict names the date.</p>
          )}
        </>
      )}
    </section>
  )
}
