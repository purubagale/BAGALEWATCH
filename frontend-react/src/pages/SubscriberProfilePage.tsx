import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useEmergencyStatus, useSubscriberProfile } from '../api/queries'
import type { SubscriberProfile } from '../api/types'
import { OPAQUE_PATHS } from '../constants/opaqueRoutes'
import RowsPerPageSelect from '../components/RowsPerPageSelect'
import LinkEarlierReadings from '../components/LinkEarlierReadings'
import ProfileSignalHistory, { STATUS_SHORT, STATUS_TEXT, type SignalSelection } from '../components/ProfileSignalHistory'
import ProfileAnalytics from '../components/ProfileAnalytics'
import ProfileProvisioning from '../components/ProfileProvisioning'
import FitToPoints from '../components/FitToPoints'
import { NET_LABEL, netColor } from '../lib/netColors'
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

// What each id on the phones card is (2026-10-16). One phone appears several
// times: Registered Devices lists only its registrations, while its readings
// sit under the app install.
const ROLE: Record<string, { label: string; hint: string }> = {
  app_install: { label: 'App install · readings', hint: 'The app on the phone. Shared readings are stored under this id.' },
  registration: { label: 'Registration', hint: 'Made by "Register this phone" in the app. Registered Devices lists these.' },
  earlier_install: { label: 'Earlier install · linked by hand', hint: 'The app before a reinstall. A superadmin tied its readings to this number.' },
  rescue: { label: 'Rescue beacon', hint: 'Turned on the rescue location beacon with this number.' },
  identity: { label: 'Phone details', hint: 'Sent its make and model with this number; no readings.' },
}
const ROLE_ORDER = ['app_install', 'registration', 'earlier_install', 'rescue', 'identity']
const LINKED_BY: Record<string, string> = {
  registered_phone: 'registering in the app',
  rescue_enrolment: 'turning on the rescue beacon',
  identity_upload: 'sending its phone details',
  manual_link: 'a superadmin, by hand',
}

function sortDevices(devices: SubscriberProfile['devices']) {
  return [...devices].sort((a, b) =>
    a.phone_key.localeCompare(b.phone_key)
    || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
    || Number(!!a.replaced_at) - Number(!!b.replaced_at))
}

// "1 phone · 4 records: …", and why Registered Devices shows fewer.
function PhonesSummary({ devices, phones, registeredLink }: {
  devices: SubscriberProfile['devices']; phones?: number; registeredLink: boolean
}) {
  const count = (role: string) => devices.filter((d) => d.role === role).length
  const regs = count('registration')
  const replaced = devices.filter((d) => d.replaced_at).length
  const parts = [
    count('app_install') && `${count('app_install')} app install${count('app_install') === 1 ? '' : 's'} with readings`,
    regs && `${regs} registration${regs === 1 ? '' : 's'}${replaced ? ` (${replaced} replaced)` : ''}`,
    count('earlier_install') && `${count('earlier_install')} earlier install${count('earlier_install') === 1 ? '' : 's'} linked by hand`,
    count('rescue') && `${count('rescue')} rescue beacon`,
    count('identity') && `${count('identity')} phone details only`,
  ].filter(Boolean)
  const n = phones ?? devices.length
  return (
    <div className="sp-muted" style={{ marginBottom: 8 }}>
      <b>{n} phone{n === 1 ? '' : 's'}</b> · {devices.length} record{devices.length === 1 ? '' : 's'}: {parts.join(', ')}.
      {registeredLink && regs > 0 && ` Registered Devices lists the ${regs} registration${regs === 1 ? '' : 's'} only.`}
    </div>
  )
}

