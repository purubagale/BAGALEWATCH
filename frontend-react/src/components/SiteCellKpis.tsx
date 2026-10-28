import { useState } from 'react'
import { useSiteCellKpis } from '../api/queries'
import type { CellKpiFigures, SiteCellKpiCell } from '../api/types'

// Network KPIs of a site's 4G cells (2026-10-28, core/cell_kpi.py): the
// newest busy-hour and whole-day figures from the KPI team, a 7-day line of
// busy-hour DL PRB, and the CQI our drive tests measured on the same sector.

const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d).replace(/\.0+$/, ''))

function prbClass(v: number | null | undefined, busy: number) {
  if (v == null) return ''
  return v >= busy ? 'ck-bad' : v >= busy - 10 ? 'ck-warn' : 'ck-ok'
}

function Spark({ cell, busy }: { cell: SiteCellKpiCell; busy: number }) {
  const pts = cell.series.map((p) => p.bbh?.prb_dl ?? p.day?.prb_dl ?? null)
  if (pts.filter((v) => v != null).length < 2) return <span className="muted">—</span>
  const w = 90, h = 26, n = pts.length
  const x = (i: number) => (n === 1 ? w / 2 : (i * (w - 4)) / (n - 1) + 2)
  const y = (v: number) => h - 2 - (Math.min(100, Math.max(0, v)) / 100) * (h - 4)
  const line = pts.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ')
  const title = cell.series.map((p) => `${p.date}: ${fmt(p.bbh?.prb_dl ?? p.day?.prb_dl)}%`).join('\n')
  return (
    <svg width={w} height={h} className="ck-spark" role="img" aria-label="DL PRB, last days">
      <title>{title}</title>
      <line x1={0} x2={w} y1={y(busy)} y2={y(busy)} className="ck-spark-limit" />
      <polyline points={line} className="ck-spark-line" />
      {pts.map((v, i) => (v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={2} className={prbClass(v, busy)} />))}
    </svg>
  )
}

export default function SiteCellKpis({ siteId }: { siteId: string }) {
  const [days, setDays] = useState(7)
  const [view, setView] = useState<'bbh' | 'day'>('bbh')
  const { data, isLoading, error } = useSiteCellKpis(siteId, days)
  if (isLoading) return <section className="site-card"><div className="site-form-section" data-icon="📶">Network KPIs</div><p className="muted">Loading…</p></section>
  if (error || !data) return null
  const busy = data.busy_prb
  const has = data.cells.length > 0
  const anyBbh = data.cells.some((c) => c.bbh)
  const shown = view === 'bbh' && anyBbh ? 'bbh' : 'day'
  const pick = (c: SiteCellKpiCell): CellKpiFigures | null => c[shown] ?? null
  const busyHour = data.cells.map((c) => c.bbh?.busy_hour).find((v) => v != null)
  return (
    <section className="site-card">
      <div className="site-form-section" data-icon="📶">
        Network KPIs
        {has && <span className="muted ck-sub">{data.newest_date}{shown === 'bbh' && busyHour != null ? ` · busy hour ${String(busyHour).padStart(2, '0')}:00` : ' · whole day'}</span>}
      </div>
      {!has ? (
        <p className="muted">{data.configured ? 'No network KPIs have been received for this site yet.' : 'Network KPIs are not connected yet.'}</p>
      ) : (
        <>
          <div className="ck-controls">
            <div className="ck-seg" role="group" aria-label="Period">
              <button type="button" className={shown === 'bbh' ? 'on' : ''} disabled={!anyBbh} onClick={() => setView('bbh')}>Busy hour</button>
              <button type="button" className={shown === 'day' ? 'on' : ''} onClick={() => setView('day')}>Whole day</button>
            </div>
            <label className="muted">Trend over
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <span className="muted">Red: DL PRB {busy}% or more, the usual capacity line.</span>
          </div>
          <div className="ck-scroll">
            <table className="admin-table ck-table" data-pager="off">
              <thead>
                <tr>
                  <th>Sector</th><th>Band</th>
                  <th title="Share of downlink resource blocks in use">DL PRB</th>
                  <th title="Share of uplink resource blocks in use">UL PRB</th>
                  <th>Users avg / max</th>
                  <th title="Average downlink speed per user">Per user</th>
                  <th title="Downlink speed of the whole cell">Cell DL</th>
                  <th>Traffic</th>
                  <th title="CQI the network reports; beside it the CQI our drive tests measured on this sector">CQI network / drive tests</th>
                  <th>RRC / E-RAB</th>
                  <th>Drop / VoLTE drop</th>
                  <th>Availability</th>
                  <th title="Busy-hour DL PRB per day; the line is the capacity limit">DL PRB, {days} days</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.cells.map((c) => {
                  const f = pick(c)
                  const partial = f?.integrity != null && f.integrity < 1
                  return (
                    <tr key={c.cell_name}>
                      <td title={c.cell_name}><b>{c.sector || '—'}</b>{c.azimuth != null ? <span className="muted"> {Math.round(c.azimuth)}°</span> : null}
                        {!c.matched && <div className="muted ck-note">not in the site list</div>}</td>
                      <td>{c.band || '—'}</td>
                      <td className={`mono ${prbClass(f?.prb_dl, busy)}`}>{fmt(f?.prb_dl)}%</td>
                      <td className={`mono ${prbClass(f?.prb_ul, busy)}`}>{fmt(f?.prb_ul)}%</td>
                      <td className="mono">{fmt(f?.users_avg, 0)} / {fmt(f?.users_max, 0)}</td>
                      <td className="mono">{fmt(f?.thr_dl_user)} Mbps</td>
                      <td className="mono">{fmt(f?.thr_dl_cell)} Mbps</td>
                      <td className="mono">{fmt(f?.traffic_gb)} GB</td>
                      <td className="mono">{fmt(f?.cqi_avg)}{c.drive_test_cqi
                        ? <span className="muted" title={`${c.drive_test_cqi.n.toLocaleString()} drive-test readings in the last year`}> / {fmt(c.drive_test_cqi.avg)}</span>
                        : <span className="muted"> / —</span>}</td>
                      <td className="mono">{fmt(f?.rrc_sr, 2)} / {fmt(f?.erab_sr, 2)}%</td>
                      <td className="mono">{fmt(f?.service_drop, 2)} / {fmt(f?.volte_drop, 2)}%</td>
                      <td className="mono">{fmt(f?.availability, 2)}%{partial && <div className="muted ck-note" title="Some hours of this period were not collected">partial</div>}</td>
                      <td><Spark cell={c} busy={busy} /></td>
                      <td>{c.dashboard_url && <a href={c.dashboard_url} target="_blank" rel="noreferrer">KPI dashboard ↗</a>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
