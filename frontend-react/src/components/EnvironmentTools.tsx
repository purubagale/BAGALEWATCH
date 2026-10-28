import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useSetEnvironment } from '../api/queries'

// Outdoors, inside a building or in a vehicle (2026-10-26). Phones tag each
// reading when the person taps (or estimate it from movement and GPS); here a
// session's readings can be filtered by place, and a stretch tagged
// afterwards when a tap was forgotten (core/environment.py).

export type EnvFilter = '' | 'outdoor' | 'indoor' | 'vehicle' | 'none'

export const ENV_LABEL: Record<string, string> = { outdoor: 'Outdoors', indoor: 'Inside a building', vehicle: 'In a vehicle' }
const SOURCE_LABEL: Record<string, string> = { user: 'set on the phone', estimated: 'estimated', edited: 'set on the web', session: "from the session's test type" }

interface Item { ts: string | number; environment?: string | null; environment_source?: string | null }

// A drive test's own place (2026-10-28): a reading with none set on the web
// takes its session's test type.
const DT_SESSION_PLACE: Record<string, string> = { drive: 'vehicle', walk_outdoor: 'outdoor', walk_indoor: 'indoor' }

/** Drive-test readings with the place each one counts as: its own (set on
 * the web for a stretch) or its session's test type. */
export function withSessionPlace<T extends { environment?: string | null }>(samples: T[], sessionEnvironment?: string | null) {
  const fallback = DT_SESSION_PLACE[sessionEnvironment ?? ''] ?? null
  return samples.map((s) => ({
    ...s,
    environment: s.environment || fallback,
    environment_source: s.environment ? 'edited' : fallback ? 'session' : null,
  }))
}

/** Keeps the items that match the filter ('' = all, 'none' = not tagged). */
export function filterByEnvironment<T extends Item>(items: T[], filter: EnvFilter): T[] {
  if (!filter) return items
  return items.filter((s) => (filter === 'none' ? !s.environment : s.environment === filter))
}

/** "Inside a building (set on the phone)" for a hover card, or ''. */
export function environmentText(s: Item): string {
  if (!s.environment) return ''
  return `${ENV_LABEL[s.environment] ?? s.environment}${s.environment_source ? ` (${SOURCE_LABEL[s.environment_source] ?? s.environment_source})` : ''}`
}

/** Share of tagged readings by place, e.g. "Inside a building 62% · Outdoors 38%"; null when none is tagged. */
export function environmentShare(env: Record<string, number> | undefined): { indoorPct: number; text: string; tagged: number } | null {
  if (!env) return null
  const tagged = (env.outdoor ?? 0) + (env.indoor ?? 0) + (env.vehicle ?? 0)
  if (!tagged) return null
  const text = (['indoor', 'outdoor', 'vehicle'] as const)
    .filter((k) => env[k])
    .map((k) => `${ENV_LABEL[k]} ${Math.round((100 * env[k]) / tagged)}%`).join(' · ')
  return { indoorPct: Math.round((100 * (env.indoor ?? 0)) / tagged), text, tagged }
}

function localInput(ts: string | number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default function EnvironmentTools({ items, filter, onFilter, session, canEdit, onTagged }: {
  items: Item[]
  filter: EnvFilter
  onFilter: (f: EnvFilter) => void
  session?: { collection_session?: string; telemetry_session?: number; dt_session?: number }
  canEdit: boolean
  onTagged?: () => void
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { outdoor: 0, indoor: 0, vehicle: 0, none: 0 }
    const src: Record<string, number> = {}
    for (const s of items) {
      c[s.environment ?? 'none'] = (c[s.environment ?? 'none'] ?? 0) + 1
      if (s.environment_source) src[s.environment_source] = (src[s.environment_source] ?? 0) + 1
    }
    return { c, src }
  }, [items])
  const times = useMemo(() => items.map((s) => new Date(s.ts).getTime()).filter((t) => !Number.isNaN(t)), [items])
  const first = times.length ? Math.min(...times) : null
  const last = times.length ? Math.max(...times) : null
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [place, setPlace] = useState('indoor')
  const save = useSetEnvironment()
  const [done, setDone] = useState('')

  const pills: [EnvFilter, string, number][] = [
    ['', 'All', items.length], ['outdoor', 'Outdoors', counts.c.outdoor], ['indoor', 'Inside a building', counts.c.indoor],
    ['vehicle', 'In a vehicle', counts.c.vehicle], ['none', 'Not tagged', counts.c.none],
  ]
  return (
    <div className="env-tools">
      <div className="env-pills">
        <span className="muted">Where:</span>
        {pills.map(([k, label, n]) => (
          <button key={k || 'all'} type="button" className={`env-pill${filter === k ? ' on' : ''}`} disabled={k !== '' && n === 0}
            onClick={() => onFilter(k)}>{label} <b>{n}</b></button>
        ))}
        {Object.keys(counts.src).length > 0 && (
          <span className="muted env-src">{Object.entries(counts.src).map(([k, n]) => `${n} ${SOURCE_LABEL[k] ?? k}`).join(' · ')}</span>
        )}
        {canEdit && session && first != null && last != null && (
          <button type="button" className="btn-secondary btn-small" onClick={() => {
            setFrom(localInput(first)); setTo(localInput(last)); setDone(''); setOpen((v) => !v)
          }}>{open ? 'Close' : 'Tag a stretch…'}</button>
        )}
      </div>
      {open && (
        <form className="env-form" onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ ...session, from: new Date(from).toISOString(), to: new Date(to).toISOString(), environment: place }, {
            onSuccess: (d) => {
              setDone(`${d.updated} reading${d.updated === 1 ? '' : 's'} tagged ${d.environment ? ENV_LABEL[d.environment] : 'as not tagged'}.`)
              onTagged?.()
            },
          })
        }}>
          <label>From <input type="datetime-local" step="1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>to <input type="datetime-local" step="1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>was <select value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="outdoor">Outdoors</option>
            <option value="indoor">Inside a building</option>
            <option value="vehicle">In a vehicle</option>
            <option value="">Not tagged (clear)</option>
          </select></label>
          <button type="submit" className="btn-primary btn-small" disabled={save.isPending || !from || !to}>
            {save.isPending ? 'Saving…' : 'Apply'}</button>
          {done && <span className="muted">{done}</span>}
          {save.error && <span className="error">{apiErrorMessage(save.error)}</span>}
        </form>
      )}
    </div>
  )
}