// Share of readings per network, as a ring.
// Readings without a network get their own colour by what they mean (2026-10-26):
// no coverage in rose, not measured light grey, radio off / no SIM slate.
const STATUS_COLOR: Record<string, string> = { no_coverage: '#e11d48', not_measured: '#cbd5e1', radio_off: '#64748b' }
function ringColor(k: string) { return STATUS_COLOR[k] ?? netColor(k) }

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
          const el = <circle key={k} cx={55} cy={55} r={R} fill="none" style={{ stroke: ringColor(k) }} strokeWidth={14}
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 55 55)"><title>{`${k || 'unknown'}: ${v}`}</title></circle>
          offset += len
          return el
        })}
        <text x={55} y={53} textAnchor="middle" className="sp-ring-num">{total.toLocaleString()}</text>
        <text x={55} y={67} textAnchor="middle" className="sp-axis">readings</text>
      </svg>
      <div className="sp-ring-legend">
        {entries.map(([k, v]) => <div key={k} title={STATUS_TEXT[k]}><i style={{ background: ringColor(k) }} />{NET_LABEL[k] ?? STATUS_SHORT[k] ?? (k === 'UNKNOWN' || !k ? 'No network' : k)} <b className="sp-mono">{Math.round((100 * v) / total)}%</b></div>)}
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
  // The reading's own position, else (in an emergency) the newest reading
  // that has one (2026-10-19: a handover reading often has no GPS fix).
  const own: [number, number] | null = loc.lat != null && loc.lng != null ? [loc.lat, loc.lng]
    : loc.earlier_position ? [loc.earlier_position.lat, loc.earlier_position.lng] : null
  const ownLabel = loc.lat != null
    ? (loc.position_basis === 'complaint' ? "Last position (customer's problem report)" : 'Last position (emergency)')
    : loc.earlier_position ? `Last known position, ${fmt(loc.earlier_position.ts)}` : ''
  const site: [number, number] | null = loc.site_lat != null && loc.site_lng != null ? [loc.site_lat, loc.site_lng] : null
  if (!site && !own) return null
  const points = [site, own].filter(Boolean) as [number, number][]
  return (
    <div className="sp-map">
      <MapContainer center={points[0]} zoom={14} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} attributionControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitToPoints points={points} fitKey={points.map((p) => p.join(',')).join('|')} singleZoom={15} />
        {site && (
          <CircleMarker center={site} radius={8} pathOptions={{ color: '#4f46e5', fillColor: '#818cf8', fillOpacity: 0.9, weight: 2 }}>
            <Tooltip>{`Serving site ${loc.serving_site_id ?? ''}${loc.site_name ? ` · ${loc.site_name}` : ''}`}</Tooltip>
          </CircleMarker>
        )}
        {own && (
          <>
            {site && <Polyline positions={[site, own]} pathOptions={{ color: '#22d3ee', dashArray: '4 6', weight: 2 }} />}
            <CircleMarker center={own} radius={7} pathOptions={{ color: '#0891b2', fillColor: '#22d3ee', fillOpacity: 0.95, weight: 2 }}>
              <Tooltip permanent direction="top">{ownLabel}</Tooltip>
            </CircleMarker>
          </>
        )}
      </MapContainer>
    </div>
  )
}

