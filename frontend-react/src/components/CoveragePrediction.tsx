import { useEffect, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { apiErrorMessage } from '../api/client'
import { useSavePredictionSettings } from '../api/queries'
import type {
  PredictionEnvironment, PredictionSettings, PredictionSettingsInput, RadioBandKey, RadioValueKey,
} from '../api/types'
import { RSRP_BANDS, RXLEV_BANDS, bandColor } from '../lib/dtBands'
import { referencePower, type PredictionGrid, type PredictTech } from '../lib/coveragePrediction'

// Predicted coverage on the site map (2026-10-28): the picture drawn over the
// map, and the panel under it with the scale, the comparison with measured
// readings and the radio values (admins change them; see
// core/coverage_prediction.py and lib/coveragePrediction.ts).

export type PredictionView = 'level' | 'server' | 'overlap'

/** Below this the cell is left clear: no usable service. */
const FLOOR: Record<PredictTech, number> = { '4G': -125, '3G': -120, '2G': -110 }

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Draws the grid as one picture over the map, under the readings. */
export function PredictionOverlay({ grid, tech, view, colorOf }: {
  grid: PredictionGrid; tech: PredictTech; view: PredictionView; colorOf: (txIndex: number) => string
}) {
  const map = useMap()
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = grid.n
    canvas.height = grid.n
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(grid.n, grid.n)
    const bands = tech === '2G' ? RXLEV_BANDS : RSRP_BANDS
    const cache = new Map<string, [number, number, number]>()
    const rgb = (c: string) => { let v = cache.get(c); if (!v) cache.set(c, (v = hexRgb(c))); return v }
    for (let i = 0; i < grid.best.length; i++) {
      const v = grid.best[i]
      if (Number.isNaN(v) || v < FLOOR[tech]) continue
      let color: string
      let alpha = 165
      if (view === 'level') color = bandColor(bands, v)
      else if (view === 'server') color = colorOf(grid.server[i])
      else {
        // Overlap: where the next sector is within 6 dB, the two compete (handover area).
        const gap = Number.isNaN(grid.second[i]) ? 99 : v - grid.second[i]
        if (gap > 6) continue
        color = gap <= 3 ? '#dc2626' : '#f97316'
        alpha = 185
      }
      const [r, g, b] = rgb(color)
      img.data.set([r, g, b, alpha], i * 4)
    }
    ctx.putImageData(img, 0, 0)
    const layer = L.imageOverlay(canvas.toDataURL('image/png'), [[grid.south, grid.west], [grid.north, grid.east]], {
      opacity: 0.75, className: 'prediction-overlay', interactive: false,
    })
    layer.addTo(map)
    layer.bringToBack()
    return () => { map.removeLayer(layer) }
  }, [map, grid, tech, view, colorOf])
  return null
}

const VALUE_LABEL: Record<RadioValueKey, string> = {
  freq_mhz: 'Frequency (MHz)', power_dbm: 'Power (dBm)', bandwidth_mhz: 'Bandwidth (MHz)',
  gain_dbi: 'Antenna gain (dBi)', loss_db: 'Cable loss (dB)',
}
const POWER_HELP: Record<string, string> = {
  '4G': 'reference signal power per resource element',
  '3G': 'pilot (CPICH) power',
  '2G': 'BCCH carrier power',
}
const ENV_LABEL: Record<PredictionEnvironment, string> = {
  urban: 'Town', suburban: 'Small town / villages', rural: 'Open country',
}

