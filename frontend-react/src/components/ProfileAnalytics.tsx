import { Link } from 'react-router-dom'
import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { SubscriberAnalytics } from '../api/types'
import { RSRP_BANDS, RSRQ_BANDS, RXLEV_BANDS, SINR_BANDS, bandColor, type Band } from '../lib/dtBands'
import { NET_LABEL, NET_ORDER, netColor } from '../lib/netColors'
import { ColumnChart, HBars, ShareBar, type Column } from './ProfileCharts'
import FitToPoints from './FitToPoints'
import SectorBreakdown from './SectorBreakdown'

// The analysis cards of the Subscriber Profile (2026-10-16), after the
// patterns of NTC's ticketing system (UTS): measured capability, quality by
// network, daily trend, time of day, signal distributions, and the cells and
// sites the customer used. Built from the phone's own readings, so every
// view carries signal quality. No exact positions: sites are masts.

const QUALITY = [
  { key: 'weak', label: 'Weak', color: 'var(--sp-rose)' },
  { key: 'fair', label: 'Fair', color: 'var(--sp-amber)' },
  { key: 'good', label: 'Good', color: 'var(--sp-green)' },
  { key: 'no_level', label: 'No level', color: 'var(--sp-faint)' },
] as const

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const fmt = (iso: string) => new Date(iso).toLocaleString()
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const techOf = (n: string) => NET_LABEL[n] ?? n

function Section({ id, icon, title, note, children }: { id: string; icon: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="sp-card sp-wide" id={id}>
      <div className="sp-card-head">
        <span className="sp-card-icon" aria-hidden>{icon}</span>
        <span className="sp-card-title">{title}</span>
        {note && <span className="sp-card-none" style={{ fontStyle: 'normal' }}>{note}</span>}
      </div>
      <div className="sp-card-body">{children}</div>
    </section>
  )
}

function Histogram({ title, bins, bands, unit }: {
  title: string; bins: { from: number; to: number; readings: number }[]; bands: Band[]; unit: string
}) {
  if (!bins.length) return null
  const total = bins.reduce((a, b) => a + b.readings, 0)
  const columns: Column[] = bins.map((b) => ({
    key: String(b.from), label: String(b.from),
    segments: [{ key: 'n', value: b.readings, color: bandColor(bands, (b.from + b.to) / 2), label: title }],
    tip: [`${b.from} to ${b.to} ${unit}`, `${b.readings.toLocaleString()} readings (${pct(b.readings, total)}%)`],
  }))
  return (
    <div className="spc-mini">
      <div className="spc-mini-title">{title} <span className="sp-muted">· {total.toLocaleString()}</span></div>
      <ColumnChart columns={columns} height={120} every={Math.max(1, Math.ceil(columns.length / 6))} ariaLabel={`${title} distribution`} />
    </div>
  )
}

