import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import {
  useCreateProblemReport, useProblemReport, useProblemReports, useUpdateProblemReport,
} from '../api/queries'
import type { ProblemCategory, ProblemReport } from '../api/types'
import { DT_SESSION_HISTORY_PATH } from '../constants/opaqueRoutes'

// Problem Reports (2026-10-14) -- problems people report from the mobile
// app, and ones an engineer enters from a customer's complaint. Opening one
// shows the check: the phone's own reading and speed test next to what other
// phones and drive tests measured around the spot, today against the week
// before, and the likely cause with a suggested action. Admin and superadmin.

const CATEGORIES: { key: ProblemCategory; label: string }[] = [
  { key: 'no_signal', label: 'No signal' },
  { key: 'slow_data', label: 'Slow data' },
  { key: 'call_drop', label: 'Call drops' },
  { key: 'stuck_2g3g', label: 'Stuck on 2G/3G' },
  { key: 'other', label: 'Other' },
]
const STATUS_LABEL: Record<string, string> = { new: 'New', checked: 'Checked', closed: 'Closed' }
const NEPAL_CENTER: [number, number] = [28.3949, 84.124]

function fmt(v: number | null | undefined, unit = '') {
  return v == null ? '—' : `${v}${unit}`
}

function when(iso: string) {
  return new Date(iso).toLocaleString()
}

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) })
  return null
}

function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], 14)
  }, [map, lat, lng])
  return null
}

export default function ProblemReportsPage() {
  // ?status=all shows every report, e.g. from Subscriber Profile (2026-10-15).
  const [status, setStatus] = useState(() => {
    const s = new URLSearchParams(window.location.search).get('status')
    return s === 'all' ? '' : s ?? 'new'
  })
  const [source, setSource] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [entering, setEntering] = useState(false)
  const { data, isLoading, error } = useProblemReports({ status, source })
  const rows = data?.results ?? []

  return (
    <div className="admin-page" style={{ maxWidth: 1300 }}>
      <h1>Problem Reports</h1>
      <p className="muted">
        Problems people report with the mobile app's "Report a problem" button, and ones you enter from a customer's
        complaint. A report from the app carries the phone's signal and a speed test taken when it was sent. Open a
        report to see the check: what other phones and drive tests measured within 500 m, the time of the problem
        against the week before, and the likely cause with a suggested action. The cause comes from fixed rules on the
        measurements; confirm it before acting.
      </p>

      <div className="problem-toolbar">
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="new">New</option>
            <option value="checked">Checked</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label>
          From{' '}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">App and staff</option>
            <option value="app">Mobile app</option>
            <option value="staff">Entered by staff</option>
          </select>
        </label>
        <button type="button" className="btn-primary btn-small" onClick={() => { setEntering(true); setSelected(null) }}>
          Enter a complaint
        </button>
      </div>

      <div className="problem-layout">
        <div className="problem-list">
          {isLoading && <p className="muted">Loading…</p>}
          {error && <p className="error">{apiErrorMessage(error)}</p>}
          {!isLoading && !rows.length && <p className="muted">No reports.</p>}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`problem-row${selected === r.id ? ' problem-row-active' : ''}`}
              onClick={() => { setSelected(r.id); setEntering(false) }}
            >
              <span className="problem-row-title">{r.category_label}</span>
              <span className="muted">{when(r.happened_at)}</span>
              <span className="muted">
                {r.source === 'app' ? `App${r.network_type ? `, ${r.network_type}` : ''}` : `Staff (${r.entered_by ?? ''})`}
                {' · '}{STATUS_LABEL[r.status]}
              </span>
            </button>
          ))}
        </div>
        <div className="problem-detail">
          {entering && <EnterComplaint onSaved={(id) => { setEntering(false); setStatus(''); setSelected(id) }} />}
          {!entering && selected != null && <ReportDetail id={selected} />}
          {!entering && selected == null && <p className="muted">Choose a report, or enter a complaint.</p>}
        </div>
      </div>
    </div>
  )
}

