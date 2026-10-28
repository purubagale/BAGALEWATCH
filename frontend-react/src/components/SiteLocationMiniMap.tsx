import { CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useSiteMeasuredCoverage } from '../api/queries'
import type { Sector } from '../api/types'
import { divergentSectorPoints } from '../lib/sectorLocation'
import { TILT_REACH_DRAW_MAX_M, buildWedgePolygon, destinationPoint, tiltReachM } from '../lib/sectorWedge'
import { RSRP_BANDS, RXLEV_BANDS, bandColor } from '../lib/dtBands'
import { statusColor } from '../lib/statusColor'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { beamFan, beamProfile, coverTotals, type BeamProfile, type FanRadial } from '../lib/terrainProfile'
import type { Terrain3DData } from './SiteTerrain3D'

// The 3D terrain view (2026-10-28) brings its own map library, so it loads only when ticked.
const SiteTerrain3D = lazy(() => import('./SiteTerrain3D'))

// Antenna coverage wedges (2026-09-27, "how can we use its [KML] data to
// show antenna orientation, azimuth, beam power in graphical
// representation"). Originally colored by tech (--tech-4g/-3g/-2g), but
// the common real case is several co-located sectors that are ALL the
// same tech (a typical 3- or 6-sector 4G site) — every wedge rendered
// identically green with no way to tell one sector's cone from another's
// (2026-09-27 follow-up, screenshot showing an all-green cluster: "only
// green color is used... if only color is used then use different color
// for different sectors"). Cycles through a distinct palette by each
// sector's position in the list instead, so overlapping wedges at one
// site are always visually distinguishable regardless of tech. A sector
// only gets a wedge when it has real azimuth/beamwidth/radius — never a
// fabricated default (see Sector.beamwidth/Sector.radius's docstring in
// models.py).
const WEDGE_COLOR_PALETTE = [
  '#3b82f6', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#ef4444', '#22c55e',
]
function wedgeColorForIndex(i: number): string {
  return WEDGE_COLOR_PALETTE[i % WEDGE_COLOR_PALETTE.length]
}

// Satellite/hybrid tiles (2026-08-09 follow-up: "mini map is not
// informative may be satellite view will be informative") — same Google
// hybrid layer (imagery + roads + labels) every other map in this app
// already uses (TopologyMap.tsx/DtExploreTab.tsx's SATELLITE_URL), swapped
// in here for the plain OSM street layer this started with. A BTS site's
// surroundings (rooftop mount, compound, access road) read far better on
// imagery than on a street-only basemap, especially at this zoom.
// Three things can be drawn for a sector (2026-10-13). They answer
// different questions, so each has its own switch:
//   diagram   the wedge above: direction from the site list, with a width
//             and length that are the same for every sector on a band.
//   tilt      a line to where the centre of the beam meets flat ground,
//             from the antenna's height and tilt.
//   measured  where readings served by the sector were really taken.
const UNKNOWN_SECTOR_COLOR = '#94a3b8'

function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`
}

/** Zooms and moves the map so that everything drawn is inside it: the
 * site, sectors at their own location, the wedges, the tilt lines and the
 * measured dots, whichever are switched on. Runs again when that set
 * changes and when the map changes size (fullscreen on or off), which is
 * also when Leaflet has to be told its box changed. */
function FitToDrawn({ corners, fitKey }: { corners: [number, number][]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      if (corners.length > 1) {
        map.fitBounds(L.latLngBounds(corners), { padding: [22, 22], maxZoom: FIT_MAX_ZOOM })
      } else if (corners.length === 1) {
        map.setView(corners[0], MINI_MAP_ZOOM)
      }
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
const MINI_MAP_ZOOM = 16
// How far in the automatic fit may go; a single small site would otherwise fill the box with one roof.
const FIT_MAX_ZOOM = 18

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function dotIcon(color: string, size: number): L.DivIcon {
  return L.divIcon({
    className: 'site-mini-map-dot-marker',
    html: `<span class="site-mini-map-dot" style="width:${size}px;height:${size}px;background:${color};"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

type MapPoint = { lat: number; lng: number; label: string; kind: 'site' | 'sector' }

// Vertical beamwidth by band group (2026-10-28). NTC's site list names the
// antenna model but not its beamwidths. The defaults are typical of the
// multi-band panels in the 4G file: CommScope RZVV-65A-R4 lists about
// 14-17 degrees on 700-960 MHz and 5.4-9.4 degrees on 1400-2700 MHz. They
// can be changed on the page and are kept in this browser.
type BandGroup = 'low' | 'high'
const VBW_DEFAULT: Record<BandGroup, number> = { low: 15, high: 7 }
const VBW_KEY = 'dtwatch_vertical_beamwidth'
function bandGroup(s: Sector): BandGroup {
  // The sector's own band first: a 4G B3 sector's carrier reads "B3+B20" (the site's bands).
  const band = (s.site_band || (s.tech === '3G' ? '2100' : s.carrier) || '').toUpperCase()
  if (/\b(B20|B8|B5|B28|800|850|900|700)\b/.test(band) || /GSM\s*900/.test(band)) return 'low'
  if (!band.trim() && (s.tech || '') === '4G' && /20$/.test(s.sector || '')) return 'low'
  if (!band.trim() && (s.tech || '') === '2G') return 'low'
  return 'high'
}
function loadVbw(): Record<BandGroup, number> {
  try {
    const v = JSON.parse(localStorage.getItem(VBW_KEY) || 'null')
    if (v && typeof v.low === 'number' && typeof v.high === 'number') return v
  } catch {
    // storage blocked: the defaults apply
  }
  return VBW_DEFAULT
}

