import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useSubscriberProfile } from '../api/queries'
import type { SubscriberProfile } from '../api/types'
import { OPAQUE_PATHS } from '../constants/opaqueRoutes'
import RowsPerPageSelect from '../components/RowsPerPageSelect'
import LinkEarlierReadings from '../components/LinkEarlierReadings'
import { useRowsPerPage } from '../lib/rowsPerPage'

// Subscriber Profile (2026-10-15, core/subscriber_profile.py). Superadmin:
// everything the server already holds about one mobile number, to help solve
// a customer's problem. Each server search needs a ticket or case reference
// and is logged. The exact last position shows only while an emergency is
// declared, the same rule as the location lookups; the serving site (a mast)
// is always drawn.
//
// Design after the TelcoPulse console the user pointed to (styles .sp-* in
// App.css). The number and reason live in the page address, every link out
// carries `back=` (BackToProfileBar shows the way back), and the scroll
// position is put back on return.

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')
const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : '—')
const num = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${v}${unit}`)
const short = (id: string) => `${id.slice(0, 12)}…`
const SCROLL_KEY = 'dtwatch_profile_scroll'
// Live Samples' "All stored readings" window for one device (90 days).
const ALL_STORED_MINUTES = 90 * 24 * 60

const NET_COLOR: Record<string, string> = { LTE: '#22d3ee', NR: '#a78bfa', UMTS: '#818cf8', GSM: '#fbbf24' }
const netColor = (n: string) => NET_COLOR[n] ?? '#64748b'
const OUTCOME: Record<string, { label: string; color: string }> = {
  volte: { label: 'Stayed on VoLTE / VoNR', color: '#34d399' },
  vowifi: { label: 'Wi-Fi calling', color: '#22d3ee' },
  fallback: { label: 'Fell back to 2G/3G', color: '#fbbf24' },
  legacy: { label: '2G/3G only', color: '#fb7185' },
  unknown: { label: 'Unknown', color: '#64748b' },
}

function Card({ id, icon, title, count, link, wide, empty, emptyText, children }: {
  id: string; icon: string; title: string; count?: number; link?: { to: string; label: string } | null
  wide?: boolean; empty?: boolean; emptyText?: string; children?: ReactNode
}) {
  const cls = ['sp-card', wide && !empty ? 'sp-wide' : '', empty ? 'sp-card-empty' : ''].filter(Boolean).join(' ')
  return (
    <section className={cls} id={id}>
      <div className="sp-card-head">
        <span className="sp-card-icon" aria-hidden>{icon}</span>
        <span className="sp-card-title">{title}</span>
        {count != null && <span className={`sp-count${count === 0 ? ' zero' : ''}`}>{count}</span>}
        {link && !empty && <Link className="sp-card-link" to={link.to}>{link.label} →</Link>}
        {empty && <span className="sp-card-none">{emptyText ?? 'None stored'}</span>}
      </div>
      {!empty && <div className="sp-card-body">{children}</div>}
    </section>
  )
}

// A table that shows 10 rows at a time with a pager underneath.
function Paged<T>({ rows, head, row }: { rows: T[]; head: ReactNode; row: (r: T, i: number) => ReactNode }) {
  const [page, setPage] = useState(0)
  const [PAGE] = useRowsPerPage()
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const at = Math.min(page, pages - 1)
  const shown = rows.slice(at * PAGE, at * PAGE + PAGE)
  return (
    <>
      <div className="sp-scroll">
        <table className="sp-table" data-pager="off">
          <thead>{head}</thead>
          <tbody>{shown.map((r, i) => row(r, at * PAGE + i))}</tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <div className="sp-pager">
          <RowsPerPageSelect />
          <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)}>‹</button>
          <span>{at * PAGE + 1}–{Math.min(rows.length, at * PAGE + PAGE)} of {rows.length}</span>
          <button type="button" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>›</button>
        </div>
      )}
    </>
  )
}

// Signal level over the newest readings, coloured by network.
function SignalChart({ series }: { series: SubscriberProfile['signal_series'] }) {
  const pts = series.filter((s) => s.level_dbm != null)
  if (pts.length < 2) return <div className="sp-empty">Too few readings for a chart.</div>
  const W = 640, H = 150, L = 34, R = 6, T = 8, B = 20
  const lo = -130, hi = -40
  const x = (i: number) => L + (i * (W - L - R)) / (pts.length - 1)
  const y = (v: number) => T + ((hi - Math.max(lo, Math.min(hi, v))) * (H - T - B)) / (hi - lo)
  const nets = Array.from(new Set(pts.map((p) => p.network_type)))
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="sp-chart" role="img" aria-label="Signal level over the newest readings">
        {[-110, -90, -70, -50].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="sp-grid-line" />
            <text x={L - 6} y={y(g) + 3} className="sp-axis" textAnchor="end">{g}</text>
          </g>
        ))}
        <rect x={L} y={y(-105)} width={W - L - R} height={y(-130) - y(-105)} className="sp-weak-band" />
        <polyline className="sp-line" points={pts.map((p, i) => `${x(i)},${y(p.level_dbm as number)}`).join(' ')} />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.level_dbm as number)} r={2.4} fill={netColor(p.network_type)}>
            <title>{`${fmt(p.ts)} · ${p.network_type} ${p.level_dbm} dBm`}</title>
          </circle>
        ))}
        <text x={L} y={H - 4} className="sp-axis">{fmtDate(pts[0].ts)}</text>
        <text x={W - R} y={H - 4} className="sp-axis" textAnchor="end">{fmtDate(pts[pts.length - 1].ts)}</text>
      </svg>
      <div className="sp-legend">
        {nets.map((n) => <span key={n}><i style={{ background: netColor(n) }} />{n || 'unknown'}</span>)}
        <span><i style={{ background: 'rgba(251,113,133,0.35)' }} />weak (below −105 dBm)</span>
      </div>
    </div>
  )
}

// Share of readings per network, as a ring.
function NetworkRing({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0)
  const total = entries.reduce((a, [, v]) => a + v, 0)
  if (!total) return null
  const R = 42, C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="sp-ring">
      <svg viewBox="0 0 110 110" width={110} height={110} role="img" aria-label="Readings by network">
        <circle cx={55} cy={55} r={R} className="sp-ring-track" />
        {entries.map(([k, v]) => {
          const len = (v / total) * C
          const el = <circle key={k} cx={55} cy={55} r={R} fill="none" stroke={netColor(k)} strokeWidth={14}
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 55 55)"><title>{`${k || 'unknown'}: ${v}`}</title></circle>
          offset += len
          return el
        })}
        <text x={55} y={53} textAnchor="middle" className="sp-ring-num">{total.toLocaleString()}</text>
        <text x={55} y={67} textAnchor="middle" className="sp-axis">readings</text>
      </svg>
      <div className="sp-ring-legend">
        {entries.map(([k, v]) => <div key={k}><i style={{ background: netColor(k) }} />{k || 'unknown'} <b className="sp-mono">{Math.round((100 * v) / total)}%</b></div>)}
      </div>
    </div>
  )
}

// Download speed per test, oldest to newest; Wi-Fi in indigo.
function SpeedChart({ tests }: { tests: SubscriberProfile['speed_tests'] }) {
  const pts = tests.filter((t) => t.download_mbps != null).slice(0, 40).reverse()
  if (pts.length === 0) return null
  const W = 640, H = 110, L = 34, B = 16, T = 6
  const max = Math.max(1, ...pts.map((p) => p.download_mbps as number))
  const bw = Math.min(28, (W - L - 4) / pts.length - 4)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sp-chart" role="img" aria-label="Download speed per test">
      <text x={L - 6} y={T + 8} className="sp-axis" textAnchor="end">{Math.round(max)}</text>
      <text x={L - 6} y={H - B} className="sp-axis" textAnchor="end">0</text>
      <line x1={L} x2={W} y1={H - B} y2={H - B} className="sp-grid-line" />
      {pts.map((p, i) => {
        const h = ((p.download_mbps as number) / max) * (H - B - T)
        return (
          <rect key={i} x={L + 4 + i * (bw + 4)} y={H - B - h} width={bw} height={h} rx={3}
            fill={p.bearer === 'wifi' ? '#818cf8' : '#22d3ee'}>
            <title>{`${fmt(p.ts)} · ${p.bearer === 'wifi' ? 'Wi-Fi' : 'mobile data'} · ${p.download_mbps} Mbps`}</title>
          </rect>
        )
      })}
      <text x={L} y={H - 2} className="sp-axis">Download, Mbps · cyan mobile data, indigo Wi-Fi</text>
    </svg>
  )
}

// Serving site on a small map; the customer's own position only in an emergency.
function SiteMap({ loc }: { loc: NonNullable<SubscriberProfile['last_location']> }) {
  if (loc.site_lat == null || loc.site_lng == null) return null
  const site: [number, number] = [loc.site_lat, loc.site_lng]
  const own: [number, number] | null = loc.lat != null && loc.lng != null ? [loc.lat, loc.lng] : null
  return (
    <div className="sp-map">
      <MapContainer center={site} zoom={14} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} attributionControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <CircleMarker center={site} radius={8} pathOptions={{ color: '#4f46e5', fillColor: '#818cf8', fillOpacity: 0.9, weight: 2 }}>
          <Tooltip>{`Serving site ${loc.serving_site_id ?? ''}${loc.site_name ? ` · ${loc.site_name}` : ''}`}</Tooltip>
        </CircleMarker>
        {own && (
          <>
            <Polyline positions={[site, own]} pathOptions={{ color: '#22d3ee', dashArray: '4 6', weight: 2 }} />
            <CircleMarker center={own} radius={6} pathOptions={{ color: '#0891b2', fillColor: '#22d3ee', fillOpacity: 0.95 }}>
              <Tooltip>Last position (emergency)</Tooltip>
            </CircleMarker>
          </>
        )}
      </MapContainer>
    </div>
  )
}

function Profile({ p, out, reason, onChanged }: {
  p: SubscriberProfile; out: (key: string, extra?: Record<string, string>) => string; reason: string; onChanged: () => void
}) {
  const s = p.summary
  const loc = p.last_location
  const mobileTests = p.speed_tests.filter((t) => t.bearer !== 'wifi' && t.download_mbps != null)
  const sortedDl = mobileTests.map((t) => t.download_mbps as number).sort((a, b) => a - b)
  const medianDl = sortedDl.length ? sortedDl[Math.floor(sortedDl.length / 2)] : null
  const callTotal = Object.values(p.calls.by_outcome).reduce((a, b) => a + b, 0)
  const fallbackShare = callTotal ? Math.round((100 * (p.calls.by_outcome.fallback ?? 0)) / callTotal) : null
  const sessions = p.collections.length + p.drive_test_sessions.length + p.trace_requests.length
  const speedCount = p.speed_tests.length + p.trace_speed_tests.length
  const speedDevice = p.speed_tests[0]?.device_id
  const readings = (device: string) => out('/telemetry-live-samples', { device, minutes: String(ALL_STORED_MINUTES) })
  // Each phone's own list page: Registered Devices only for a registered
  // number, Rescue Enrolled for a rescue beacon; nothing when neither applies.
  // Opened with ?msisdn=, those pages show this number's phones only (2026-10-15).
  const phonesLink = s.registered ? { to: out('/registered-devices', { msisdn: p.msisdn }), label: 'Registered Devices' }
    : s.rescue_beacon ? { to: out('/rescue-enrolled', { msisdn: p.msisdn }), label: 'Rescue Enrolled Devices' } : null

  const nav: [string, string, number | null][] = [
    ['sp-location', 'Location', null], ['sp-signal', 'Signal', s.readings], ['sp-devices', 'Phones', p.devices.length],
    ['sp-speed', 'Speed tests', speedCount], ['sp-sessions', 'Sessions', sessions], ['sp-reports', 'Problems', p.problem_reports.length],
    ['sp-calls', 'Calls', callTotal], ['sp-photos', 'Photos', p.site_photos.length], ['sp-lookups', 'Lookups', p.lookups.length],
  ]

  return (
    <>
      <nav className="sp-nav" aria-label="Sections">
        {nav.map(([id, label, n]) => (
          <button key={id} type="button" className={n === 0 ? 'zero' : ''}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {label}{n != null && <b>{n}</b>}
          </button>
        ))}
      </nav>

      <div className="sp-kpis">
        <div className="sp-kpi"><div className="sp-kpi-label">Phones</div><div className="sp-kpi-val">{s.devices}</div></div>
        <div className="sp-kpi" style={{ '--sp-accent': '#818cf8' } as CSSProperties}><div className="sp-kpi-label">Readings</div><div className="sp-kpi-val">{s.readings.toLocaleString()}</div></div>
        <div className="sp-kpi" style={{ '--sp-accent': '#34d399' } as CSSProperties}><div className="sp-kpi-label">Mobile download</div><div className="sp-kpi-val">{medianDl != null ? medianDl.toFixed(1) : '—'}<small> Mbps</small></div></div>
        <div className="sp-kpi" style={{ '--sp-accent': '#fbbf24' } as CSSProperties}><div className="sp-kpi-label">Calls fell back</div><div className="sp-kpi-val">{fallbackShare != null ? `${fallbackShare}%` : '—'}</div></div>
        <div className="sp-kpi" style={{ '--sp-accent': '#fb7185' } as CSSProperties}><div className="sp-kpi-label">Problems</div><div className="sp-kpi-val">{p.problem_reports.length}</div></div>
        <div className="sp-kpi"><div className="sp-kpi-label">Sessions</div><div className="sp-kpi-val">{sessions}</div></div>
      </div>

      <div className="sp-flow">
        <Card id="sp-location" icon="📍" title="Last known location" empty={!loc && !s.location_hidden} emptyText="No location stored" wide>
          {s.location_hidden && <div className="sp-locked" style={{ marginBottom: 8 }}>Rescue consent withdrawn on one phone: its location is not shown</div>}
          {loc && (
            <div className={loc.site_lat != null && loc.site_lng != null ? 'sp-loc' : 'sp-loc sp-loc-nomap'}>
              <SiteMap loc={loc} />
              <dl className="sp-kv sp-kv-2">
                <dt>Time</dt><dd>{fmt(loc.ts)} <span className="sp-muted">· {loc.source === 'rescue' ? 'rescue beacon' : (loc.trigger_reason || 'reading')}</span></dd>
                {loc.network_type && <><dt>Network</dt><dd>{loc.network_type}{loc.band_mhz ? ` · ${loc.band_mhz} MHz` : ''}{loc.arfcn != null ? ` · ch ${loc.arfcn}` : ''}</dd></>}
                {loc.mnc && <><dt>Operator</dt><dd className="sp-mono">{loc.mcc}/{loc.mnc}</dd></>}
                {loc.cell_id != null && <><dt>Cell</dt><dd className="sp-mono">{loc.cell_id}{loc.pci != null ? ` · PCI ${loc.pci}` : ''}{loc.tac != null ? ` · TAC ${loc.tac}` : ''}</dd></>}
                {loc.serving_site_id && <><dt>Serving site</dt><dd>{loc.serving_site_id}{loc.site_name ? ` · ${loc.site_name}` : ''}{loc.site_district ? <span className="sp-muted"> · {loc.site_district}</span> : null}</dd></>}
                {(loc.serving_sector || loc.serving_dist_km != null) && <><dt>Sector</dt><dd>{loc.serving_sector ?? '—'}{loc.serving_dist_km != null ? <span className="sp-muted"> · {loc.serving_dist_km.toFixed(2)} km from the site</span> : null}</dd></>}
                {loc.level_dbm != null && <><dt>Level</dt><dd className="sp-mono">{loc.level_dbm} dBm</dd></>}
                {(loc.rsrq_db != null || loc.sinr_db != null || loc.cqi != null) && <><dt>Quality</dt><dd className="sp-mono">{[loc.rsrq_db != null ? `RSRQ ${loc.rsrq_db} dB` : '', loc.sinr_db != null ? `SINR ${loc.sinr_db} dB` : '', loc.cqi != null ? `CQI ${loc.cqi}` : ''].filter(Boolean).join(' · ')}</dd></>}
                {(loc.ecio_db != null) && <><dt>Ec/Io</dt><dd className="sp-mono">{loc.ecio_db} dB</dd></>}
                <dt>Position</dt>
                <dd>{loc.lat != null && loc.lng != null
                  ? <span className="sp-mono">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}{loc.gps_accuracy_m != null ? ` · ±${Math.round(loc.gps_accuracy_m)} m` : ''}</span>
                  : loc.position_withheld
                    ? <span className="sp-locked">🔒 Only while an emergency is declared</span>
                    : loc.earlier_position
                      ? <span className="sp-mono">
                          {loc.earlier_position.lat.toFixed(5)}, {loc.earlier_position.lng.toFixed(5)}
                          {loc.earlier_position.gps_accuracy_m != null ? ` · ±${Math.round(loc.earlier_position.gps_accuracy_m)} m` : ''}
                          <span className="sp-muted"> · not in this record; from the reading of {fmt(loc.earlier_position.ts)}</span>
                        </span>
                      : <span className="sp-muted">Not recorded: this {loc.source === 'rescue' ? 'rescue beacon report' : 'reading'} has no GPS position, and no stored reading has one</span>}</dd>
                {loc.device_id && <><dt>Phone</dt><dd className="sp-mono" title={loc.device_id}>{short(loc.device_id)}</dd></>}
              </dl>
            </div>
          )}
        </Card>

        <Card id="sp-signal" icon="📶" title="Signal history" count={s.readings} empty={p.signal_series.length === 0} emptyText="No readings shared" wide>
          <div className="sp-signal">
            <div style={{ flex: 1, minWidth: 0 }}><SignalChart series={p.signal_series} /></div>
            <NetworkRing counts={s.readings_by_network} />
          </div>
          <div className="sp-muted" style={{ marginTop: 4 }}>
            Newest {p.signal_series.length} readings{s.first_reading ? ` · first ${fmt(s.first_reading)}` : ''}
            {s.on_demand_readings ? ` · ${s.on_demand_readings} taken on request` : ''}
          </div>
        </Card>

        <Card id="sp-devices" icon="📱" title="Phones and app installs" count={p.devices.length} link={phonesLink}
          empty={p.devices.length === 0} emptyText="No phone linked" wide={p.devices.length > 1}>
          <div className="sp-devices">
            {p.devices.map((d) => (
              <div key={d.device_id} className="sp-device">
                <div className="sp-device-top">
                  <span className="sp-device-name">{[d.manufacturer, d.phone_model].filter(Boolean).join(' ') || 'Unknown phone'}</span>
                  <span className="sp-device-kind">{d.kind}</span>
                </div>
                <div className="sp-device-id" title={d.device_id}>{d.device_id}</div>
                <div className="sp-device-chips">
                  <span className={`sp-chip ${d.registered_at ? (d.registration_revoked_at ? 'bad' : 'ok') : ''}`}>{d.registered_at ? (d.registration_revoked_at ? 'Registration revoked' : 'Registered') : 'Not registered'}</span>
                  <span className={`sp-chip ${d.number_verified ? 'ok' : ''}`} title="Proved by a code sent by SMS to this number">{d.number_verified ? 'Number verified' : 'Number not verified'}</span>
                  {d.rescue_beacon && <span className={`sp-chip ${d.rescue_beacon === 'on' ? 'ok' : 'bad'}`}>Rescue {d.rescue_beacon}</span>}
                  {d.push_token && <span className="sp-chip info">Push</span>}
                  {d.signed_uploads_linked && <span className="sp-chip info">Signed uploads</span>}
                  {d.drive_test_consent && <span className={`sp-chip ${d.drive_test_consent === 'yes' ? 'ok' : ''}`}>DT consent {d.drive_test_consent}</span>}
                  {d.link_ended && <span className="sp-chip warn">Link ended</span>}
                </div>
                <div className="sp-device-facts">
                  <div><span>Readings</span>{d.readings.toLocaleString()}</div>
                  <div><span>Last reading</span>{fmt(d.last_reading)}</div>
                  {d.app_version && <div><span>App</span>{d.app_version}</div>}
                  {d.imei && <div><span>IMEI</span><b className="sp-mono">{d.imei}</b></div>}
                  {d.registered_at && <div><span>Registered</span>{fmt(d.registered_at)}</div>}
                  {d.linked_via.length > 0 && <div><span>Linked by</span>{d.linked_via.map((v) => v === 'manual_link' ? 'superadmin, by hand' : v.replace(/_/g, ' ')).join(', ')}</div>}
                </div>
                {d.readings > 0 && <Link className="sp-device-link" to={readings(d.device_id)}>Open all {d.readings.toLocaleString()} readings →</Link>}
              </div>
            ))}
          </div>
          <LinkEarlierReadings msisdn={p.msisdn} reason={reason} onChanged={onChanged}
            manualIds={p.devices.filter((d) => d.linked_via.includes('manual_link')).map((d) => d.device_id)} />
        </Card>

        <Card id="sp-speed" icon="⚡" title="Speed tests" count={speedCount} empty={speedCount === 0}
          link={speedDevice ? { to: readings(speedDevice), label: 'Speed tests in Live Samples' } : null} wide>
          <SpeedChart tests={p.speed_tests} />
          <Paged
            rows={[...p.speed_tests.map((r) => ({ ...r, trace: false })), ...p.trace_speed_tests.map((r) => ({ ...r, bearer: 'trace', jitter_ms: null, packet_loss_pct: null, rsrp_dbm: null, device_id: '', trace: true }))]}
            head={<tr><th>Time</th><th>Over</th><th>Download</th><th>Upload</th><th>Ping</th><th>Jitter</th><th>Loss</th><th>Radio</th></tr>}
            row={(r, i) => (
              <tr key={i}>
                <td>{fmt(r.ts)}</td>
                <td><span className={`sp-chip ${r.bearer === 'wifi' ? 'info' : r.bearer === 'mobile' ? 'ok' : 'plain'}`}>{r.bearer === 'wifi' ? 'Wi-Fi' : r.bearer === 'mobile' ? 'Mobile data' : r.trace ? 'During a trace' : 'Not tagged'}</span></td>
                <td className="mono">{num(r.download_mbps, ' Mbps')}</td><td className="mono">{num(r.upload_mbps, ' Mbps')}</td>
                <td className="mono">{num(r.ping_ms, ' ms')}</td><td className="mono">{num(r.jitter_ms, ' ms')}</td><td className="mono">{num(r.packet_loss_pct, '%')}</td>
                <td>{[r.network_type, r.rsrp_dbm != null ? `${r.rsrp_dbm} dBm` : ''].filter(Boolean).join(' ') || '—'}</td>
              </tr>
            )}
          />
        </Card>

        <Card id="sp-sessions" icon="🛰️" title="Sessions" count={sessions} empty={sessions === 0} wide>
          {p.collections.length > 0 && (
            <>
              <div className="sp-sub-head">Shares and phone drives · {p.collections.length} <Link to={out('/collections', { device: p.collections[0].device_id })}>Collections →</Link></div>
              <Paged rows={p.collections}
                head={<tr><th>Kind</th><th>Started</th><th>Last reading</th><th>Ended</th><th>Readings</th><th>Phone</th><th></th></tr>}
                row={(c) => (
                  <tr key={c.id}><td>{c.source}</td><td>{fmt(c.started_at)}</td><td>{fmt(c.last_sample_at)}</td><td>{fmt(c.ended_at)}</td><td className="mono">{c.samples}</td><td className="mono" title={c.device_id}>{short(c.device_id)}</td><td><Link to={out('/collections', { device: c.device_id })}>Open →</Link></td></tr>
                )} />
            </>
          )}
          {p.drive_test_sessions.length > 0 && (
            <>
              <div className="sp-sub-head">Telemetry drive tests · {p.drive_test_sessions.length} <Link to={out('/telemetry-dt-sessions')}>Telemetry Drive Test →</Link></div>
              <Paged rows={p.drive_test_sessions}
                head={<tr><th>Name</th><th>Status</th><th>Started</th><th>Ended</th><th>Phones</th></tr>}
                row={(d) => (
                  <tr key={d.id}><td><Link to={out('/telemetry-dt-sessions', { name: d.name })}>{d.name}</Link></td><td><span className={`sp-chip ${d.status === 'active' ? 'ok' : 'plain'}`}>{d.status}</span></td><td>{fmt(d.started_at)}</td><td>{fmt(d.ended_at)}</td><td className="mono">{d.devices}</td></tr>
                )} />
            </>
          )}
          {p.trace_requests.length > 0 && (
            <>
              <div className="sp-sub-head">Trace requests · {p.trace_requests.length} <Link to={out('/trace-requests')}>Trace Requests →</Link></div>
              <Paged rows={p.trace_requests}
                head={<tr><th>Created</th><th>Kind</th><th>Status</th><th>Case</th><th>By</th><th>Positions</th><th>Ended</th></tr>}
                row={(t) => (
                  <tr key={t.id}><td>{fmt(t.created_at)}</td><td>{t.kind}</td><td><span className="sp-chip plain">{t.status}</span></td><td>{t.case_reference || '—'}</td><td>{t.requested_by ?? '—'}</td><td className="mono">{t.positions}</td><td>{fmt(t.ended_at)}</td></tr>
                )} />
            </>
          )}
        </Card>

        <Card id="sp-reports" icon="🧭" title="Problem reports" count={p.problem_reports.length} empty={p.problem_reports.length === 0}
          link={{ to: out('/problem-reports', { status: 'all' }), label: 'Problem Dashboard' }}>
          <Paged rows={p.problem_reports}
            head={<tr><th>When</th><th>Problem</th><th>From</th><th>Status</th><th>Signal</th><th>Download</th></tr>}
            row={(r) => (
              <tr key={r.id}>
                <td><Link to={out('/problem-reports', { tab: 'reports', status: 'all', report: String(r.id) })}>{fmt(r.happened_at)}</Link>{r.note && <div className="muted">{r.note}</div>}</td>
                <td>{r.category.replace(/_/g, ' ')}</td>
                <td>{r.source === 'external' ? `${r.external_system} #${r.external_ref}` : r.source === 'app' ? 'Mobile app' : 'Staff'}</td>
                <td><span className="sp-chip plain">{r.status}</span></td><td className="mono">{r.network_type} {num(r.level_dbm, ' dBm')}</td><td className="mono">{num(r.download_mbps, ' Mbps')}</td>
              </tr>
            )} />
        </Card>

        <Card id="sp-calls" icon="📞" title="Calls" count={callTotal} empty={callTotal === 0 && p.volte.length === 0}
          link={{ to: out('/telemetry-volte-samples', { days: '90' }), label: 'VoLTE Quality' }}>
          {callTotal > 0 && (
            <>
              <div className="sp-stack">
                {Object.entries(p.calls.by_outcome).map(([k, v]) => <i key={k} style={{ width: `${(100 * v) / callTotal}%`, background: OUTCOME[k]?.color ?? '#64748b' }} title={`${OUTCOME[k]?.label ?? k}: ${v}`} />)}
              </div>
              <div className="sp-legend" style={{ marginBottom: 8 }}>
                {Object.entries(p.calls.by_outcome).map(([k, v]) => <span key={k}><i style={{ background: OUTCOME[k]?.color ?? '#64748b' }} />{OUTCOME[k]?.label ?? k} · {v}</span>)}
              </div>
              <Paged rows={p.calls.latest}
                head={<tr><th>Started</th><th>Length</th><th>Voice network</th><th>Cell</th><th>Level</th></tr>}
                row={(c, i) => (
                  <tr key={i}><td>{fmt(c.started_at)}</td><td className="mono">{num(c.duration_s, ' s')}</td><td>{c.voice_networks.replace(/,/g, ' → ') || '—'}</td><td className="mono">{c.cell_id ?? '—'}</td><td className="mono">{num(c.level_dbm, ' dBm')}</td></tr>
                )} />
            </>
          )}
          {p.volte.length > 0 && <div className="sp-muted" style={{ marginTop: 8 }}>Call quality: {p.volte.map((v) => `${fmtDate(v.ts)} ${v.codec} estimated MOS ${num(v.mos_estimate)}`).join(' · ')}</div>}
        </Card>

        <Card id="sp-photos" icon="📷" title="Site photos" count={p.site_photos.length} empty={p.site_photos.length === 0}
          link={{ to: out('/site-photos', p.site_photos[0] ? { status: p.site_photos[0].status } : {}), label: 'Site Photos' }}>
          <Paged rows={p.site_photos}
            head={<tr><th>Taken</th><th>Site</th><th>Status</th></tr>}
            row={(ph) => (
              <tr key={ph.id}><td>{fmt(ph.taken_at)}</td><td>{ph.site_id ?? 'During a drive'}</td><td><span className={`sp-chip ${ph.status === 'approved' ? 'ok' : ph.status === 'rejected' ? 'bad' : 'warn'}`}>{ph.status}</span></td></tr>
            )} />
        </Card>

        <Card id="sp-lookups" icon="🛡️" title="Who looked this number up" count={p.lookups.length} empty={p.lookups.length === 0} emptyText="No earlier lookup" wide>
          <Paged rows={p.lookups}
            head={<tr><th>When</th><th>Tool</th><th>By</th><th>Reference</th><th>Found</th></tr>}
            row={(l, i) => (
              <tr key={i}><td>{fmt(l.at)}</td><td>{l.tool}</td><td>{l.by ?? '—'}</td><td>{l.reference || '—'}</td><td>{l.found == null ? '—' : l.found ? 'Yes' : 'No'}</td></tr>
            )} />
        </Card>
      </div>
    </>
  )
}