function ReportDetail({ id }: { id: number }) {
  const { data: r, isLoading, error } = useProblemReport(id)
  const update = useUpdateProblemReport()
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setNote(r?.engineer_note ?? '')
    setCopied(false)
  }, [r?.id, r?.engineer_note])

  if (isLoading) return <p className="muted">Checking the measurements around this spot…</p>
  if (error || !r) return <p className="error">{apiErrorMessage(error)}</p>
  const c = r.check

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{r.category_label}</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        {when(r.happened_at)} · {r.source === 'app' ? 'Reported from the mobile app' : `Entered by ${r.entered_by}`}
        {r.phone_number ? ` · ${r.phone_number}` : ''}
      </p>
      {r.note && <p className="problem-note">"{r.note}"</p>}

      <div className="problem-map">
        <MapContainer center={[r.lat, r.lng]} zoom={14} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <FlyTo lat={r.lat} lng={r.lng} />
          <Circle center={[r.lat, r.lng]} radius={c?.radius_m ?? 500} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.06 }} />
          <CircleMarker center={[r.lat, r.lng]} radius={7} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }}>
            <Tooltip>Where the problem was reported</Tooltip>
          </CircleMarker>
        </MapContainer>
      </div>

      {r.source === 'app' && (
        <table className="problem-facts">
          <tbody>
            <tr><th>Phone's signal</th><td>
              {r.network_type || '—'}{r.band ? ` ${r.band}` : ''} · level {fmt(r.level_dbm, ' dBm')}
              {r.rsrq_db != null ? ` · RSRQ ${r.rsrq_db} dB` : ''}{r.sinr_db != null ? ` · SINR ${r.sinr_db} dB` : ''}
              {r.pci != null ? ` · PCI ${r.pci}` : ''}
            </td></tr>
            <tr><th>Speed test</th><td>
              download {fmt(r.download_mbps, ' Mbps')} · upload {fmt(r.upload_mbps, ' Mbps')} · ping {fmt(r.ping_ms, ' ms')}
              {' '}· jitter {fmt(r.jitter_ms, ' ms')} · loss {fmt(r.packet_loss_pct, '%')}
            </td></tr>
            <tr><th>Phone</th><td>{r.phone_model || '—'}{r.android_version ? `, Android ${r.android_version}` : ''}</td></tr>
          </tbody>
        </table>
      )}

      {c && (
        <>
          <h3>Likely cause</h3>
          {c.findings.map((f, i) => (
            <div key={i} className="problem-finding">
              <strong>{f.title}</strong>
              <p>{f.cause}</p>
              <p><em>Suggested action:</em> {f.action}</p>
              {f.evidence.length > 0 && <p className="muted">Measured: {f.evidence.join(' · ')}</p>}
            </div>
          ))}

          <h3>Measurements around the spot ({c.radius_m} m)</h3>
          <table className="problem-facts">
            <tbody>
              <tr><th>Serving site</th><td>
                {c.serving
                  ? <><Link to={`/sites/${c.serving.site_id}`}>{c.serving.site_id}</Link> {c.serving.cell_name} · {fmt(c.serving.km, ' km')} (found by {c.serving.matched_by})</>
                  : 'Not known from the report'}
              </td></tr>
              <tr><th>Nearest sites</th><td>
                {c.nearest_sites.length
                  ? c.nearest_sites.map((s, i) => (
                    <span key={s.site_id}>{i > 0 && ', '}<Link to={`/sites/${s.site_id}`}>{s.site_id}</Link> {s.km} km</span>
                  ))
                  : 'None within 5 km'}
              </td></tr>
              <tr><th>Phones at the time</th><td>{areaText(c.phones_at_time)}</td></tr>
              <tr><th>Phones, {c.baseline_days} days before</th><td>{areaText(c.phones_before)}</td></tr>
              <tr><th>Drive tests</th><td>
                {c.drive_tests.readings
                  ? <>
                    {c.drive_tests.readings} readings; 4G {fmt(c.drive_tests.rsrp_4g_mean, ' dBm')}
                    {c.drive_tests.rsrq_4g_mean != null ? `, RSRQ ${c.drive_tests.rsrq_4g_mean} dB` : ''}
                    {c.drive_tests.dl_4g_mean != null ? `, download ${c.drive_tests.dl_4g_mean} Mbps` : ''} average.{' '}
                    {c.drive_tests.sessions.map((s, i) => (
                      <span key={s.id}>{i > 0 && ', '}<Link to={`${DT_SESSION_HISTORY_PATH}?session=${s.id}`}>{s.name || `Session ${s.id}`}</Link>{s.date ? ` (${s.date})` : ''}</span>
                    ))}
                  </>
                  : 'None here'}
              </td></tr>
            </tbody>
          </table>

          <h3>Reply to the customer</h3>
          <p className="problem-reply">{c.customer_reply}</p>
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => { void navigator.clipboard?.writeText(c.customer_reply); setCopied(true) }}
          >
            {copied ? 'Copied' : 'Copy reply'}
          </button>
        </>
      )}

      <h3>Engineer's note</h3>
      <textarea rows={3} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      <div className="problem-actions">
        {(['checked', 'closed', 'new'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={s === 'checked' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
            disabled={update.isPending}
            onClick={() => update.mutate({ id: r.id, status: s, engineer_note: note })}
          >
            {s === 'checked' ? 'Mark checked' : s === 'closed' ? 'Close' : 'Reopen'}
          </button>
        ))}
        <span className="muted">
          Now: {STATUS_LABEL[r.status]}{r.checked_by ? ` (by ${r.checked_by})` : ''}
        </span>
      </div>
      {update.error && <p className="error">{apiErrorMessage(update.error)}</p>}
    </div>
  )
}

