import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import L from 'leaflet'
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { apiErrorMessage } from '../api/client'
import { useProblemRelated } from '../api/queries'
import type {
  ProblemRelated, ProblemReport, RelatedComplaints, RelatedDriveTests, RelatedPoint, RelatedTelemetry,
} from '../api/types'
import { DT_SESSION_HISTORY_PATH, OPAQUE_PATHS } from '../constants/opaqueRoutes'
import { RSRP_BANDS, RXLEV_BANDS, bandColor } from '../lib/dtBands'
import ActiveAlarmsButton from './ActiveAlarmsButton'
import { Band, CardHead, Tile, rate, rateLevel } from './MetricTile'
import { useSiteLinkBack } from '../lib/siteLinkBack'

// Everything stored that relates to one complaint (2026-10-26,
// core/problem_related.py): the customer's own phone readings wherever they
// were taken, the readings the complaint's site served, and the phone and
// drive-test readings around the spot, for a time range the engineer picks.
// The range lives in the page address (rr, rh, rf, rt, rk) so both tabs and
// the diagnostics summary use the same one.

const RANGE_LABEL: Record<string, string> = {
  latest: 'Latest readings', around: 'Around the complaint time', '7d': 'Last 7 days', '30d': 'Last 30 days',
  '90d': 'Last 90 days', all: 'All stored', custom: 'From … to …',
}

function when(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : '-'
}

function fmt(v: number | null | undefined, unit = '') {
  return v == null ? '-' : `${v}${unit}`
}

function pct(part: number, whole: number) {
  return whole ? `${Math.round((100 * part) / whole)}%` : '-'
}

function levelName(tech: string) {
  return tech === '3G' ? 'RSCP' : tech === '2G' ? 'RxLev' : 'RSRP'
}

function pointColor(p: RelatedPoint) {
  return bandColor(p.tech === '2G' ? RXLEV_BANDS : RSRP_BANDS, p.level)
}

export function useRelatedRange() {
  const [params, setParams] = useSearchParams()
  const range = params.get('rr') || 'latest'
  const query: Record<string, string> = { range }
  if (range === 'around') query.hours = params.get('rh') || '24'
  if (range === 'custom') {
    if (params.get('rf')) query.from = params.get('rf') as string
    if (params.get('rt')) query.to = params.get('rt') as string
  }
  query.radius_km = params.get('rk') || '1'
  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const next = new URLSearchParams(p)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    return next
  }, { replace: true })
  return { query, set, range }
}

export function useRelated(id: number) {
  const { query } = useRelatedRange()
  return useProblemRelated(id, query)
}

export function RelatedRangeBar({ data, showRadius }: { data?: ProblemRelated; showRadius?: boolean }) {
  const { query, set, range } = useRelatedRange()
  return (
    <div className="pdd-live-bar pdd-rel-bar">
      <label>Readings <select value={range} onChange={(e) => set({ rr: e.target.value === 'latest' ? null : e.target.value })}>
        {Object.entries(RANGE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select></label>
      {range === 'around' && (
        <label>± <select value={query.hours} onChange={(e) => set({ rh: e.target.value })}>
          {(data?.range.hours_options ?? [1, 3, 6, 24, 72, 168]).map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : `${h / 24} day${h > 24 ? 's' : ''}`}</option>)}
        </select></label>
      )}
      {range === 'custom' && <>
        <label>From <input type="date" value={query.from ?? ''} onChange={(e) => set({ rf: e.target.value })} /></label>
        <label>to <input type="date" value={query.to ?? ''} onChange={(e) => set({ rt: e.target.value })} /></label>
      </>}
      {showRadius && (
        <label>Area <select value={query.radius_km} onChange={(e) => set({ rk: e.target.value === '1' ? null : e.target.value })}>
          {(data?.range.radii_km ?? [0.5, 1, 2, 5]).map((km) => <option key={km} value={km}>{km < 1 ? `${km * 1000} m` : `${km} km`}</option>)}
        </select></label>
      )}
      {data?.range.start && <span className="muted pdd-small">{when(data.range.start)} to {when(data.range.end)}</span>}
      {range === 'latest' && <span className="muted pdd-small">newest 300 phone readings and the newest drive test of each</span>}
    </div>
  )
}

function Fit({ points }: { points: [number, number][] }) {
  const map = useMap()
  const key = points.length ? `${points.length}:${points[0][0]}:${points[points.length - 1][1]}` : ''
  useEffect(() => {
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [20, 20], maxZoom: 16 })
    else if (points.length === 1) map.setView(points[0], 15)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key])
  return null
}