export default function ProfileAnalytics({ a, callsByOutcome, phone, siteLink, scope }: {
  a: SubscriberAnalytics
  // What the signal filter shows, e.g. "Last 7 days of readings · 4G only" (2026-10-19).
  scope?: string
  callsByOutcome: Record<string, number>
  phone: string | null
  siteLink: (siteId: string) => string
}) {
  const total = a.networks.reduce((s, n) => s + n.readings, 0)
  const on4g = a.networks.filter((n) => n.network_type === 'LTE' || n.network_type === 'NR').reduce((s, n) => s + n.readings, 0)
  const weak = a.networks.reduce((s, n) => s + n.weak, 0)
  const withLevel = a.networks.reduce((s, n) => s + n.readings - n.no_level, 0)
  const calls = Object.values(callsByOutcome).reduce((x, y) => x + y, 0)
  const nets = NET_ORDER.filter((n) => a.networks.some((x) => x.network_type === n))
  const bandTotal = a.bands.reduce((s, b) => s + b.readings, 0)

  const daily: Column[] = a.daily.map((d) => ({
    key: d.day, label: dayLabel(d.day),
    segments: nets.map((n) => ({ key: n, value: d.by_network[n] ?? 0, color: netColor(n), label: techOf(n) })),
    tip: [dayLabel(d.day), `${d.readings.toLocaleString()} readings`,
      ...nets.filter((n) => d.by_network[n]).map((n) => `${techOf(n)}: ${d.by_network[n]}`),
      `Weak: ${pct(d.weak, d.readings)}%`, d.level_avg != null ? `Average level ${d.level_avg} dBm` : ''].filter(Boolean),
  }))
  const hourly: Column[] = Array.from({ length: 24 }, (_, h) => {
    const r = a.hours.find((x) => x.hour === h)
    return {
      key: String(h), label: String(h).padStart(2, '0'),
      segments: [
        { key: 'weak', value: r?.weak ?? 0, color: 'var(--sp-rose)', label: 'Weak' },
        { key: 'rest', value: (r?.readings ?? 0) - (r?.weak ?? 0), color: 'var(--sp-cyan)', label: 'Not weak' },
      ],
      tip: [`${String(h).padStart(2, '0')}:00 to ${String(h).padStart(2, '0')}:59`, `${(r?.readings ?? 0).toLocaleString()} readings`,
        `Weak: ${pct(r?.weak ?? 0, r?.readings ?? 0)}%`, r?.level_avg != null ? `Average level ${r.level_avg} dBm` : ''].filter(Boolean),
    }
  })

  // Cells the site list does not know: the sector table cannot show them.
  const unknownCells = a.cells.filter((c) => !c.site_id)
  const mapSites = a.sites.filter((s) => s.lat != null && s.lng != null)
  const weakColor = (w: number, n: number) => (pct(w, n) >= 30 ? 'var(--sp-rose)' : pct(w, n) >= 10 ? 'var(--sp-amber)' : 'var(--sp-green)')
  const weakHex = (w: number, n: number) => (pct(w, n) >= 30 ? '#e11d48' : pct(w, n) >= 10 ? '#d97706' : '#059669')

  return (
    <>
      <Section id="sp-capability" icon="🧪" title="Measured network and quality"
        note={scope ? `Signal filter: ${scope}` : "From the phone's own readings"}>
        <div className="spc-tiles">
          <div className="spc-tile"><span>Time on 4G/5G</span><b>{pct(on4g, total)}%</b>
            <div className="spc-meter"><i style={{ width: `${pct(on4g, total)}%`, background: netColor('LTE') }} /></div></div>
          <div className="spc-tile"><span>Weak signal</span><b>{pct(weak, withLevel)}%</b>
            <div className="spc-meter"><i style={{ width: `${pct(weak, withLevel)}%`, background: 'var(--sp-rose)' }} /></div>
            <small>of readings with a level</small></div>
          <div className="spc-tile"><span>Calls on VoLTE</span><b>{calls ? `${pct(callsByOutcome.volte ?? 0, calls)}%` : '—'}</b>
            {calls ? <div className="spc-meter"><i style={{ width: `${pct(callsByOutcome.volte ?? 0, calls)}%`, background: 'var(--sp-green)' }} /></div> : null}
            <small>{calls ? `${calls} calls recorded` : 'No calls recorded'}</small></div>
          <div className="spc-tile"><span>Sites served</span><b>{a.sites_count ?? a.sites.length}{a.cells_capped ? '+' : ''}</b><small>{a.cells_count ?? a.cells.length} cells</small></div>
          <div className="spc-tile"><span>4G bands seen</span>
            <div className="spc-chips">
              {a.bands.length ? a.bands.map((b) => <em key={`${b.network_type}${b.band_label}`}>{b.band_label} · {pct(b.readings, bandTotal)}%</em>) : <small>None reported</small>}
            </div></div>
          <div className="spc-tile"><span>Phone</span><b className="spc-small">{phone ?? '—'}</b></div>
        </div>
        <div className="spc-quality">
          {a.networks.filter((n) => n.network_type in NET_LABEL).map((n) => (
            <div key={n.network_type} className="spc-quality-row">
              <div className="spc-quality-head">
                <i style={{ background: netColor(n.network_type) }} /><b>{techOf(n.network_type)}</b>
                <span className="sp-muted"> · {n.readings.toLocaleString()} readings ({pct(n.readings, total)}%)</span>
                <span className="sp-mono sp-muted spc-quality-avg">
                  {[n.level_avg != null ? `level ${n.level_avg} dBm` : '', n.rsrq_avg != null ? `RSRQ ${n.rsrq_avg}` : '', n.sinr_avg != null ? `SINR ${n.sinr_avg}` : ''].filter(Boolean).join(' · ')}
                </span>
              </div>
              <ShareBar parts={QUALITY.map((q) => ({ key: q.key, label: q.label, value: n[q.key], color: q.color }))} />
            </div>
          ))}
          <div className="sp-muted spc-foot">
            Weak below {a.limits.weak_dbm['4G']} dBm on 4G, {a.limits.weak_dbm['3G']} on 3G, {a.limits.weak_dbm['2G']} on 2G;
            good from {a.limits.good_dbm['4G']}, {a.limits.good_dbm['3G']} and {a.limits.good_dbm['2G']}: the problem check's limits.
          </div>
        </div>
      </Section>

      {/* Day and hour side by side, kept small (2026-10-19). */}
      <Section id="sp-trend" icon="📅" title="Readings over time" note={`Nepal time${scope ? ` · ${scope}` : ''}`}>
        <div className="spc-two">
          <div>
            <div className="spc-mini-title">Per day <span className="sp-muted">· last {a.daily.length} days with readings</span></div>
            <ColumnChart columns={daily} height={110} every={Math.max(1, Math.ceil(daily.length / 6))} ariaLabel="Readings per day by network" />
            <div className="sp-legend">{nets.map((n) => <span key={n}><i style={{ background: netColor(n) }} />{techOf(n)}</span>)}</div>
          </div>
          <div>
            <div className="spc-mini-title">Time of day</div>
            <ColumnChart columns={hourly} height={110} every={4} ariaLabel="Readings per hour of the day, weak share in red" />
            <div className="sp-legend">
              <span><i style={{ background: 'var(--sp-rose)' }} />Weak</span>
              <span><i style={{ background: 'var(--sp-cyan)' }} />Not weak</span>
            </div>
          </div>
        </div>
      </Section>

      <Section id="sp-distribution" icon="📊" title="Signal distribution" note={scope}>
        <div className="spc-minis">
          <Histogram title="4G level (RSRP)" bins={a.histograms.level['4G']} bands={RSRP_BANDS} unit="dBm" />
          <Histogram title="3G level (RSCP)" bins={a.histograms.level['3G']} bands={RSRP_BANDS} unit="dBm" />
          <Histogram title="2G level (RxLev)" bins={a.histograms.level['2G']} bands={RXLEV_BANDS} unit="dBm" />
          <Histogram title="4G RSRQ" bins={a.histograms.rsrq} bands={RSRQ_BANDS} unit="dB" />
          <Histogram title="4G SINR" bins={a.histograms.sinr} bands={SINR_BANDS} unit="dB" />
        </div>
        <div className="sp-muted spc-foot">Bars coloured by the drive-test colour scale of each measure.</div>
      </Section>

      {a.location_shown === false ? (
        <section className="sp-card sp-card-empty" id="sp-cells">
          <div className="sp-card-head">
            <span className="sp-card-icon" aria-hidden>🗼</span>
            <span className="sp-card-title">Location history: sites, sectors and cells</span>
            <span className="sp-count">{a.cells_count ?? 0}</span>
            <span className="sp-card-none" style={{ fontStyle: 'normal' }}>
              🔒 {a.cells_count ?? 0} cells, {a.sectors_count ?? 0} sectors at {a.sites_count ?? 0} sites; shown only while an emergency is declared
            </span>
          </div>
        </section>
      ) : (
      <Section id="sp-cells" icon="🗼" title="Location history: sites, sectors and cells"
        note={`Serving cells${a.cells_capped ? ', busiest 60' : ''} · emergency declared${scope ? ` · ${scope}` : ''}`}>
        <div className="spc-sites">
          <div>
            <div className="spc-mini-title">Readings per site <span className="sp-muted">· colour: share of weak readings</span></div>
            <HBars rows={a.sites.slice(0, 10).map((s) => ({
              key: s.site_id,
              label: <Link to={siteLink(s.site_id)} title={s.district ?? undefined}>{s.site_id}{s.name ? <span className="sp-muted"> {s.name}</span> : null}</Link>,
              value: s.readings, color: weakColor(s.weak, s.readings), note: `· ${pct(s.weak, s.readings)}% weak`,
              tip: `${s.site_id}${s.name ? ` ${s.name}` : ''}: ${s.readings} readings, ${pct(s.weak, s.readings)}% weak${s.level_avg != null ? `, average ${s.level_avg} dBm` : ''}`,
            }))} />
            <div className="sp-legend">
              <span><i style={{ background: 'var(--sp-green)' }} />under 10% weak</span>
              <span><i style={{ background: 'var(--sp-amber)' }} />10 to 30%</span>
              <span><i style={{ background: 'var(--sp-rose)' }} />30% or more</span>
            </div>
          </div>
          {mapSites.length > 0 && (
            <div className="spc-sites-map">
              <MapContainer center={[27.7, 85.3]} zoom={9} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} attributionControl={false}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <FitToPoints points={mapSites.map((s) => [s.lat as number, s.lng as number])} fitKey={mapSites.length} singleZoom={14} />
                {mapSites.map((s) => (
                  <CircleMarker key={s.site_id} center={[s.lat as number, s.lng as number]} radius={Math.min(16, 5 + Math.log2(s.readings + 1))}
                    pathOptions={{ color: '#1e293b', weight: 1, fillColor: weakHex(s.weak, s.readings), fillOpacity: 0.85 }}>
                    <Tooltip>{`${s.site_id}${s.name ? ` ${s.name}` : ''} · ${s.readings} readings · ${pct(s.weak, s.readings)}% weak`}</Tooltip>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
          )}
        </div>
        {/* Sectors and cells merged (2026-10-19): one table per serving
            sector with its quality, and the cells the site list does not know. */}
        <div style={{ marginTop: 12 }}>
          <SectorBreakdown siteLink={siteLink} title="Sectors served" data={{
            sectors: a.sectors ?? [], total,
            matched: (a.sectors ?? []).reduce((x, r) => x + r.readings, 0),
            unmatched: a.sectors_unmatched ?? 0, capped: (a.sectors ?? []).length >= 80,
          }} />
        </div>
        {unknownCells.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="spc-mini-title">Cells not in the site list <span className="sp-muted">· {unknownCells.length}</span></div>
            <div className="sp-scroll">
              <table className="sp-table" data-pager="off">
                <thead><tr><th>Cell</th><th>Network</th><th>Readings</th><th>Avg level</th><th>Weak</th><th>Last seen</th></tr></thead>
                <tbody>
                  {unknownCells.slice(0, 20).map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{[c.cell_id != null ? `CI ${c.cell_id}` : '', c.pci != null ? `PCI ${c.pci}` : '', c.tac != null ? `TAC ${c.tac}` : ''].filter(Boolean).join(' · ')}</td>
                      <td><span className="spc-dot" style={{ background: netColor(c.network_type) }} />{techOf(c.network_type)}</td>
                      <td className="mono">{c.readings}</td>
                      <td className="mono">{c.level_avg ?? '—'}</td>
                      <td className="mono">{pct(c.weak, c.readings)}%</td>
                      <td>{fmt(c.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>
      )}
    </>
  )
}