export default function SubscriberProfilePage() {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const msisdn = params.get('msisdn') ?? ''
  const reason = params.get('reason') ?? ''
  const [number, setNumber] = useState(msisdn)
  const [ticket, setTicket] = useState(reason)
  const { data, isFetching, error, refetch } = useSubscriberProfile(msisdn, reason)
  const restored = useRef(false)

  // Keep the boxes in step when the address changes (Back / Forward).
  useEffect(() => { setNumber(msisdn); setTicket(reason) }, [msisdn, reason])

  // Remember how far down the page was, and put it back on return.
  const here = `${location.pathname}${location.search}`
  useEffect(() => {
    const main = document.querySelector('.app-main')
    if (!main) return
    const save = () => {
      try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ at: here, top: main.scrollTop })) } catch { /* private window */ }
    }
    main.addEventListener('scroll', save, { passive: true })
    return () => main.removeEventListener('scroll', save)
  }, [here])
  useEffect(() => {
    if (!data || restored.current) return
    restored.current = true
    try {
      const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null') as { at: string; top: number } | null
      const main = document.querySelector('.app-main')
      if (saved && saved.at === here && main) requestAnimationFrame(() => { main.scrollTop = saved.top })
    } catch { /* nothing saved */ }
  }, [data, here])

  // Every link out of the profile carries the way back.
  const out = (key: string, extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ ...extra, back: here })
    return `${OPAQUE_PATHS[key] ?? '/'}?${qs}`
  }

  const search = (e: React.FormEvent) => {
    e.preventDefault()
    if (!number.trim() || !ticket.trim()) return
    restored.current = true
    setParams({ msisdn: number.trim(), reason: ticket.trim() })
  }

  const s = data?.summary
  return (
    <div className="sp-page">
      <div className="sp-hero">
        <div className="sp-hero-band" />
        <div className="sp-hero-body">
          <div className="sp-hero-title">
            <div className="sp-eyebrow">Customer diagnostics · superadmin</div>
            <h1 className="sp-title">Subscriber Profile</h1>
            <p className="sp-sub">Stored data only · every search needs a reference and is logged with your name.</p>
          </div>
          <form className="sp-search" onSubmit={search}>
            <div className="sp-field">
              <label htmlFor="sp-number">Mobile number</label>
              <input id="sp-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="9851234567 or +977 985-1234567" />
            </div>
            <div className="sp-field">
              <label htmlFor="sp-ticket">Ticket or case reference</label>
              <input id="sp-ticket" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="e.g. complaint 2026-1015-042" />
            </div>
            <button className="sp-btn" type="submit" disabled={!number.trim() || !ticket.trim() || isFetching}>
              {isFetching ? 'Searching…' : 'Search'}
            </button>
          </form>
        </div>
      </div>

      {error && <div className="sp-alert err">{apiErrorMessage(error)}</div>}
      {data && !data.found && (
        <div className="sp-alert">Nothing is stored for <b className="sp-mono">{data.msisdn}</b>. The phone has not registered, shared readings or turned on the rescue beacon.</div>
      )}
      {data && data.found && s && (
        <>
          <div className="sp-ident">
            <span className="sp-msisdn">{data.msisdn}</span>
            <span className={`sp-chip ${s.registered ? 'ok' : ''}`}>{s.registered ? `Registered ${fmtDate(s.first_registered_at)}` : 'Not registered'}</span>
            {!!s.unproven_claims && <span className="sp-chip bad" title="Only verified numbers count (Security settings)">{s.unproven_claims} unverified phone{s.unproven_claims === 1 ? '' : 's'} left out</span>}
            <span className={`sp-chip ${s.rescue_beacon === 'on' ? 'ok' : s.rescue_beacon === 'withdrawn' ? 'bad' : ''}`}>
              Rescue beacon {s.rescue_beacon === 'on' ? 'on' : s.rescue_beacon === 'withdrawn' ? 'withdrawn' : 'never'}
            </span>
            {data.emergency_declared && <span className="sp-chip warn">Emergency declared</span>}
            {s.last_reading && <span className="sp-chip info">Last reading {fmt(s.last_reading)}</span>}
            <button type="button" className="sp-btn sp-btn-ghost sp-refresh" onClick={() => refetch()} disabled={isFetching}
              title="Searches again; logged as a new search">
              {isFetching ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>
          <Profile p={data} out={out} reason={reason} onChanged={() => void refetch()} />
        </>
      )}
    </div>
  )
}
