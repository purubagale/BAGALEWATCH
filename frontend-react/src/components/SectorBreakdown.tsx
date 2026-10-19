import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SectorBreakdownData, SectorStat } from '../api/types'

// Readings per serving sector (2026-10-19), the same table on the Subscriber
// Profile, a drive-test session, a phone drive on Collections and a
// Telemetry Drive Test session (server: core/sector_stats.py). Each row shows
// how much the sector served (share bar) and how well (weak / fair / good
// bar, the problem check's limits), with the averages beside it. Sortable;
// the quality colours always carry a legend.

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const num = (v: number | null, unit = '') => (v == null ? '—' : `${v}${unit}`)

type SortKey = 'readings' | 'weak' | 'level' | 'sinr' | 'last'

const QUALITY = [
  { key: 'weak', label: 'Weak', color: '#dc2626' },
  { key: 'fair', label: 'Fair', color: '#eab308' },
  { key: 'good', label: 'Good', color: '#16a34a' },
  { key: 'no_level', label: 'No level', color: '#94a3b8' },
] as const

function QualityBar({ s }: { s: SectorStat }) {
  const tip = QUALITY.map((q) => `${q.label} ${pct(s[q.key], s.readings)}%`).join(' · ')
  return (
    <div className="secb-qbar" title={tip} aria-label={tip} role="img">
      {QUALITY.map((q) => (s[q.key] > 0 ? <i key={q.key} style={{ width: `${pct(s[q.key], s.readings)}%`, background: q.color }} /> : null))}
    </div>
  )
}

export default function SectorBreakdown({ data, siteLink, showDl = false, title = 'By serving sector', limitRows = 15 }: {
  data: SectorBreakdownData | null | undefined
  siteLink?: (siteId: string) => string
  showDl?: boolean
  title?: string
  limitRows?: number
}) {
  const [sort, setSort] = useState<SortKey>('readings')
  const [all, setAll] = useState(false)
  const rows = useMemo(() => [...(data?.sectors ?? [])].sort((a, b) => {
    if (sort === 'weak') return pct(b.weak, b.readings) - pct(a.weak, a.readings)
    if (sort === 'level') return (a.level_avg ?? 0) - (b.level_avg ?? 0)
    if (sort === 'sinr') return (a.sinr_avg ?? 99) - (b.sinr_avg ?? 99)
    if (sort === 'last') return (b.last ?? '').localeCompare(a.last ?? '')
    return b.readings - a.readings
  }), [data, sort])
  if (!data) return null
  const maxShare = Math.max(1, ...rows.map((r) => r.readings))
  const shown = all ? rows : rows.slice(0, limitRows)
  const worst = [...rows].filter((r) => r.readings >= 10).sort((a, b) => pct(b.weak, b.readings) - pct(a.weak, a.readings))[0]
  const th = (key: SortKey, label: string) => (
    <th><button type="button" className={`secb-sort${sort === key ? ' on' : ''}`} onClick={() => setSort(key)}>{label}{sort === key ? ' ▾' : ''}</button></th>
  )

  return (
    <div className="secb">
      <div className="secb-head">
        <b>{title}</b>
        <span className="secb-muted">
          {rows.length} sector{rows.length === 1 ? '' : 's'}{data.capped ? ' (busiest shown)' : ''} · {data.matched.toLocaleString()} of {data.total.toLocaleString()} readings matched
          {data.unmatched ? ` · ${data.unmatched.toLocaleString()} with no known sector` : ''}
        </span>
        <span className="secb-legend">
          {QUALITY.map((q) => <span key={q.key}><i style={{ background: q.color }} />{q.label}</span>)}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="secb-muted">No reading here could be matched to a sector.</div>
      ) : (
        <>
          {worst && pct(worst.weak, worst.readings) >= 20 && (
            <div className="secb-note">
              Weakest: <b>{worst.site_id} {worst.sector ?? ''}</b> with {pct(worst.weak, worst.readings)}% weak readings
              ({worst.readings} readings{worst.level_avg != null ? `, average ${worst.level_avg} dBm` : ''}).
            </div>
          )}
          <div className="secb-scroll">
            <table className="secb-table" data-pager="off">
              <thead>
                <tr>
                  <th>Site</th><th>Sector</th><th>Network</th>
                  {th('readings', 'Readings')}
                  {th('weak', 'Quality')}
                  {th('level', 'Level')}
                  <th>RSRQ</th>
                  {th('sinr', 'SINR')}
                  <th>CQI</th>
                  {showDl && <th>Download</th>}
                  <th>Distance</th>
                  {th('last', 'Last served')}
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={`${s.site_id}|${s.sector}|${s.network_type}`}>
                    <td title={[s.site_name, s.district].filter(Boolean).join(' · ') || undefined}>
                      {siteLink ? <Link to={siteLink(s.site_id)}>{s.site_id}</Link> : s.site_id}
                      {s.site_name && s.site_name !== s.site_id && <div className="secb-muted secb-small">{s.site_name}</div>}
                    </td>
                    <td title={s.cell_name ?? undefined}>
                      <b>{s.sector ?? '—'}</b>
                      {(s.cell_id != null || s.pci != null) && (
                        <div className="secb-muted secb-small secb-id">
                          {[s.cell_id != null ? `CI ${s.cell_id}` : '', s.pci != null && s.tech === '4G' ? `PCI ${s.pci}` : '', s.tac != null ? `${s.tech === '4G' ? 'TAC' : 'LAC'} ${s.tac}` : ''].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>{s.tech}{s.band_label ? <span className="secb-muted"> · {s.band_label}</span> : null}</td>
                    <td className="secb-num">
                      <div className="secb-share"><i style={{ width: `${(100 * s.readings) / maxShare}%` }} /></div>
                      {s.readings.toLocaleString()} <span className="secb-muted">({num(s.share_pct, '%')})</span>
                    </td>
                    <td><QualityBar s={s} /><span className="secb-muted secb-small">{pct(s.weak, s.readings)}% weak</span></td>
                    <td className="secb-num">{num(s.level_avg, ' dBm')}</td>
                    <td className="secb-num">{num(s.rsrq_avg, ' dB')}</td>
                    <td className="secb-num">{num(s.sinr_avg, ' dB')}</td>
                    <td className="secb-num">{num(s.cqi_avg)}</td>
                    {showDl && <td className="secb-num">{num(s.dl_avg, ' Mbps')}</td>}
                    <td className="secb-num">{s.dist_km_avg != null ? `${s.dist_km_avg} km` : '—'}</td>
                    <td className="secb-small" title={`First ${fmt(s.first)}`}>{fmt(s.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limitRows && (
            <button type="button" className="secb-more" onClick={() => setAll(!all)}>
              {all ? `Show the busiest ${limitRows}` : `Show all ${rows.length} sectors`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