function Profile({ p, out, siteLink, reason, onChanged }: {
  p: SubscriberProfile; out: (key: string, extra?: Record<string, string>) => string
  siteLink: (siteId: string) => string; reason: string; onChanged: () => void
}) {
  const s = p.summary
  const loc = p.last_location
  // The analysis cards follow the signal filter (2026-10-19); until it has
  // answered, and when its choice has no readings, they show every reading.
  const [selection, setSelection] = useState<SignalSelection | null>(null)
  const onSelection = useCallback((x: SignalSelection) => setSelection(x), [])
  // A session picked on the Sessions card filters the signal history (2026-10-19).
  const [pick, setPick] = useState<{ session: string; n: number } | null>(null)
  const showSession = (session: string) => setPick((old) => ({ session, n: (old?.n ?? 0) + 1 }))
  const showBtn = (session: string) => (
    <button type="button" className="sp-btn sp-btn-ghost sp-btn-xs" onClick={() => showSession(session)}>Show in signal history</button>
  )
  const analytics = selection?.analytics ?? p.analytics
  const scope = selection?.analytics ? selection.label
    : selection && !selection.loading ? 'all readings (the signal filter has none)' : undefined
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
    ['sp-location', 'Location', null], ['sp-signal', 'Signal', s.readings],
    ...(p.analytics ? [['sp-capability', 'Quality', null], ['sp-cells', 'Location history', p.analytics.cells_count ?? p.analytics.cells.length]] as [string, string, number | null][] : []),
    ['sp-devices', 'Phones', p.devices.length],
    ['sp-speed', 'Speed tests', speedCount], ['sp-sessions', 'Sessions', sessions], ['sp-reports', 'Problems', p.problem_reports.length],
    ['sp-calls', 'Calls', callTotal], ['sp-photos', 'Photos', p.site_photos.length], ['sp-lookups', 'Lookups', p.lookups.length],
    ['sp-bi', 'BI usage', null], ['sp-oss', 'OSS & Core', null],
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
        <div className="sp-kpi"><div className="sp-kpi-label">Phones</div><div className="sp-kpi-val">{s.phones ?? s.devices}</div></div>
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
            <div className={(loc.site_lat != null && loc.site_lng != null) || loc.lat != null || loc.earlier_position ? 'sp-loc' : 'sp-loc sp-loc-nomap'}>
              <SiteMap loc={loc} />
              <dl className="sp-facts">
                <div className="sp-fact"><dt>Time</dt><dd>{fmt(loc.ts)} <span className="sp-muted">· {loc.source === 'rescue' ? 'rescue beacon' : (loc.trigger_reason || 'reading')}</span></dd></div>
                {loc.network_type && <div className="sp-fact"><dt>Network</dt><dd>{loc.network_type}{loc.band_mhz ? ` · ${loc.band_mhz} MHz` : ''}{loc.arfcn != null ? ` · ch ${loc.arfcn}` : ''}{loc.bandwidth_label ? ` · ${loc.bandwidth_label} wide` : ''}</dd></div>}
                {(loc.operator || loc.mnc) && <div className="sp-fact"><dt>Operator</dt><dd title={loc.mnc ? `${loc.mcc}/${loc.mnc}` : undefined}>{loc.operator ?? `${loc.mcc}/${loc.mnc}`}</dd></div>}
                {loc.cell_id != null && <div className="sp-fact"><dt>Cell</dt><dd className="sp-mono">{loc.cell_id}{loc.pci != null ? ` · PCI ${loc.pci}` : ''}{loc.tac != null ? ` · TAC ${loc.tac}` : ''}</dd></div>}
                {loc.serving_site_id && <div className="sp-fact"><dt>{loc.serving_site_basis === 'earlier' ? 'Last attached site' : 'Serving site'}</dt><dd>
                  <Link to={siteLink(loc.serving_site_id)}>{loc.serving_site_id}</Link>{loc.site_name ? ` · ${loc.site_name}` : ''}{loc.site_district ? <span className="sp-muted"> · {loc.site_district}</span> : null}
                  {loc.serving_site_basis === 'earlier' && <span className="sp-muted"> · from the reading of {fmt(loc.serving_site_ts ?? null)}; the latest one names no known cell</span>}
                  {loc.serving_site_basis === 'matched_now' && <span className="sp-muted"> · matched from the cell just now</span>}</dd></div>}
                {(loc.serving_sector || loc.serving_cell_name || loc.serving_dist_km != null) && <div className="sp-fact"><dt>Sector</dt><dd>
                  {loc.serving_sector ? `Sector ${loc.serving_sector}` : '—'}{loc.serving_cell_name ? <span className="sp-mono"> · {loc.serving_cell_name}</span> : null}
                  {loc.serving_dist_km != null ? <span className="sp-muted"> · {loc.serving_dist_km.toFixed(2)} km from the site</span> : null}</dd></div>}
                {loc.level_dbm != null && <div className="sp-fact"><dt>Level</dt><dd className="sp-mono">{loc.level_dbm} dBm</dd></div>}
                {(loc.rsrq_db != null || loc.sinr_db != null || loc.cqi != null) && <div className="sp-fact"><dt>Quality</dt><dd className="sp-mono">{[loc.rsrq_db != null ? `RSRQ ${loc.rsrq_db} dB` : '', loc.sinr_db != null ? `SINR ${loc.sinr_db} dB` : '', loc.cqi != null ? `CQI ${loc.cqi}` : ''].filter(Boolean).join(' · ')}</dd></div>}
                {(loc.ecio_db != null) && <div className="sp-fact"><dt>Ec/Io</dt><dd className="sp-mono">{loc.ecio_db} dB</dd></div>}
                <div className="sp-fact sp-fact-wide"><dt>Position</dt>
                <dd>{loc.lat != null && loc.lng != null
                  ? <span className="sp-mono">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}{loc.gps_accuracy_m != null ? ` · ±${Math.round(loc.gps_accuracy_m)} m` : ''}
                      {loc.position_basis === 'complaint' && <span className="sp-muted"> · shown for the customer's problem report #{loc.complaint_report_id}</span>}</span>
                  : loc.position_withheld
                    ? <span className="sp-locked">🔒 Only in an emergency{p.complaint_windows?.length ? ", or near the customer's own problem report" : ''}</span>
                    : loc.earlier_position
                      ? <span className="sp-mono">
                          {loc.earlier_position.lat.toFixed(5)}, {loc.earlier_position.lng.toFixed(5)}
                          {loc.earlier_position.gps_accuracy_m != null ? ` · ±${Math.round(loc.earlier_position.gps_accuracy_m)} m` : ''}
                          <span className="sp-muted"> · not in this record; from the reading of {fmt(loc.earlier_position.ts)}</span>
                        </span>
                      : <span className="sp-muted">Not recorded: this {loc.source === 'rescue' ? 'rescue beacon report' : 'reading'} has no GPS position, and no stored reading has one</span>}</dd></div>
                {loc.device_id && <div className="sp-fact"><dt>Phone</dt><dd className="sp-mono" title={loc.device_id}>{short(loc.device_id)}</dd></div>}
              </dl>
            </div>
          )}
        </Card>

        <Card id="sp-signal" icon="📶" title="Signal analytics" count={s.readings} empty={s.readings === 0} emptyText="No readings shared" wide>
          <ProfileSignalHistory msisdn={p.msisdn} reason={reason} total={s.readings} emergency={p.emergency_declared}
            onSelection={onSelection} pick={pick}
            aside={(counts) => <NetworkRing counts={counts} />}
            footer={[s.first_reading ? `first reading ${fmt(s.first_reading)}` : '',
              s.on_demand_readings ? `${s.on_demand_readings} taken on request` : ''].filter(Boolean).join(' · ') || null} />
        </Card>

        {analytics && (
          <ProfileAnalytics a={analytics} scope={scope} callsByOutcome={p.calls.by_outcome} siteLink={siteLink}
            phone={(() => {
              const d = p.devices.find((x) => x.phone_model)
              return d ? `${[d.manufacturer, d.phone_model].filter(Boolean).join(' ')}${d.app_version ? ` · app ${d.app_version}` : ''}` : null
            })()} />
        )}

        <Card id="sp-devices" icon="📱" title="Phones and app installs" count={p.devices.length} link={phonesLink}
          empty={p.devices.length === 0} emptyText="No phone linked" wide={p.devices.length > 1}>
          <PhonesSummary devices={p.devices} phones={s.phones} registeredLink={!!phonesLink && s.registered} />
          <div className="sp-devices">
            {sortDevices(p.devices).map((d) => (
              <div key={d.device_id} className={`sp-device${d.replaced_at ? ' sp-device-old' : ''}`}>
                <div className="sp-device-top">
                  <span className="sp-device-name">{[d.manufacturer, d.phone_model].filter(Boolean).join(' ') || 'Unknown phone'}</span>
                  <span className="sp-device-kind" title={ROLE[d.role]?.hint}>{ROLE[d.role]?.label ?? d.kind}</span>
                </div>
                {d.replaced_at && <div className="sp-device-replaced">Replaced {fmt(d.replaced_at)} by a newer registration from this phone</div>}
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
                  {d.linked_via.length > 0 && <div><span>Tied to this number by</span>{d.linked_via.map((v) => LINKED_BY[v] ?? v.replace(/_/g, ' ')).join(', ')}</div>}
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
                head={<tr><th>Session</th><th>Started</th><th>Last reading</th><th>Ended</th><th>Readings</th><th>Phone</th><th></th><th></th></tr>}
                row={(c) => (
                  <tr key={c.id}><td>{c.name ?? c.source}</td><td>{fmt(c.started_at)}</td><td>{fmt(c.last_sample_at)}</td><td>{fmt(c.ended_at)}</td><td className="mono">{c.samples}</td><td className="mono" title={c.device_id}>{short(c.device_id)}</td><td>{c.samples ? showBtn(`collection:${c.id}`) : null}</td><td><Link to={out('/collections', { device: c.device_id })}>Open →</Link></td></tr>
                )} />
            </>
          )}
          {p.drive_test_sessions.length > 0 && (
            <>
              <div className="sp-sub-head">Telemetry drive tests · {p.drive_test_sessions.length} <Link to={out('/telemetry-dt-sessions')}>Telemetry Drive Test →</Link></div>
              <Paged rows={p.drive_test_sessions}
                head={<tr><th>Name</th><th>Status</th><th>Started</th><th>Ended</th><th>Phones</th><th></th></tr>}
                row={(d) => (
                  <tr key={d.id}><td><Link to={out('/telemetry-dt-sessions', { name: d.name })}>{d.name}</Link></td><td><span className={`sp-chip ${d.status === 'active' ? 'ok' : 'plain'}`}>{d.status}</span></td><td>{fmt(d.started_at)}</td><td>{fmt(d.ended_at)}</td><td className="mono">{d.devices}</td><td>{showBtn(`drive:${d.id}`)}</td></tr>
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
          <LookupsList lookups={p.lookups} />
        </Card>

        {/* NTC's other systems last, after this system's own details (2026-10-19): BI, then OSS & Core. */}
        <div className="spo-pair sp-wide">
          <ProfileProvisioning kind="bi" msisdn={p.msisdn} reason={reason} analytics={analytics}
            callsByOutcome={p.calls.by_outcome} emergency={p.emergency_declared} />
          <ProfileProvisioning kind="core" msisdn={p.msisdn} reason={reason} analytics={analytics}
            callsByOutcome={p.calls.by_outcome} emergency={p.emergency_declared} />
        </div>
      </div>
    </>
  )
}

// Collapsed until asked for (2026-10-16): who looked the number up matters
// for an audit, rarely for the customer's problem.
function LookupsList({ lookups }: { lookups: SubscriberProfile['lookups'] }) {
  const [open, setOpen] = useState(false)
  const last = lookups[0]
  if (!open) {
    return (
      <div className="sp-muted">
        {last ? `Last: ${fmt(last.at)} · ${last.tool} · ${last.by ?? '—'}. ` : ''}
        <button type="button" className="sp-linkbtn" onClick={() => setOpen(true)}>Show all {lookups.length} lookups</button>
      </div>
    )
  }
  return (
    <>
      <button type="button" className="sp-linkbtn" style={{ marginBottom: 6 }} onClick={() => setOpen(false)}>Hide the list</button>
      <Paged rows={lookups}
        head={<tr><th>When</th><th>Tool</th><th>By</th><th>Reference</th><th>Found</th></tr>}
        row={(l, i) => (
          <tr key={i}><td>{fmt(l.at)}</td><td>{l.tool}</td><td>{l.by ?? '—'}</td><td>{l.reference || '—'}</td><td>{l.found == null ? '—' : l.found ? 'Yes' : 'No'}</td></tr>
        )} />
    </>
  )
}

export default function SubscriberProfilePage() {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const msisdn = params.get('msisdn') ?? ''
  const reason = params.get('reason') ?? ''
  // Opened from a complaint (2026-10-19): the way back to it. Only a
  // Problem Dashboard address is accepted.
  const fromRaw = params.get('from') ?? ''
  const from = fromRaw.startsWith(`${OPAQUE_PATHS['/problem-reports']}?`) || fromRaw === OPAQUE_PATHS['/problem-reports'] ? fromRaw : ''
  const [number, setNumber] = useState(msisdn)
  const [ticket, setTicket] = useState(reason)
  const { data, isFetching, error, refetch } = useSubscriberProfile(msisdn, reason)
  const restored = useRef(false)

  // The profile is kept for 30 minutes (each server search is logged), so an
  // emergency declared or ended meanwhile would not show (2026-10-19). The
  // emergency status is cheap and not logged: when it disagrees with the
  // profile, search again.
  const emergency = useEmergencyStatus()
  const emergencyActive = emergency.data?.active
  useEffect(() => {
    if (data && emergencyActive != null && emergencyActive !== data.emergency_declared && !isFetching) void refetch()
  }, [data, emergencyActive, isFetching, refetch])

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
    setParams({ msisdn: number.trim(), reason: ticket.trim(), ...(from ? { from } : {}) })
  }

  const s = data?.summary
  return (
    <div className="sp-page">
      {from && (
        <div className="sp-from-bar">
          <Link to={from}>← Back to the complaint</Link>
          <span className="sp-muted">{reason}</span>
        </div>
      )}
      <div className="sp-hero">
        <div className="sp-hero-band" />
        <div className="sp-hero-body">
          <div className="sp-hero-title">
            <div className="sp-eyebrow">Customer diagnostics · superadmin</div>
            <h1 className="sp-title">Subscriber Network Diagnosis Dashboard</h1>
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
          <Profile p={data} out={out} reason={reason} onChanged={() => void refetch()}
            siteLink={(id) => `/sites/${encodeURIComponent(id)}?${new URLSearchParams({ back: here })}`} />
        </>
      )}
    </div>
  )
}