/** Ground along one sector's direction, the beam centre and where it lands
 * (2026-10-28). Heights in metres above sea level, distance across. */
function BeamProfileChart({ p, color }: { p: BeamProfile; color: string }) {
  const W = 300
  const H = 80
  const maxD = p.points[p.points.length - 1].d
  const grounds = p.points.map((q) => q.ground)
  const lo = Math.min(p.siteGround, ...grounds)
  const hi = Math.max(p.antenna ?? p.siteGround, ...grounds)
  const span = Math.max(20, hi - lo)
  const x = (d: number) => (d / maxD) * W
  const y = (h: number) => H - 4 - ((h - lo) / span) * (H - 10)
  const ground = `M0,${H} L0,${y(p.siteGround)} ` + p.points.map((q) => `L${x(q.d).toFixed(1)},${y(q.ground).toFixed(1)}`).join(' ') + ` L${W},${H} Z`
  const beamEnd = p.terrainReachM ?? maxD
  const tan = p.antenna != null && p.flatReachM ? (p.antenna - p.siteGround) / p.flatReachM : null
  return (
    <svg className="site-beam-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Ground along the sector, from ${Math.round(lo)} to ${Math.round(hi)} m`}>
      <path d={ground} fill="#a3a38a" opacity={0.55} />
      {p.antenna != null && p.verticalBeamwidth != null && tan != null && [1, -1].map((sign) => {
        const edgeTan = Math.tan(Math.atan(tan) + (sign * p.verticalBeamwidth! * Math.PI) / 360)
        const end = (sign > 0 ? p.nearM : p.farM) ?? maxD
        return <line key={sign} x1={0} y1={y(p.antenna!)} x2={x(end)} y2={y(p.antenna! - end * edgeTan)} stroke={color} strokeWidth={1} opacity={0.6} />
      })}
      {p.runs.filter((r) => r.cover !== 'weak').map((r, i) => {
        const inside = p.points.filter((q) => q.d >= r.from && q.d <= r.to)
        if (inside.length < 1) return null
        const top = inside.map((q) => `L${x(q.d).toFixed(1)},${y(q.ground).toFixed(1)}`).join(' ')
        return <path key={`g${i}`} d={`M${x(r.from).toFixed(1)},${H} ${top} L${x(r.to).toFixed(1)},${H} Z`}
          fill={r.cover === 'shadow' ? '#334155' : color} opacity={r.cover === 'shadow' ? 0.55 : 0.45} />
      })}
      {p.runs.map((r, i) => (
        <line key={`s${i}`} x1={x(r.from)} y1={H - 2} x2={x(r.to)} y2={H - 2} strokeWidth={4}
          stroke={r.cover === 'strong' ? color : r.cover === 'shadow' ? '#1e293b' : '#cbd5e1'} />
      ))}
      {p.antenna != null && tan != null && (
        <line x1={0} y1={y(p.antenna)} x2={x(beamEnd)} y2={y(p.antenna - beamEnd * tan)} stroke={color} strokeWidth={2} strokeDasharray="5 3" />
      )}
      {p.antenna != null && <line x1={0} y1={y(p.siteGround)} x2={0} y2={y(p.antenna)} stroke="#334155" strokeWidth={3} />}
      {p.antenna != null && tan != null && p.terrainReachM != null && (
        <circle cx={x(p.terrainReachM)} cy={y(p.antenna - p.terrainReachM * tan)} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />
      )}
      <text x={2} y={10} fontSize={9} fill="#475569">{Math.round(hi)} m</text>
      <text x={2} y={H - 2} fontSize={9} fill="#475569">{Math.round(lo)} m</text>
      <text x={W - 2} y={H - 2} fontSize={9} fill="#475569" textAnchor="end">{distanceText(maxD)}</text>
    </svg>
  )
}