function areaText(a: { readings: number; share_4g_pct: number | null; rsrp_4g_mean: number | null; rsrq_4g_mean: number | null }) {
  if (!a.readings) return 'None'
  return `${a.readings} readings, ${fmt(a.share_4g_pct, '%')} on 4G; 4G ${fmt(a.rsrp_4g_mean, ' dBm')}` +
    (a.rsrq_4g_mean != null ? `, RSRQ ${a.rsrq_4g_mean} dB` : '') + ' average'
}

function EnterComplaint({ onSaved }: { onSaved: (id: number) => void }) {
  const create = useCreateProblemReport()
  const [category, setCategory] = useState<ProblemCategory>('slow_data')
  const [note, setNote] = useState('')
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null)
  const [time, setTime] = useState(() => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 16)
  })

  const save = () => {
    if (!point) return
    create.mutate(
      { category, note, lat: point.lat, lng: point.lng, happened_at: new Date(time).toISOString() },
      { onSuccess: (r: ProblemReport) => onSaved(r.id) },
    )
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Enter a complaint</h2>
      <p className="muted">Click the map where the customer has the problem. Do not type the customer's name or number here.</p>
      <div className="problem-form">
        <label>
          Problem{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value as ProblemCategory)}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label>
          When <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <textarea rows={2} style={{ width: '100%' }} placeholder="What the customer said" value={note}
        onChange={(e) => setNote(e.target.value)} maxLength={500} />
      <div className="problem-map">
        <MapContainer center={NEPAL_CENTER} zoom={7} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <ClickToPick onPick={(lat, lng) => setPoint({ lat, lng })} />
          {point && (
            <>
              <Circle center={[point.lat, point.lng]} radius={500} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.06 }} />
              <CircleMarker center={[point.lat, point.lng]} radius={7} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }} />
            </>
          )}
        </MapContainer>
      </div>
      <div className="problem-actions">
        <button type="button" className="btn-primary btn-small" disabled={!point || create.isPending} onClick={save}>
          {create.isPending ? 'Checking…' : 'Save and check'}
        </button>
        {!point && <span className="muted">Pick the place on the map first.</span>}
      </div>
      {create.error && <p className="error">{apiErrorMessage(create.error)}</p>}
    </div>
  )
}
