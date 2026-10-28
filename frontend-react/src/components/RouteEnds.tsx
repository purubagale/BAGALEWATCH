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
    iconAnchor: [11, 29],
    tooltipAnchor: [0, -26],
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