export default function SiteLocationMiniMap({
  siteId, lat, lng, status, sectors = [],
}: {
  /** Needed for the measured layer; without it that switch is not offered. */
  siteId?: string
  lat: number | null
  lng: number | null
  status: string
  /** Optional — when sectors carry their own GPS override that genuinely
   * differs from the site's location (2026-08-09, "sometimes same sites
   * with multiple sectors may have different lat long location as sector
   * expansion"), each distinct one gets plotted as its own small pin
   * alongside the site's main pin, instead of the map only ever being
   * able to show one point per site. */
  sectors?: Sector[]
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showDiagram, setShowDiagram] = useState(true)
  const [showTilt, setShowTilt] = useState(false)
  const [showMeasured, setShowMeasured] = useState(false)
  const [measuredSession, setMeasuredSession] = useState<number | null>(null)
  const [show3d, setShow3d] = useState(false)
  const measured = useSiteMeasuredCoverage(siteId, showMeasured, measuredSession)

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const points = useMemo<MapPoint[]>(() => {
    if (lat == null || lng == null) return []
    const sectorPoints = divergentSectorPoints(lat, lng, sectors)
    return [
      { lat, lng, label: 'Site location', kind: 'site' as const },
      ...sectorPoints.map((p) => ({ ...p, kind: 'sector' as const })),
    ]
  }, [lat, lng, sectors])

  // Wedge origin is the sector's OWN location when it diverges from the
  // site (same per-sector GPS override the markers above already use via
  // divergentSectorPoints), falling back to the site's point otherwise —
  // never a second, separate notion of "where this sector is."
  const wedgeSectors = useMemo(() => {
    if (lat == null || lng == null) return []
    return sectors
      .filter((s) => s.azimuth != null && s.beamwidth != null && s.radius != null)
      .map((s) => ({
        sector: s,
        origin: [s.lat ?? lat, s.lng ?? lng] as [number, number],
      }))
  }, [lat, lng, sectors])

  // One colour per sector, shared by all three layers. Sectors with a wedge
  // keep the colours they always had; the others follow on.
  const colorByKey = useMemo(() => {
    const out = new Map<string, string>()
    const ordered = [...wedgeSectors.map((w) => w.sector), ...sectors.filter((s) => !wedgeSectors.some((w) => w.sector.id === s.id))]
    ordered.forEach((s, i) => {
      const color = wedgeColorForIndex(i)
      if (s.cell_name) out.set(s.cell_name.trim().toLowerCase(), color)
      out.set(`id:${s.id}`, color)
    })
    return out
  }, [sectors, wedgeSectors])

  // Reach from height and tilt: a line, not a wedge, so it needs no beamwidth
  // and works for 2G and 3G sectors too.
  const tiltLines = useMemo(() => {
    if (lat == null || lng == null) return []
    return sectors
      .filter((s) => s.azimuth != null)
      .map((s) => {
        const reach = tiltReachM(s.height, s.mech_tilt, s.elec_tilt)
        if (reach == null) return null
        const origin: [number, number] = [s.lat ?? lat, s.lng ?? lng]
        const drawn = Math.min(reach, TILT_REACH_DRAW_MAX_M)
        return { sector: s, origin, reach, end: destinationPoint(origin[0], origin[1], s.azimuth as number, drawn) }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
  }, [lat, lng, sectors])
  const sectorsWithoutTiltReach = sectors.filter((s) => s.azimuth != null).length - tiltLines.length

  const squares = showMeasured ? measured.data?.squares ?? [] : []

  // Beam profiles on real ground, for the 3D view (2026-10-28). Sectors
  // that share a mast position, azimuth, height and tilt (2G A, 3G P1 and 4G
  // J3 often do) share one beam, so the 3D view draws one line per antenna
  // direction rather than a dot per sector.
  const [profiles, setProfiles] = useState<Map<string, BeamProfile | null> | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [names3d, setNames3d] = useState(false)
  const [vbw, setVbwState] = useState<Record<BandGroup, number>>(loadVbw)
  const setVbw = (group: BandGroup, value: number) => {
    const next = { ...vbw, [group]: value }
    setVbwState(next)
    try { localStorage.setItem(VBW_KEY, JSON.stringify(next)) } catch { /* kept until the page reloads */ }
  }
  const directions = useMemo(() => {
    if (lat == null || lng == null) return []
    const byKey = new Map<string, { key: string; az: number; tilt: number | null; height: number | null; origin: [number, number]; band: BandGroup; sectors: Sector[] }>()
    for (const s of sectors) {
      if (s.azimuth == null) continue
      const tilt = s.mech_tilt != null || s.elec_tilt != null ? (s.mech_tilt ?? 0) + (s.elec_tilt ?? 0) : null
      const origin: [number, number] = [s.lat ?? lat, s.lng ?? lng]
      // The band group splits a direction: low and high band beams have different vertical widths.
      const band = bandGroup(s)
      const key = `${origin[0].toFixed(5)},${origin[1].toFixed(5)}|${s.azimuth}|${tilt ?? '-'}|${s.height ?? '-'}|${band}`
      const d = byKey.get(key)
      if (d) d.sectors.push(s)
      else byKey.set(key, { key, az: s.azimuth, tilt, height: s.height ?? null, origin, band, sectors: [s] })
    }
    return [...byKey.values()].sort((x, y) => x.az - y.az)
  }, [lat, lng, sectors])
  useEffect(() => {
    if (!show3d) return
    let live = true
    setProfiles(null)
    Promise.all(directions.map(async (d) =>
      [d.key, await beamProfile(d.origin[0], d.origin[1], d.az, d.height, d.tilt, vbw[d.band])] as const,
    )).then((rows) => { if (live) setProfiles(new Map(rows)) })
    return () => { live = false }
  }, [show3d, directions, vbw])
  useEffect(() => {
    if (focus && !directions.some((d) => d.key === focus)) setFocus(null)
  }, [focus, directions])
  const sectorName = (s: Sector) => s.sector || s.cell_name || `#${s.id}`
  const directionName = (d: { az: number; sectors: Sector[] }) => `${d.az}° · ${d.sectors.map(sectorName).join(', ')}`
  // From the lit / shadow runs (2026-10-28): where the beam first lights the
  // ground, where it last does, whether it is still lit where the check stops
  // (6 km), and how much ground in between a hill hides.
  const coverText = (p: BeamProfile) => {
    const strong = p.runs.filter((r) => r.cover === 'strong')
    if (!strong.length) return p.runs.length ? 'the beam lights no ground within 6 km that the antenna can see' : null
    const first = strong[0].from
    const last = strong[strong.length - 1].to
    const end = p.points[p.points.length - 1].d
    const hidden = coverTotals(p.runs.filter((r) => r.from >= first && r.to <= last)).shadow
    return `strong from ${distanceText(first)} to ${last >= end ? `${distanceText(end)}, where the check stops (it carries on further)` : distanceText(last)}`
      + (hidden > 0 ? `; ${distanceText(hidden)} of that is hidden behind hills` : '')
  }
  const coverShort = (d: { az: number }, p: BeamProfile) => {
    const strong = p.runs.filter((r) => r.cover === 'strong')
    if (!strong.length) return null
    const end = p.points[p.points.length - 1].d
    const last = strong[strong.length - 1].to
    return `${d.az}° · ${distanceText(strong[0].from)}–${last >= end ? '6 km+' : distanceText(last)}`
  }

  // The footprint across one chosen direction (2026-10-28): radials every 5
  // degrees across 65 degrees, the horizontal beamwidth of NTC's panels.
  const FAN_BEAMWIDTH = 65
  const [fan, setFan] = useState<{ key: string; radials: FanRadial[] } | null>(null)
  useEffect(() => {
    const d = focus ? directions.find((x) => x.key === focus) : null
    if (!show3d || !d || d.height == null || d.height <= 0) { setFan(null); return }
    let live = true
    beamFan(d.origin[0], d.origin[1], d.az, FAN_BEAMWIDTH, d.height, d.tilt, vbw[d.band])
      .then((radials) => { if (live) setFan(radials ? { key: d.key, radials } : null) })
    return () => { live = false }
  }, [show3d, focus, directions, vbw])

  // Every corner of everything drawn, so the fit can take it all in.
  const wedgeShapes = useMemo(
    () => wedgeSectors.map(({ sector: s, origin }) => ({
      sector: s,
      positions: buildWedgePolygon(origin[0], origin[1], s.azimuth as number, s.beamwidth as number, s.radius as number),
    })),
    [wedgeSectors],
  )
  const drawnCorners = useMemo<[number, number][]>(() => {
    const out: [number, number][] = points.map((p) => [p.lat, p.lng])
    if (showDiagram) wedgeShapes.forEach((w) => w.positions.forEach((c) => out.push(c)))
    if (showTilt) tiltLines.forEach((t) => out.push(t.end))
    squares.forEach((q) => out.push([q.lat, q.lng]))
    return out
  }, [points, showDiagram, wedgeShapes, showTilt, tiltLines, squares])

  const terrainData = useMemo<Terrain3DData>(() => {
    const colorOf = (s: Sector) => colorByKey.get(`id:${s.id}`) ?? UNKNOWN_SECTOR_COLOR
    const shown = focus ? directions.filter((d) => d.key === focus) : directions
    const shownIds = new Set(shown.flatMap((d) => d.sectors.map((s) => s.id)))
    const techOfKey = new Map<string, string>()
    for (const d of shown) for (const s of d.sectors) if (s.cell_name) techOfKey.set(s.cell_name.trim().toLowerCase(), s.tech || '4G')
    const beams: Terrain3DData['beams'] = []
    const segments: Terrain3DData['segments'] = []
    const cells: Terrain3DData['cells'] = []
    const labels: Terrain3DData['labels'] = []
    const reach: Terrain3DData['reach'] = []
    for (const d of shown) {
      const p = profiles?.get(d.key)
      if (!p) continue
      const color = colorOf(d.sectors[0])
      const landed = p.terrainReachM != null
      const dist = landed ? (p.terrainReachM as number) : p.points[p.points.length - 1].d
      const [la, ln] = destinationPoint(d.origin[0], d.origin[1], d.az, dist)
      const stretch = coverText(p)
      const what = (landed ? `beam centre meets the ground ${distanceText(dist)} out` : 'beam centre does not come down within 6 km')
        + (stretch ? `; ${stretch}` : '')
      // The line runs to the far edge when that is farther than the centre.
      const lineEnd = p.farM != null && p.farM > dist ? p.farM : p.nearM != null && p.farM == null ? p.points[p.points.length - 1].d : dist
      const end = destinationPoint(d.origin[0], d.origin[1], d.az, lineEnd)
      beams.push({ from: d.origin, to: end, color, landed, label: `${directionName(d)}: ${what}` })
      for (const r of p.runs) {
        if (r.cover === 'weak') continue
        segments.push({
          from: destinationPoint(d.origin[0], d.origin[1], d.az, r.from),
          to: destinationPoint(d.origin[0], d.origin[1], d.az, r.to),
          color, cover: r.cover,
          label: `${directionName(d)}: ${r.cover === 'strong' ? 'lit by the beam' : 'hidden behind a hill'}, ${distanceText(r.from)}–${distanceText(r.to)}`,
        })
      }
      if (fan && fan.key === d.key) {
        const step = fan.radials.length > 1 ? Math.abs(fan.radials[1].bearing - fan.radials[0].bearing) : FAN_BEAMWIDTH
        for (const rad of fan.radials) {
          for (const r of rad.runs) {
            if (r.cover === 'weak') continue
            const a = rad.bearing - step / 2
            const b = rad.bearing + step / 2
            cells.push({
              positions: [
                destinationPoint(d.origin[0], d.origin[1], a, r.from), destinationPoint(d.origin[0], d.origin[1], b, r.from),
                destinationPoint(d.origin[0], d.origin[1], b, r.to), destinationPoint(d.origin[0], d.origin[1], a, r.to),
              ],
              color, cover: r.cover,
              label: r.cover === 'strong' ? 'Lit by the beam' : 'Hidden from the antenna by a hill',
            })
          }
        }
      }
      labels.push({ lat: la, lng: ln, color, label: `${directionName(d)}: ${what}`,
        text: coverShort(d, p) ?? (landed ? `${d.az}° → ${distanceText(dist)}` : `${d.az}° · no landing`) })
      if (landed) reach.push({ lat: la, lng: ln, color, label: `${directionName(d)}: ${what}` })
    }
    return {
      sites: points.map((p) => ({
        lat: p.lat, lng: p.lng, label: p.label,
        color: p.kind === 'site' ? statusColor(status) : '#a855f7', size: p.kind === 'site' ? 18 : 13,
      })),
      wedges: showDiagram ? wedgeShapes.filter(({ sector: s }) => shownIds.has(s.id)).map(({ sector: s, positions }) => ({
        positions, color: colorOf(s),
        label: `${s.cell_name || s.sector} (${s.tech || '4G'}), azimuth ${s.azimuth}°`,
      })) : [],
      lines: showTilt ? tiltLines.filter((t) => shownIds.has(t.sector.id)).map((t) => ({
        from: t.origin, to: t.end, color: colorOf(t.sector),
        label: `${t.sector.cell_name || t.sector.sector}: flat-ground reach ${distanceText(t.reach)}`,
      })) : [],
      // One direction shown: its readings coloured by signal level, the
      // question being how well it serves. All shown: by sector, as on the flat map.
      squares: squares
        .filter((q) => !focus || techOfKey.has(q.key.trim().toLowerCase()))
        .map((q) => {
          const tech = techOfKey.get(q.key.trim().toLowerCase())
          return {
            lat: q.lat, lng: q.lng, hollow: !!q.uncertain, ring: q.source === 'phone',
            color: focus ? bandColor(tech === '2G' ? RXLEV_BANDS : RSRP_BANDS, q.level)
              : colorByKey.get(q.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR,
            label: `${q.key} · ${q.level != null ? `${q.level} dBm` : 'no level'} · ${q.n} reading${q.n === 1 ? '' : 's'}`,
          }
        }),
      beams,
      segments,
      cells,
      labels,
      reach,
      corners: [...drawnCorners, ...beams.map((x) => x.to)],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, status, showDiagram, wedgeShapes, showTilt, tiltLines, squares, colorByKey, profiles, directions, focus, drawnCorners, fan])

  if (!points.length) {
    return <div className="site-mini-map-empty">No GPS coordinates recorded for this site.</div>
  }

  const sitePoint = points[0]
  const hasDivergentSectors = points.length > 1

  return (
    <div className="site-mini-map-container">
      {/* Wrapper div carries the height, not MapContainer's own style prop —
          react-leaflet only applies MapContainer's style/className at first
          mount (see project memory feedback_react_leaflet_mapcontainer_style_once),
          so sizing needs to come from something react-leaflet doesn't own.
          The note below (when present) is a SIBLING of this, not a child —
          .site-mini-map-wrap is a fixed-height overflow:hidden box for the
          map itself, which would clip anything else placed inside it. */}
      <div ref={wrapRef} className={isFullscreen ? 'site-mini-map-wrap site-mini-map-fullscreen' : 'site-mini-map-wrap'}>
        <button
          type="button"
          className="site-mini-map-fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
        >
          {isFullscreen ? '⤦' : '⤢'}
        </button>
        {show3d ? (
          <Suspense fallback={<div className="site-mini-map-empty">Loading the 3D map…</div>}>
            <SiteTerrain3D center={[sitePoint.lat, sitePoint.lng]} data={terrainData} names={names3d} />
          </Suspense>
        ) : (
        <MapContainer center={[sitePoint.lat, sitePoint.lng]} zoom={MINI_MAP_ZOOM} scrollWheelZoom={isFullscreen} attributionControl={false}>
          {/* subdomains="0123" is REQUIRED here, not cosmetic — Leaflet's
              TileLayer defaults to `subdomains="abc"` (OpenStreetMap's own
              convention) whenever the prop is omitted. Google's tile
              servers only exist at mt0-mt3, not mta/mtb/mtc, so without
              this every single tile request 404s and the map renders as a
              blank grey box with just the marker/zoom control showing
              (exactly the bug reported 2026-08-09: "map is not working").
              Confirmed by cross-checking the two other places this app
              already uses SATELLITE_URL successfully — TopologyMap.tsx and
              DtExploreTab.tsx both explicitly pass this same override. */}
          <TileLayer url={SATELLITE_URL} subdomains="0123" />
          <InvalidateOnResize />
          <FitToDrawn
            corners={drawnCorners}
            fitKey={`${isFullscreen}|${showDiagram}|${showTilt}|${squares.length}|${drawnCorners.length}|${lat},${lng}`}
          />
          {squares.map((q, i) => (
            <CircleMarker
              key={`sq-${i}`}
              center={[q.lat, q.lng]}
              radius={q.source === 'phone' ? 4 : 3}
              pathOptions={{
                color: colorByKey.get(q.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR,
                fillColor: colorByKey.get(q.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR,
                // Hollow: another site uses the same id and this reading could be its.
                fillOpacity: q.uncertain ? 0 : 0.8,
                weight: q.uncertain ? 1.5 : q.source === 'phone' ? 2 : 0,
              }}
            >
              <Tooltip direction="top">
                {q.key} · {q.level != null ? `${q.level} dBm` : 'no level'} · {q.n} {q.n === 1 ? 'reading' : 'readings'} ·{' '}
                {q.source === 'phone' ? 'phones' : 'drive test'}
                {q.uncertain ? ' · may belong to another site with the same ID' : ''}
              </Tooltip>
            </CircleMarker>
          ))}
          {showTilt && tiltLines.map(({ sector: s, origin, reach, end }) => (
            <Polyline
              key={`tilt-${s.id}`}
              positions={[origin, end]}
              pathOptions={{ color: colorByKey.get(`id:${s.id}`) ?? UNKNOWN_SECTOR_COLOR, weight: 3, dashArray: '6 6' }}
            >
              <Tooltip direction="top" sticky>
                {s.cell_name || s.sector} ({s.tech || '4G'}): the centre of the beam meets flat ground about{' '}
                {distanceText(reach)} out ({s.height} m high, {(s.mech_tilt ?? 0) + (s.elec_tilt ?? 0)}° tilt)
                {reach > TILT_REACH_DRAW_MAX_M ? `; drawn to ${distanceText(TILT_REACH_DRAW_MAX_M)}` : ''}
              </Tooltip>
            </Polyline>
          ))}
          {showDiagram && wedgeShapes.map(({ sector: s, positions }, i) => (
            <Polygon
              key={`wedge-${s.id}`}
              positions={positions}
              pathOptions={{ color: wedgeColorForIndex(i), fillColor: wedgeColorForIndex(i), fillOpacity: 0.3, weight: 1 }}
            >
              <Tooltip direction="top">
                {s.cell_name || s.sector} ({s.tech || '4G'}) — Az {s.azimuth}° · BW {s.beamwidth}°
                {s.mech_tilt != null || s.elec_tilt != null
                  ? ` · Tilt ${s.mech_tilt ?? 0}+${s.elec_tilt ?? 0}°`
                  : ''}
                {s.max_tx_power_dbm != null ? ` · ${s.max_tx_power_dbm} dBm` : ''}
              </Tooltip>
            </Polygon>
          ))}
          {points.map((p, i) => (
            <Marker
              key={i}
              position={[p.lat, p.lng]}
              icon={p.kind === 'site' ? dotIcon(statusColor(status), 18) : dotIcon('#a855f7', 13)}
            >
              <Tooltip direction="top" offset={[0, -8]}>{p.label}</Tooltip>
            </Marker>
          ))}
        </MapContainer>
        )}
        <div className="site-mini-map-layers">
          <label title="Direction from the site list. Width and length are the same for every sector on a band.">
            <input type="checkbox" checked={showDiagram} onChange={(e) => setShowDiagram(e.target.checked)} /> Diagram
          </label>
          <label title="Where the centre of each beam meets flat ground, from antenna height and tilt. Hills change this.">
            <input type="checkbox" checked={showTilt} onChange={(e) => setShowTilt(e.target.checked)} /> Reach from tilt
          </label>
          {siteId && (
            <label title="Where readings served by each sector were really taken, from drive tests and phones.">
              <input type="checkbox" checked={showMeasured} onChange={(e) => setShowMeasured(e.target.checked)} /> Measured
            </label>
          )}
          <label title="Tilted view on real ground heights, with where each beam centre meets the hills.">
            <input type="checkbox" checked={show3d} onChange={(e) => setShow3d(e.target.checked)} /> 3D terrain
          </label>
        </div>
      </div>
      {show3d && (
        <div className="site-mini-map-legend">
          <div className="site-terrain-3d-chips" role="group" aria-label="Directions to show">
            <button type="button" className={focus == null ? 'on' : ''} onClick={() => setFocus(null)}>All directions</button>
            {directions.map((d) => (
              <button key={d.key} type="button" className={focus === d.key ? 'on' : ''}
                onClick={() => setFocus(focus === d.key ? null : d.key)} title={directionName(d)}>
                <i style={{ background: colorByKey.get(`id:${d.sectors[0].id}`) ?? UNKNOWN_SECTOR_COLOR }} />
                {d.az}° <span>{d.sectors.map(sectorName).join(' ')}</span>
              </button>
            ))}
            <label className="site-terrain-3d-names">
              <input type="checkbox" checked={names3d} onChange={(e) => setNames3d(e.target.checked)} /> Place names
            </label>
          </div>
          <div className="site-terrain-3d-vbw">
            Vertical beamwidth:{' '}
            <label>low band (700–900 MHz){' '}
              <input type="number" min={2} max={40} step={0.5} value={vbw.low} onChange={(e) => setVbw('low', Number(e.target.value) || VBW_DEFAULT.low)} />°
            </label>{' '}
            <label>high band (1800–2600 MHz){' '}
              <input type="number" min={2} max={40} step={0.5} value={vbw.high} onChange={(e) => setVbw('high', Number(e.target.value) || VBW_DEFAULT.high)} />°
            </label>
          </div>
          <div>
            One line per antenna direction (same azimuth, tilt and band group), from the site. Thick colour: ground the
            antenna can see and that lies inside the beam (strong). Dark dashes: ground hidden behind a hill (shadow: no direct line from the antenna; signal still reaches it by bending over the ridge, but much weaker).
            Thin line: in view but outside the beam, weaker. The dot is where the centre of the beam lands; "6 km+"
            means the beam is still strong where the check stops. Pick one direction to see its whole sector
            ({FAN_BEAMWIDTH}° wide) shaded: colour where it is lit, dark where hills hide the ground.
            {focus && fan == null && directions.find((x) => x.key === focus)?.height ? ' Working out the sector…' : ''}
            {focus && showMeasured && ' Readings are coloured by signal level for the chosen direction.'}
            {' '}Ground heights have about 30 m detail; buildings and trees are not included.
          </div>
          {focus && showMeasured && (
            <div className="site-terrain-3d-scale">
              {RSRP_BANDS.map((x) => <span key={x.label}><i style={{ background: x.color }} />{x.label}</span>)}
              <span className="muted">dBm (2G uses the RxLev scale)</span>
            </div>
          )}
          {directions.length === 0 && <div>No sector here has an azimuth, so no beam can be drawn.</div>}
          {directions.length > 0 && profiles == null && <div>Reading the ground heights…</div>}
          {profiles && <div className="site-terrain-3d-list">{(focus ? directions.filter((d) => d.key === focus) : directions).map((d) => {
            const p = profiles.get(d.key)
            const color = colorByKey.get(`id:${d.sectors[0].id}`) ?? UNKNOWN_SECTOR_COLOR
            return (
              <div key={d.key} className={`site-mini-map-legend-row site-terrain-3d-row${focus === d.key ? ' on' : ''}`}
                onClick={() => setFocus(focus === d.key ? null : d.key)} title="Show this direction alone">
                <span className="site-mini-map-legend-chip" style={{ background: color }} />
                <b>{d.az}°</b> ({d.sectors.map((s) => `${sectorName(s)} ${s.tech || '4G'}`).join(', ')};{' '}
                {d.band === 'low' ? 'low' : 'high'} band, {vbw[d.band]}° vertical):{' '}
                {p && coverText(p) && <><b>{coverText(p)}</b>. </>}
                {!p ? 'the ground heights could not be read.'
                  : p.antenna == null ? 'no antenna height on record, so only the ground is shown.'
                    : p.terrainReachM != null
                      ? <>beam centre meets the ground <b>{distanceText(p.terrainReachM)}</b> out
                        {p.flatReachM != null ? <> (flat-ground estimate {distanceText(p.flatReachM)})</> : null}.</>
                      : p.flatReachM == null ? 'no down-tilt on record; the beam does not come down within 6 km.'
                        : `beam centre does not meet the ground within 6 km (flat-ground estimate ${distanceText(p.flatReachM)}).`}
                {p && (
                  <div className="site-mini-map-legend-sub">
                    Site ground {Math.round(p.siteGround)} m{p.antenna != null ? `, antenna ${Math.round(p.antenna)} m` : ''}; highest ground ahead{' '}
                    {Math.round(p.peak.ground)} m at {distanceText(p.peak.d)}.
                  </div>
                )}
                {p && <BeamProfileChart p={p} color={color} />}
              </div>
            )
          })}</div>}
        </div>
      )}
      {showTilt && (
        <div className="site-mini-map-legend">
          {tiltLines.length === 0
            ? 'No sector here has both an antenna height and a tilt above zero, so no reach can be worked out.'
            : 'Dashed lines: where the centre of each beam meets the ground if the ground were flat. On a hill the real distance can be much longer or shorter.'}
          {tiltLines.length > 0 && sectorsWithoutTiltReach > 0 &&
            ` ${sectorsWithoutTiltReach} sector${sectorsWithoutTiltReach === 1 ? ' has' : 's have'} no line (no height, or no tilt).`}
        </div>
      )}
      {showMeasured && (
        <div className="site-mini-map-legend">
          {measured.isLoading && 'Loading the readings…'}
          {measured.isError && 'Could not load the readings.'}
          {measured.data && measured.data.sectors.length === 0 &&
            'No stored reading is matched to this site. That means no drive test or phone reading named one of its cells, not that it has no coverage.'}
          {measured.data && measured.data.sectors.length > 0 && (
            <>
              {/* What the direction figures leave out, said once for all sectors. */}
              {measured.data.sessions.length > 0 && (
                <label className="site-mini-map-legend-pick">
                  Drive test{' '}
                  <select
                    value={measuredSession ?? ''}
                    onChange={(e) => setMeasuredSession(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">All ({measured.data.sessions.length})</option>
                    {measured.data.sessions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.date || 'no date'} · {d.name || `Drive test ${d.id}`} · {d.readings.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div>
                Dots: where a reading served by the sector was taken, one per {measured.data.square_m} m square.
                {measured.data.phone_readings_included ? ' Ringed dots are phone readings.' : ''}
                {measured.data.squares.some((q) => q.uncertain)
                  ? ' Hollow dots may belong to another site that uses the same ID.' : ''}
                {measured.data.truncated ? ' Only the busiest squares are drawn.' : ''}
              </div>
              <div>
                Direction is checked on readings at least {measured.data.direction_rules.beside_site_m} m from the site
                and strong enough to be service. Nothing here changes the stored azimuth or tilt.
              </div>
              {measured.data.sectors.map((s) => {
                const total = s.drive_test_readings + s.phone_readings
                return (
                  <div key={s.key} className="site-mini-map-legend-row">
                    <span
                      className="site-mini-map-legend-chip"
                      style={{ background: colorByKey.get(s.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR }}
                    />
                    <b>{s.sector || s.key}</b>
                    {s.tech ? ` (${s.tech})` : ''}: {total.toLocaleString()} {total === 1 ? 'reading' : 'readings'}
                    {s.p50_km != null && s.p90_km != null &&
                      `, half within ${s.p50_km} km, nine in ten within ${s.p90_km} km`}
                    {s.max_km != null && `, farthest ${s.max_km} km`}
                    {s.direction && (
                      <div className={s.direction.differs ? 'site-mini-map-legend-warn' : 'site-mini-map-legend-sub'}>
                        {s.direction.differs ? '⚠ ' : ''}
                        {s.direction.in_direction_pct}% of {s.direction.readings.toLocaleString()} readings lie where the
                        sector points ({s.azimuth}°)
                        {s.direction.centre_deg != null
                          ? `; they centre on ${s.direction.centre_deg}°, ${s.direction.off_azimuth_deg}° away`
                          : '; they are spread all round the site'}
                        {s.direction.differs ? '. Check the azimuth on site, or whether these readings are this site\'s.' : '.'}
                      </div>
                    )}
                    {s.uncertain_readings > 0 && (
                      <div className="site-mini-map-legend-sub">
                        {s.uncertain_readings.toLocaleString()} readings are uncertain: {s.same_id_sites.join(', ')}{' '}
                        {s.same_id_sites.length === 1 ? 'uses' : 'use'} the same ID.
                      </div>
                    )}
                    {s.antenna_change && (
                      <div className="site-mini-map-legend-sub">
                        An antenna change is on record for this sector
                        {s.antenna_change.period ? ` (${s.antenna_change.period})` : ''}. Readings taken before it show the
                        old direction or tilt.
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
      {hasDivergentSectors && (
        <div className="site-mini-map-note">
          ⚠ {points.length - 1} sector{points.length - 1 === 1 ? '' : 's'} at a different location than the site
        </div>
      )}
    </div>
  )
}