function RelatedMap({ r, points, radiusKm, site }: {
  r: ProblemReport; points: RelatedPoint[]; radiusKm?: number; site?: { lat: number | null; lng: number | null; site_id: string } | null
}) {
  const all: [number, number][] = [[r.lat, r.lng], ...points.map((p) => [p.lat, p.lng] as [number, number])]
  if (site?.lat != null && site.lng != null) all.push([site.lat, site.lng])
  return (
    <div className="problem-map pdd-rel-map">
      <MapContainer center={[r.lat, r.lng]} zoom={14} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Fit points={all} />
        {radiusKm && <Circle center={[r.lat, r.lng]} radius={radiusKm * 1000} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.04 }} />}
        {points.map((p, i) => (
          <CircleMarker key={i} center={[p.lat, p.lng]} radius={4} pathOptions={{ color: '#1e293b', weight: 0.5, fillColor: pointColor(p), fillOpacity: 0.9 }}>
            <Tooltip>{p.tech} · {levelName(p.tech)} {fmt(p.level, ' dBm')}{p.ts ? ` · ${when(p.ts)}` : ''}{p.site_id ? ` · ${p.site_id}` : ''}</Tooltip>
          </CircleMarker>
        ))}
        {site?.lat != null && site.lng != null && (
          <CircleMarker center={[site.lat, site.lng]} radius={8} pathOptions={{ color: '#0153a5', fillColor: '#ffffff', fillOpacity: 1, weight: 3 }}>
            <Tooltip>Site {site.site_id}</Tooltip>
          </CircleMarker>
        )}
        <CircleMarker center={[r.lat, r.lng]} radius={7} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }}>
          <Tooltip>Where the problem was reported</Tooltip>
        </CircleMarker>
      </MapContainer>
    </div>
  )
}