/** The radio values, read-only for viewers, editable for admins. */
function RadioValues({ settings, usedBands, canEdit }: {
  settings: PredictionSettings; usedBands: RadioBandKey[]; canEdit: boolean
}) {
  const save = useSavePredictionSettings()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [showAll, setShowAll] = useState(false)
  const keys = (showAll ? (Object.keys(settings.bands) as RadioBandKey[]) : usedBands)
  const start = () => {
    const d: Record<string, string> = {}
    for (const k of Object.keys(settings.bands) as RadioBandKey[]) {
      for (const v of Object.keys(VALUE_LABEL) as RadioValueKey[]) d[`${k}.${v}`] = settings.bands[k][v] == null ? '' : String(settings.bands[k][v])
    }
    for (const g of ['environment', 'rx_height_m', 'default_height_m', 'default_tilt_deg', 'offset_db'] as const) d[g] = String(settings[g])
    setDraft(d)
    setEditing(true)
  }
  const submit = () => {
    const input: PredictionSettingsInput = { bands: {} }
    for (const k of Object.keys(settings.bands) as RadioBandKey[]) {
      const vals: Partial<Record<RadioValueKey, number | null>> = {}
      for (const v of Object.keys(VALUE_LABEL) as RadioValueKey[]) {
        if (v === 'bandwidth_mhz' && settings.bands[k].tech !== '4G') continue
        const raw = draft[`${k}.${v}`]
        const num = raw === '' ? null : Number(raw)
        if (num !== settings.bands[k][v]) vals[v] = num
      }
      if (Object.keys(vals).length) input.bands![k] = vals
    }
    input.environment = draft.environment as PredictionEnvironment
    for (const g of ['rx_height_m', 'default_height_m', 'default_tilt_deg', 'offset_db'] as const) input[g] = Number(draft[g])
    save.mutate(input, { onSuccess: () => setEditing(false) })
  }
  const cell = (k: RadioBandKey, v: RadioValueKey) => {
    const b = settings.bands[k]
    if (v === 'bandwidth_mhz' && b.tech !== '4G') return <td key={v} className="muted">—</td>
    if (editing) {
      return (
        <td key={v}>
          <input type="number" step="0.1" value={draft[`${k}.${v}`] ?? ''}
            onChange={(e) => setDraft({ ...draft, [`${k}.${v}`]: e.target.value })} />
        </td>
      )
    }
    const changed = b.changed.includes(v)
    return (
      <td key={v} className={changed ? 'pred-changed' : ''}
        title={changed ? `Changed from the starting value ${settings.defaults.bands[k][v]}` : 'Starting value'}>
        {b[v]}
      </td>
    )
  }
  return (
    <div className="pred-values">
      <div className="pred-values-head">
        <b>Radio values</b>{' '}
        <span className="muted">
          {settings.is_default
            ? 'typical starting values; NTC\'s planning values replace them when available.'
            : `changed${settings.updated_by ? ` by ${settings.updated_by}` : ''}${settings.updated_at ? ` on ${new Date(settings.updated_at).toLocaleDateString()}` : ''}; changed values are in bold.`}
          {' '}A sector's own maximum power from the engineering parameters comes before the band's power.
        </span>
      </div>
      <div className="pred-values-scroll">
        <table className="admin-table pred-table" data-pager="off">
          <thead>
            <tr>
              <th>Band</th>
              {(Object.keys(VALUE_LABEL) as RadioValueKey[]).map((v) => <th key={v}>{VALUE_LABEL[v]}</th>)}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k}>
                <td title={`Power is the ${POWER_HELP[settings.bands[k].tech]}`}>{settings.bands[k].label}</td>
                {(Object.keys(VALUE_LABEL) as RadioValueKey[]).map((v) => cell(k, v))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && usedBands.length < Object.keys(settings.bands).length && (
        <button type="button" className="btn-link" onClick={() => setShowAll(true)}>Show every band</button>
      )}
      <div className="pred-globals">
        {editing ? (
          <>
            <label>Area{' '}
              <select value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })}>
                {(Object.keys(ENV_LABEL) as PredictionEnvironment[]).map((e) => <option key={e} value={e}>{ENV_LABEL[e]}</option>)}
              </select>
            </label>
            <label>Phone height <input type="number" step="0.5" value={draft.rx_height_m} onChange={(e) => setDraft({ ...draft, rx_height_m: e.target.value })} /> m</label>
            <label>Antenna height when unknown <input type="number" step="1" value={draft.default_height_m} onChange={(e) => setDraft({ ...draft, default_height_m: e.target.value })} /> m</label>
            <label>Tilt when unknown <input type="number" step="0.5" value={draft.default_tilt_deg} onChange={(e) => setDraft({ ...draft, default_tilt_deg: e.target.value })} />°</label>
            <label>Model offset <input type="number" step="0.5" value={draft.offset_db} onChange={(e) => setDraft({ ...draft, offset_db: e.target.value })} /> dB</label>
          </>
        ) : (
          <span className="muted">
            Area: {ENV_LABEL[settings.environment]} · phone {settings.rx_height_m} m above ground · when the site list has
            none: antenna {settings.default_height_m} m high, tilt {settings.default_tilt_deg}° · model offset{' '}
            {settings.offset_db > 0 ? '+' : ''}{settings.offset_db} dB
          </span>
        )}
      </div>
      {canEdit && (
        <div className="pred-actions">
          {editing ? (
            <>
              <button type="button" className="btn-primary btn-small" disabled={save.isPending} onClick={submit}>
                {save.isPending ? 'Saving…' : 'Save for everyone'}
              </button>
              <button type="button" className="btn-secondary btn-small" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-secondary btn-small" onClick={start}>Change values</button>
              {!settings.is_default && (
                <button type="button" className="btn-secondary btn-small" disabled={save.isPending}
                  onClick={() => { if (window.confirm('Go back to the starting values for every band?')) save.mutate({ reset: true }) }}>
                  Back to starting values
                </button>
              )}
            </>
          )}
          {save.error && <span className="error">{apiErrorMessage(save.error)}</span>}
        </div>
      )}
    </div>
  )
}

