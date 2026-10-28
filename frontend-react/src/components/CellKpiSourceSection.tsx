import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useCellKpiSource, useFetchCellKpis, useSaveCellKpiSource } from '../api/queries'
import type { CellKpiLevel, CellKpiSource } from '../api/types'

// Network KPIs per cell (2026-10-28, core/cell_kpi.py). The KPI team is
// building an API for the figures their dashboard shows; this card sets where
// DT-WATCH fetches them from each morning. "Demo files" uses the daily network
// exports placed on the server, so the site pages can be checked meanwhile.
const BACKEND_LABEL: Record<CellKpiSource['backend'], string> = { off: 'Off', demo: 'Demo files', http: 'Their API' }
const LEVEL_LABEL: Record<CellKpiLevel, string> = { day: 'Whole day', bbh: 'Busy hour', hour: 'Every hour' }

export default function CellKpiSourceSection() {
  const { data: src, error } = useCellKpiSource()
  const save = useSaveCellKpiSource()
  const fetchNow = useFetchCellKpis()
  const [open, setOpen] = useState(false)
  const [backend, setBackend] = useState<CellKpiSource['backend']>('off')
  const [url, setUrl] = useState('')
  const [scheme, setScheme] = useState<'Bearer' | 'Token'>('Bearer')
  const [key, setKey] = useState('')
  const [levels, setLevels] = useState<CellKpiLevel[]>(['day', 'bbh'])
  const [hour, setHour] = useState(6)
  const [keepDays, setKeepDays] = useState(400)
  const [dash, setDash] = useState('')
  const [mapText, setMapText] = useState('')
  const [mapError, setMapError] = useState('')
  const [fetchDate, setFetchDate] = useState('')
  const [msg, setMsg] = useState('')

  const running = !!src?.running

  const start = () => {
    if (!src) return
    setBackend(src.backend); setUrl(src.api_url); setScheme(src.auth_scheme); setKey('')
    setLevels(src.levels); setHour(src.fetch_hour); setKeepDays(src.keep_days); setDash(src.dashboard_url)
    setMapText(Object.keys(src.field_map).length ? JSON.stringify(src.field_map, null, 2) : '')
    setMapError(''); setMsg(''); setOpen(true)
  }
  const toggleLevel = (l: CellKpiLevel) =>
    setLevels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))

  const r = src?.last_result && 'date' in src.last_result ? src.last_result : null

  return (
    <section>
      <h2>Network KPIs per cell</h2>
      <p className="muted">
        PRB use, users, throughput, CQI, drops and availability of every 4G cell, from the KPI team. They are fetched
        once a day after the hour set here, matched to the sectors of the site list and shown on each site page and
        in the complaint check.
      </p>
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      {src && !open && (
        <>
          <div className="admin-page-actions" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted">
              Source: <b>{BACKEND_LABEL[src.backend]}</b>
              {src.backend === 'http' && <> · {src.api_url}</>}
              {src.backend !== 'off' && <> · {src.levels.map((l) => LEVEL_LABEL[l]).join(', ')} · after {String(src.fetch_hour).padStart(2, '0')}:00</>}
              {' · '}{src.stored_rows.toLocaleString()} rows stored{src.newest_date ? `, newest ${src.newest_date}` : ''}
            </span>
            <button type="button" className="btn-secondary btn-small" onClick={start}>Edit connection</button>
          </div>
          {src.backend !== 'off' && (
            <div className="admin-page-actions" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {src.backend === 'http' && (
                <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  Day <input type="date" value={fetchDate} onChange={(e) => setFetchDate(e.target.value)} />
                </label>
              )}
              <button type="button" className="btn-primary btn-small" disabled={running || fetchNow.isPending}
                onClick={() => fetchNow.mutate(fetchDate || undefined, { onSuccess: () => setMsg(''),
                  onError: (e) => setMsg(apiErrorMessage(e)) })}>
                {running ? 'Fetching…' : src.backend === 'demo' ? 'Load the demo files now' : fetchDate ? `Fetch ${fetchDate} now` : 'Fetch yesterday now'}
              </button>
              {msg && <span className="error">{msg}</span>}
            </div>
          )}
          {src.backend === 'demo' && (
            <p className="muted">Demo files on the server: {src.demo_files.length ? src.demo_files.join(', ') : 'none'}.</p>
          )}
          {r && (
            <div className={`cellkpi-result ${r.ok ? '' : 'bad'}`}>
              <b>Last fetch {src.last_run_at ? new Date(src.last_run_at).toLocaleString() : ''}:</b>{' '}
              {r.ok
                ? <>{(r.rows ?? 0).toLocaleString()} rows for {(r.dates ?? [r.date]).join(', ')}{r.levels?.length ? ` (${r.levels.map((l) => LEVEL_LABEL[l as CellKpiLevel] ?? l).join(', ')})` : ''},
                  {' '}{(r.matched ?? 0).toLocaleString()} matched to a sector{r.unmatched ? `, ${r.unmatched} not in the site list` : ''}
                  {r.rejected ? `, ${r.rejected} refused` : ''}{r.seconds != null ? ` · ${r.seconds} s` : ''}.</>
                : <span className="error">{r.error}</span>}
              {r.note && <span className="muted"> {r.note}</span>}
              {!!r.unmatched_cells?.length && (
                <details>
                  <summary>Cells not in the site list ({r.unmatched})</summary>
                  <p className="muted">These cells' figures are kept but shown on no site page until the site list has the sector.</p>
                  <div className="cellkpi-unmatched">{r.unmatched_cells.join(' · ')}</div>
                </details>
              )}
            </div>
          )}
        </>
      )}
      {src && open && (
        <form className="alarm-source-form" onSubmit={(e) => {
          e.preventDefault()
          let fieldMap: Record<string, string> = {}
          if (mapText.trim()) {
            try {
              const parsed = JSON.parse(mapText)
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('x')
              fieldMap = parsed
            } catch {
              setMapError('Write the field names as {"their name": "our name"}.')
              return
            }
          }
          setMapError('')
          save.mutate({ backend, api_url: url.trim(), auth_scheme: scheme, levels, fetch_hour: hour, keep_days: keepDays,
            dashboard_url: dash.trim(), field_map: fieldMap, ...(key.trim() ? { api_key: key.trim() } : {}) },
          { onSuccess: () => { setOpen(false); setMsg('') } })
        }}>
          <label>Source
            <select value={backend} onChange={(e) => setBackend(e.target.value as CellKpiSource['backend'])}>
              <option value="off">Off</option>
              <option value="demo">Demo files (daily network exports on the server)</option>
              <option value="http">Their API</option>
            </select>
          </label>
          {backend === 'http' && (
            <>
              <label>Address
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/cell-kpis" />
              </label>
              <label>Header
                <select value={scheme} onChange={(e) => setScheme(e.target.value as 'Bearer' | 'Token')}>
                  <option value="Bearer">Bearer &lt;key&gt;</option>
                  <option value="Token">Token &lt;key&gt;</option>
                </select>
              </label>
              <label>Key
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password"
                  placeholder={src.has_key ? 'Leave blank to keep the saved key' : 'Paste the key'} />
              </label>
            </>
          )}
          <fieldset className="cellkpi-levels">
            <legend>Fetch</legend>
            {(['day', 'bbh', 'hour'] as CellKpiLevel[]).map((l) => (
              <label key={l}><input type="checkbox" checked={levels.includes(l)} onChange={() => toggleLevel(l)} /> {LEVEL_LABEL[l]}</label>
            ))}
          </fieldset>
          <label>Fetch yesterday's figures after
            <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
          <label>Keep figures for
            <select value={keepDays} onChange={(e) => setKeepDays(Number(e.target.value))}>
              {[90, 180, 400, 760, 1100].map((d) => <option key={d} value={d}>{d === 400 ? '13 months' : d === 760 ? '25 months' : d === 1100 ? '3 years' : `${d} days`}</option>)}
            </select>
          </label>
          <label>Link to a cell on their dashboard (optional)
            <input value={dash} onChange={(e) => setDash(e.target.value)} placeholder="https://…?cell={cell}&date={date}" />
          </label>
          {backend === 'http' && (
            <label>Their field names, where they differ from ours (optional)
              <textarea rows={4} value={mapText} onChange={(e) => setMapText(e.target.value)}
                placeholder={'{"dl_prb_util": "prb_dl", "cell": "cell_name"}'} />
              <span className="muted">Ours: {src.fields.join(', ')}</span>
            </label>
          )}
          {mapError && <p className="error">{mapError}</p>}
          {save.error && <p className="error">{apiErrorMessage(save.error)}</p>}
          <div className="admin-page-actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn-secondary btn-small" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn-primary btn-small" disabled={save.isPending || !levels.length}>{save.isPending ? 'Saving…' : 'Save'}</button>
            {src.has_key && (
              <button type="button" className="btn-secondary btn-small" disabled={save.isPending}
                onClick={() => { if (window.confirm('Remove the saved key?')) save.mutate({ clear_key: true }) }}>Remove saved key</button>
            )}
          </div>
        </form>
      )}
    </section>
  )
}