function TelemetryBlock({ t, title, showDevices = true }: { t: RelatedTelemetry | null; title: string; showDevices?: boolean }) {
  const siteLink = useSiteLinkBack()
  if (!t) return <p className="muted pdd-small"><b>{title}:</b> no phone readings in this range.</p>
  // Only measured networks speak about coverage; "not measured" and "radio
  // off / no SIM" are shown apart and never as the main network (2026-10-26).
  const main = t.by_tech.find((x) => !x.status || x.status === 'measured')
  const unmeasured = t.by_tech.filter((x) => x.status === 'not_measured' || x.status === 'radio_off').reduce((s, x) => s + x.readings, 0)
  return (
    <div className="pdd-rel-block">
      <p className="pdd-small" style={{ margin: '0 0 6px' }}>
        <b>{title}:</b> {t.total} readings{t.total > t.summarised ? ` (newest ${t.summarised} analysed)` : ''}
        {showDevices ? ` from ${t.devices} phone${t.devices === 1 ? '' : 's'}` : ''} · {when(t.first)} to {when(t.last)}
      </p>
      {main && (
        <div className="pd-tiles pd-tiles-sm">
          <Tile icon="🔢" hue="blue" label="Readings" value={t.total}
            hint={unmeasured ? `${unmeasured} not measured by the phone` : `${t.by_tech.length} network${t.by_tech.length === 1 ? '' : 's'}`} />
          {t.delay?.late_pct != null && t.delay.late_pct > 0 && (
            <Tile icon="⏳" label="Reached the server late" value={`${t.delay.late_pct}%`}
              verdict={t.delay.late_pct >= 50 ? { text: 'Often queued', tone: 'fair' } : null}
              hint={`more than ${Math.round(t.delay.late_after_s / 60)} min after; median ${t.delay.median_s != null ? (t.delay.median_s >= 3600 ? `${Math.round(t.delay.median_s / 3600)} h` : `${Math.round(t.delay.median_s / 60)} min`) : '-'}`} />
          )}
          <Tile icon="✅" label={`Good on ${main.tech}`} value={pct(main.good, main.readings)}
            verdict={rate(main.readings ? (100 * main.good) / main.readings : null, 80, 50, true, ['Mostly good', 'Mixed', 'Mostly weak'])} />
          <Tile icon="📶" label={`${main.tech} ${levelName(main.tech)} avg`} value={main.level_mean} unit="dBm" verdict={rateLevel(main.tech, main.level_mean)} />
          {main.tech === '4G' && <Tile icon="〰" label="RSRQ avg" value={main.rsrq_mean} unit="dB" verdict={rate(main.rsrq_mean, -10, -15)} />}
          {main.tech === '4G' && <Tile icon="🎯" label="CQI avg" value={main.cqi_mean} verdict={rate(main.cqi_mean, 10, 6)} />}
        </div>
      )}
      <table className="admin-table pdd-rel-table" data-pager="off">
        <thead><tr><th>Network</th><th>Readings</th><th>Weak</th><th>Fair</th><th>Good</th><th>Level avg</th><th>RSRQ</th><th>SINR</th><th>CQI</th></tr></thead>
        <tbody>
          {t.by_tech.map((x) => (
            <tr key={x.tech} className={x.status && x.status !== 'measured' ? `rel-st-${x.status}` : undefined}
              title={x.status === 'not_measured' ? 'The phone did not let the app read the cell (app in the background, location off). Not a network fault.'
                : x.status === 'radio_off' ? 'Flight mode, radio off or no SIM. Not a network fault.'
                  : x.status === 'no_coverage' ? 'The phone found no network.' : undefined}>
              <td>{x.tech}</td><td>{x.readings}</td>
              {x.status && x.status !== 'measured' && x.status !== 'no_coverage'
                ? <td colSpan={7} className="muted">not a network reading, left out of the shares</td>
                : <>
              <td>{pct(x.weak, x.readings)}</td><td>{pct(x.fair, x.readings)}</td><td>{pct(x.good, x.readings)}</td>
              <td>{x.level_mean != null ? `${levelName(x.tech)} ${x.level_mean} dBm` : '-'}</td>
              <td>{fmt(x.rsrq_mean, ' dB')}</td><td>{fmt(x.sinr_mean, ' dB')}</td><td>{fmt(x.cqi_mean)}</td>
                </>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted pdd-small" style={{ margin: '6px 0 0' }}>
        Newest: {when(t.newest.ts)} · {t.newest.tech ?? 'no network in the reading'}
        {t.newest.level != null ? ` · ${levelName(t.newest.tech ?? '4G')} ${t.newest.level} dBm` : ''}
        {t.newest.rsrq != null ? ` · RSRQ ${t.newest.rsrq} dB` : ''}{t.newest.sinr != null ? ` · SINR ${t.newest.sinr} dB` : ''}
        {t.newest.site_id ? <> · served by <Link to={siteLink(t.newest.site_id)}>{t.newest.site_id}</Link>{t.newest.sector ? ` sector ${t.newest.sector}` : ''}</> : ''}
      </p>
      {t.sites ? (t.sites.length > 0 && (
        <table className="admin-table pdd-rel-table" data-pager="off" style={{ marginTop: 8 }}>
          <thead><tr><th>Serving site · sector</th><th>Network</th><th>Readings</th><th>Weak</th><th>Level avg</th></tr></thead>
          <tbody>
            {t.sites.map((s) => (
              <tr key={`${s.site_id}-${s.sector}-${s.tech}`}>
                <td><Link to={siteLink(s.site_id)}>{s.site_id}</Link>{s.sector ? ` · ${s.sector}` : ''}</td><td>{s.tech}</td>
                <td>{s.readings}</td><td>{pct(s.weak, s.readings)}</td><td>{fmt(s.level_mean, ' dBm')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )) : <p className="muted pdd-small" style={{ margin: '4px 0 0' }}>Served by {t.sites_count} site{t.sites_count === 1 ? '' : 's'}; which ones is shown only while an emergency is declared.</p>}
    </div>
  )
}

function DriveTestBlock({ d }: { d: RelatedDriveTests | null }) {
  if (!d) return <p className="muted pdd-small"><b>Drive tests:</b> none in this range.</p>
  const q = d.quality, n = q.weak + q.fair + q.good
  return (
    <div className="pdd-rel-block">
      <p className="pdd-small" style={{ margin: '0 0 6px' }}>
        <b>Drive tests:</b> {d.readings} readings in {d.sessions.length} session{d.sessions.length === 1 ? '' : 's'} · weak {pct(q.weak, n)}, fair {pct(q.fair, n)}, good {pct(q.good, n)}
      </p>
      <table className="admin-table pdd-rel-table" data-pager="off">
        <thead><tr><th>Session</th><th>Date</th><th>Tech</th><th>Readings</th><th>Level avg</th><th>RSRQ</th><th>SINR</th><th>DL</th></tr></thead>
        <tbody>
          {d.sessions.slice(0, 10).map((s) => (
            <tr key={s.id}>
              <td><Link to={`${DT_SESSION_HISTORY_PATH}?session=${s.id}`}>{s.name || `Session ${s.id}`}</Link></td>
              <td>{s.date ?? '-'}</td><td>{s.tech}</td><td>{s.readings}</td><td>{fmt(s.level_mean, ' dBm')}</td>
              <td>{fmt(s.rsrq_mean, ' dB')}</td><td>{fmt(s.sinr_mean, ' dB')}</td><td>{fmt(s.dl_mean, ' Mbps')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ComplaintsBlock({ c, title }: { c: RelatedComplaints; title: string }) {
  if (!c.count) return <p className="muted pdd-small"><b>{title}:</b> none in this range.</p>
  const path = OPAQUE_PATHS['/problem-reports']
  return (
    <div className="pdd-rel-block pdd-small">
      <b>{title}:</b> {c.count} · {c.by_cause.map((x) => `${x.label} ${x.count}`).join(' · ')}
      <ul className="pdd-rel-list">
        {c.recent.slice(0, 5).map((p) => (
          <li key={p.id}><Link to={`${path}?tab=reports&report=${p.id}&status=all`}>{p.reference}</Link> {p.category} · {when(p.happened_at)} · {p.status}{p.cause_label ? ` · ${p.cause_label}` : ''}</li>
        ))}
      </ul>
    </div>
  )
}

// Site related analysis: the complaint's site and the area around the spot.
export function RelatedSiteAndArea({ r }: { r: ProblemReport }) {
  const rel = useRelated(r.id)
  const siteLink = useSiteLinkBack()
  const d = rel.data
  return (
    <section className="pdd-card pdd-live" id="pdd-related-site">
      <CardHead icon="🗂" title="Related data: site and area" hue="cyan"
        sub="phone telemetry and drive tests of the site and around the spot; other phones only as counts and averages" />
      <RelatedRangeBar data={d} showRadius />
      {rel.error && <p className="error">{apiErrorMessage(rel.error)}</p>}
      {!d ? <p className="muted">Loading…</p> : (
        <div className="pdd-live-cols pdd-rel-cols">
          <div>
            {d.site ? <>
              <Band icon="🗼" right={<ActiveAlarmsButton siteId={d.site.site_id} siteName={d.site.name} small />}>
                Site <Link to={siteLink(d.site.site_id)}>{d.site.site_id}</Link>{d.site.name && d.site.name !== d.site.site_id ? ` · ${d.site.name}` : ''} <span className="muted pdd-small">({d.site.why})</span>
              </Band>
              <TelemetryBlock t={d.site.telemetry} title="Phone readings it served" />
              <DriveTestBlock d={d.site.drive_tests} />
              <ComplaintsBlock c={d.site.complaints} title="Other complaints on this site" />
            </> : <p className="muted">No site within 10 km.</p>}
            <Band icon="⭕">Within {d.area.radius_km < 1 ? `${d.area.radius_km * 1000} m` : `${d.area.radius_km} km`} of the spot</Band>
            <TelemetryBlock t={d.area.telemetry} title="Phone readings" />
            <DriveTestBlock d={d.area.drive_tests} />
            <ComplaintsBlock c={d.area.complaints} title="Other complaints here" />
          </div>
          <div>
            <RelatedMap r={r} radiusKm={d.area.radius_km} site={d.site}
              points={[...(d.area.telemetry?.points ?? []), ...(d.area.drive_tests?.points ?? [])]} />
            <p className="muted pdd-small">Weakest reading per 50 m square around the spot, phones and drive tests; the white ring is the site.</p>
          </div>
        </div>
      )}
    </section>
  )
}

const RULE_TEXT: Record<string, string> = {
  emergency: 'An emergency is declared, so positions and serving sites are shown.',
  complaint_windows: 'Positions are shown only for readings near the times of this number\'s complaints (Security page setting).',
  hidden: 'Where the customer was is not shown: positions and the sites of each reading need a declared emergency.',
}

// Subscriber related analysis: every phone tied to the complaint's number.
export function RelatedCustomer({ r }: { r: ProblemReport }) {
  const rel = useRelated(r.id)
  const d = rel.data
  const c = d?.customer
  return (
    <section className="pdd-card pdd-span-2" id="pdd-related-customer">
      <CardHead icon="📱" title="The customer's phone data" sub="every phone tied to this number, for the range you pick" hue="violet" />
      <RelatedRangeBar data={d} />
      {rel.error && <p className="error">{apiErrorMessage(rel.error)}</p>}
      {!d ? <p className="muted">Loading…</p> : !c ? <p className="muted">This complaint has no mobile number.</p> : (
        <div className="pdd-live-cols pdd-rel-cols">
          <div>
            <p className="muted pdd-small" style={{ marginTop: 0 }}>
              {c.phones} phone{c.phones === 1 ? '' : 's'} tied to this number{c.withdrawn ? ` (${c.withdrawn} left out: rescue consent withdrawn)` : ''}. {RULE_TEXT[c.location_rule]}
            </p>
            <TelemetryBlock t={c.telemetry} title="Phone readings" showDevices={false} />
            <div className="pdd-rel-block pdd-small">
              <b>Speed tests:</b> {c.speed_tests.count
                ? <>{c.speed_tests.count} · average download {fmt(c.speed_tests.download_mean, ' Mbps')}, upload {fmt(c.speed_tests.upload_mean, ' Mbps')}, ping {fmt(c.speed_tests.ping_mean, ' ms')}
                  <ul className="pdd-rel-list">{c.speed_tests.recent.slice(0, 5).map((s, i) => (
                    <li key={i}>{when(s.ts)} · {s.bearer === 'wifi' ? 'Wi-Fi' : s.network_type || 'mobile'} · ↓ {fmt(s.download_mbps, ' Mbps')} ↑ {fmt(s.upload_mbps, ' Mbps')} · {fmt(s.ping_ms, ' ms')}{s.packet_loss_pct != null ? ` · loss ${s.packet_loss_pct}%` : ''}</li>
                  ))}</ul></> : 'none in this range.'}
            </div>
            <div className="pdd-rel-block pdd-small">
              <b>Calls:</b> {c.calls.count ? `${c.calls.count} · ${c.calls.by_outcome.map((x) => `${x.label} ${x.count}`).join(' · ')}` : 'none in this range.'}
            </div>
            <div className="pdd-rel-block pdd-small">
              <b>Sessions:</b> {c.sessions.length ? <ul className="pdd-rel-list">{c.sessions.slice(0, 8).map((s) => (
                <li key={s.id}>{s.name} · {s.readings} readings · {when(s.started_at)}</li>
              ))}</ul> : 'none in this range.'}
            </div>
            <ComplaintsBlock c={c.complaints} title="Other complaints from this number" />
          </div>
          <div>
            {c.telemetry && c.telemetry.points.length > 0
              ? <RelatedMap r={r} points={c.telemetry.points} />
              : <p className="muted pdd-small">No positions to draw. {c.telemetry?.points_hidden ? RULE_TEXT[c.location_rule] : ''}</p>}
          </div>
        </div>
      )}
    </section>
  )
}

// One line for the Diagnostics card when the check found nothing at the spot.
export function RelatedSummaryLine({ r, onOpen }: { r: ProblemReport; onOpen: (view: 'site' | 'subscriber') => void }) {
  const { data: d } = useRelated(r.id)
  if (!d) return null
  const parts: [string, 'site' | 'subscriber'][] = []
  if (d.customer?.telemetry) parts.push([`Customer: ${d.customer.telemetry.total} · ${new Date(d.customer.telemetry.last).toLocaleDateString()}`, 'subscriber'])
  if (d.site?.telemetry) parts.push([`${d.site.site_id}: ${d.site.telemetry.total} readings`, 'site'])
  if (d.area.telemetry || d.area.drive_tests) parts.push([`${d.area.radius_km} km: ${(d.area.telemetry?.total ?? 0) + (d.area.drive_tests?.readings ?? 0)} readings`, 'site'])
  if (!parts.length) return null
  return (
    <div className="pdd-rel-summary pdd-rel-pills">
      <span className="pdd-rel-pills-label">Related data · {RANGE_LABEL[d.range.kind]?.toLowerCase()}</span>
      {parts.map(([text, view], i) => (
        <button key={i} type="button" className={`pdd-rel-pill pdd-rel-pill-${view}`} onClick={() => {
          // Switch to the tab, then bring its related-data card into view: the
          // site pills open the tab already shown, so a scroll is the only sign
          // they worked (2026-10-26).
          onOpen(view)
          window.setTimeout(() => document.getElementById(view === 'subscriber' ? 'pdd-related-customer' : 'pdd-related-site')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
        }}>
          {view === 'subscriber' ? '📱 ' : '🗼 '}{text}</button>
      ))}
    </div>
  )
}
