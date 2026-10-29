import { Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'

// Where a session started and ended (2026-10-28, "manage starting point and
// last point by using different color place marker on each individual
// session"). A green pin with S at the first reading, a dark red pin with E
// at the last; the hover names the session and the time. One pair per
// session on every session map (Collections, Telemetry Drive Test, DT
// Session History, DT Explore).

type Pt = { lat: number | null | undefined; lng: number | null | undefined; ts?: string | number | null }

function pin(letter: string, color: string): L.DivIcon {
  return L.divIcon({
    className: 'route-end-pin',
    html: `<span style="background:${color}"><b>${letter}</b></span>`,
    iconSize: [22, 30],
    // The tip floats 8 px above the reading, so the reading's dot stays visible
    // under the pin (2026-10-28: a session whose readings sat on two spots
    // looked like a line with no plot).
    iconAnchor: [11, 37],
    tooltipAnchor: [0, -34],
  })
}
const START = pin('S', '#16a34a')
const END = pin('E', '#b91c1c')

function when(ts: Pt['ts']) {
  if (ts == null || ts === '') return ''
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString()
}

/** The first and last readings with a position, in the order given (oldest first). */
export function routeEnds<T extends Pt>(points: T[]): { start: T; end: T } | null {
  const placed = points.filter((p) => p.lat != null && p.lng != null)
  if (!placed.length) return null
  return { start: placed[0], end: placed[placed.length - 1] }
}

export default function RouteEnds({ points, name }: { points: Pt[]; name?: string }) {
  const ends = routeEnds(points)
  if (!ends) return null
  const label = name ? `${name}: ` : ''
  const same = ends.start === ends.end
  return (
    <>
      <Marker position={[ends.start.lat as number, ends.start.lng as number]} icon={START} zIndexOffset={900}>
        <Tooltip>{label}{same ? 'only reading' : 'start'}{ends.start.ts ? ` · ${when(ends.start.ts)}` : ''}</Tooltip>
      </Marker>
      {!same && (
        <Marker position={[ends.end.lat as number, ends.end.lng as number]} icon={END} zIndexOffset={900}>
          <Tooltip>{label}end{ends.end.ts ? ` · ${when(ends.end.ts)}` : ''}</Tooltip>
        </Marker>
      )}
    </>
  )
}

/** "34 readings at 2 places" over a map whose readings stack on a few spots
 * (2026-10-28). Readings taken at one spot are drawn as one dot, so a session
 * recorded from a phone that did not move shows almost nothing. Shown only
 * when there are at least three readings per place on average. */
export function StackedNote({ points }: { points: Pt[] }) {
  const placed = points.filter((p) => p.lat != null && p.lng != null)
  const places = new Set(placed.map((p) => `${(p.lat as number).toFixed(5)},${(p.lng as number).toFixed(5)}`)).size
  if (placed.length < 6 || places * 3 > placed.length) return null
  return (
    <div className="route-stacked-note">
      {placed.length.toLocaleString()} readings at {places} place{places === 1 ? '' : 's'}: readings taken at the same spot are drawn as one dot
      {places === 1 ? '. The phone did not move.' : ', so the phone hardly moved.'}
    </div>
  )
}