export function PredictionPanel({
  settings, grid, working, error, tech, techs, setTech, view, setView, radius, setRadius, colorOf, directionLabel,
  usedBands, canEdit, calibration, measuredOn,
}: {
  settings: PredictionSettings | undefined
  grid: PredictionGrid | null
  working: boolean
  error: string | null
  tech: PredictTech
  techs: PredictTech[]
  setTech: (t: PredictTech) => void
  view: PredictionView
  setView: (v: PredictionView) => void
  radius: number
  setRadius: (m: number) => void
  colorOf: (txIndex: number) => string
  directionLabel: (txIndex: number) => string
  usedBands: RadioBandKey[]
  canEdit: boolean
  calibration: { n: number; mean: number; sd: number } | null
  measuredOn: boolean
}) {
  const save = useSavePredictionSettings()
  const bands = tech === '2G' ? RXLEV_BANDS : RSRP_BANDS
  const measure = tech === '4G' ? 'RSRP' : tech === '3G' ? 'RSCP' : 'RxLev'
  const assumed = grid ? grid.transmitters.filter((t) => t.assumedHeight || t.assumedTilt) : []
  const fromSector = grid ? grid.transmitters.filter((t) => referencePower(t, settings!.bands[t.band]).from === 'sector') : []
  return (
    <div className="site-mini-map-legend pred-panel">
      <div className="pred-controls">
        {techs.length > 1 && (
          <div className="ck-seg" role="group" aria-label="Technology">
            {techs.map((t) => <button key={t} type="button" className={tech === t ? 'on' : ''} onClick={() => setTech(t)}>{t}</button>)}
          </div>
        )}
        <div className="ck-seg" role="group" aria-label="Show">
          <button type="button" className={view === 'level' ? 'on' : ''} onClick={() => setView('level')}>Level</button>
          <button type="button" className={view === 'server' ? 'on' : ''} onClick={() => setView('server')}>Best sector</button>
          <button type="button" className={view === 'overlap' ? 'on' : ''} onClick={() => setView('overlap')}>Overlap</button>
        </div>
        <label>Around the site{' '}
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {[1500, 3000, 5000, 8000].map((m) => <option key={m} value={m}>{m / 1000} km</option>)}
          </select>
        </label>
        {working && <span className="muted">Working it out…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {view === 'level' && (
        <div className="site-terrain-3d-scale">
          {bands.map((x) => <span key={x.label}><i style={{ background: x.color }} />{x.label}</span>)}
          <span className="muted">dBm predicted {measure}; clear: below {FLOOR[tech]} dBm</span>
        </div>
      )}
      {view === 'server' && grid && (
        <div className="site-terrain-3d-scale">
          {grid.transmitters.map((t, i) => (t.tech === tech
            ? <span key={t.key}><i style={{ background: colorOf(i) }} />{directionLabel(i)}</span> : null))}
        </div>
      )}
      {view === 'overlap' && (
        <div className="site-terrain-3d-scale">
          <span><i style={{ background: '#dc2626' }} />next sector within 3 dB</span>
          <span><i style={{ background: '#f97316' }} />within 6 dB</span>
          <span className="muted">where two sectors compete: handovers happen here; wide areas mean interference</span>
        </div>
      )}
      <div>
        Predicted level outdoors, {settings?.rx_height_m ?? 1.5} m above the ground, from the antenna pattern, height and
        tilt, the path loss for the area type and the loss over hills between the site and each point. Ground detail is
        about 30 m; buildings and trees are not included, so read it as a planning estimate.
        {grid && grid.missingTiles > 0 ? ' Some ground heights could not be read; those parts are left clear.' : ''}
      </div>
      {assumed.length > 0 && (
        <div className="site-mini-map-legend-warn">
          {assumed.length} direction{assumed.length === 1 ? '' : 's'} with no {assumed.some((t) => t.assumedHeight) ? 'height' : ''}
          {assumed.some((t) => t.assumedHeight) && assumed.some((t) => t.assumedTilt) ? ' or ' : ''}
          {assumed.some((t) => t.assumedTilt) ? 'tilt' : ''} in the site list; the assumed value is used.
        </div>
      )}
      {fromSector.length > 0 && (
        <div className="site-mini-map-legend-sub">{fromSector.length} direction{fromSector.length === 1 ? ' uses its' : 's use their'} own maximum power from the site list.</div>
      )}
      {measuredOn ? (
        calibration && calibration.n >= 5 ? (
          <div className="pred-calib">
            Against {calibration.n.toLocaleString()} measured squares of this site's sectors: readings are{' '}
            <b>{Math.abs(calibration.mean).toFixed(1)} dB {calibration.mean < 0 ? 'weaker' : 'stronger'}</b> than predicted on
            average (spread {calibration.sd.toFixed(1)} dB).
            {Math.abs(calibration.mean) >= 3 && calibration.n >= 20 && canEdit && settings && (
              <>{' '}
                <button type="button" className="btn-link" disabled={save.isPending}
                  onClick={() => {
                    const next = Math.round((settings.offset_db + calibration.mean) * 2) / 2
                    if (window.confirm(`Set the model offset to ${next > 0 ? '+' : ''}${next} dB for every site? One site's drive tests are a small sample; several sites give a better figure.`)) {
                      save.mutate({ offset_db: next })
                    }
                  }}>Use it as the model offset</button>
              </>
            )}
          </div>
        ) : (
          <div className="muted">Not enough measured readings inside the predicted area to compare.</div>
        )
      ) : (
        <div className="muted">Tick Measured to compare the prediction with drive tests and phone readings.</div>
      )}
      {settings && <RadioValues settings={settings} usedBands={usedBands} canEdit={canEdit} />}
    </div>
  )
}
