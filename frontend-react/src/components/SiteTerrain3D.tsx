import { useEffect, useRef, useState } from 'react'
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { TERRAIN_TILES } from '../lib/terrainProfile'

// 3D terrain view of one site (2026-10-28, "build 3d terrain view on the
// site page"). The same satellite imagery as the flat map, laid over ground
// heights from the public Terrain Tiles, tilted so a hill in front of a
// sector shows. Wedges, tilt lines and measured readings are draped on the
// ground; a ringed dot marks where each beam centre meets the real terrain.
// Loaded only when "3D terrain" is ticked (React.lazy), so the map library
// is not part of any other page's download. DT Explore uses it too
// (2026-10-28): its search area, sites and dots, with the same turn, tilt
// and height controls.

setWorkerUrl(workerUrl)

// Plain imagery by default (2026-10-28): the hybrid layer's shop and hotel
// pins looked like more readings. 'names' adds roads and place names back.
const satelliteTiles = (names: boolean) =>
  ['0', '1', '2', '3'].map((s) => `https://mt${s}.google.com/vt/lyrs=${names ? 'y' : 's'}&x={x}&y={y}&z={z}`)

export interface Terrain3DPoint { lat: number; lng: number; color: string; label: string }
export interface Terrain3DData {
  sites: (Terrain3DPoint & { size: number })[]
  wedges: { positions: [number, number][]; color: string; label: string }[]
  lines: { from: [number, number]; to: [number, number]; color: string; label: string }[]
  /** One solid line per antenna direction, from the site to where its beam lands. */
  beams: { from: [number, number]; to: [number, number]; color: string; label: string; landed: boolean }[]
  /** Stretches along each beam line: strong (thick), shadow behind a hill (grey). */
  segments: { from: [number, number]; to: [number, number]; color: string; label: string; cover: 'strong' | 'weak' | 'shadow' }[]
  /** Ground across one chosen sector: lit by the beam, or hidden behind a hill. */
  cells: { positions: [number, number][]; color: string; label: string; cover: 'strong' | 'shadow' }[]
  /** Short text on the map, e.g. "40° → 3.3 km". */
  labels: (Terrain3DPoint & { text: string })[]
  squares: (Terrain3DPoint & { hollow: boolean; ring: boolean })[]
  reach: Terrain3DPoint[]
  corners: [number, number][]
  /** DT Explore: the searched area's outline, and the sites in it as small dots. */
  area?: [number, number][]
  sitePoints?: Terrain3DPoint[]
}

type Fc = GeoJSON.FeatureCollection
const ll = (p: [number, number]): [number, number] => [p[1], p[0]]

function collections(d: Terrain3DData): Record<string, Fc> {
  const fc = (features: GeoJSON.Feature[]): Fc => ({ type: 'FeatureCollection', features })
  return {
    wedges: fc(d.wedges.map((w) => ({
      type: 'Feature', properties: { color: w.color, label: w.label },
      geometry: { type: 'Polygon', coordinates: [[...w.positions.map(ll), ll(w.positions[0])]] },
    }))),
    lines: fc(d.lines.map((l) => ({
      type: 'Feature', properties: { color: l.color, label: l.label },
      geometry: { type: 'LineString', coordinates: [ll(l.from), ll(l.to)] },
    }))),
    squares: fc(d.squares.map((q) => ({
      type: 'Feature', properties: { color: q.color, label: q.label, hollow: q.hollow ? 1 : 0, ring: q.ring ? 1 : 0 },
      geometry: { type: 'Point', coordinates: [q.lng, q.lat] },
    }))),
    beams: fc(d.beams.map((l) => ({
      type: 'Feature', properties: { color: l.color, label: l.label, landed: l.landed ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: [ll(l.from), ll(l.to)] },
    }))),
    segments: fc(d.segments.map((l) => ({
      type: 'Feature', properties: { color: l.color, label: l.label, cover: l.cover },
      geometry: { type: 'LineString', coordinates: [ll(l.from), ll(l.to)] },
    }))),
    cells: fc(d.cells.map((c) => ({
      type: 'Feature', properties: { color: c.color, label: c.label, cover: c.cover },
      geometry: { type: 'Polygon', coordinates: [[...c.positions.map(ll), ll(c.positions[0])]] },
    }))),
    area: fc(d.area && d.area.length > 2 ? [{
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[...d.area.map(ll), ll(d.area[0])]] },
    }] : []),
    sitePoints: fc((d.sitePoints ?? []).map((r) => ({
      type: 'Feature', properties: { color: r.color, label: r.label },
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    }))),
    reach: fc(d.reach.map((r) => ({
      type: 'Feature', properties: { color: r.color, label: r.label },
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    }))),
  }
}

const EXAGGERATIONS = [1, 1.5, 2, 3]

export default function SiteTerrain3D({ center, data, names = false }: { center: [number, number]; data: Terrain3DData; names?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const markersRef = useRef<Marker[]>([])
  const [ready, setReady] = useState(false)
  const [exaggeration, setExaggeration] = useState(1)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!boxRef.current) return
    let map: MlMap
    try {
      map = new MlMap({
        container: boxRef.current,
        center: ll(center),
        zoom: 15,
        pitch: 60,
        maxPitch: 85,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            satellite: { type: 'raster', tiles: satelliteTiles(names), tileSize: 256, maxzoom: 20, attribution: '© Google' },
            dem: {
              type: 'raster-dem', tiles: [TERRAIN_TILES], tileSize: 256, maxzoom: 15, encoding: 'terrarium',
              attribution: 'Terrain Tiles (AWS Open Data)',
            },
          },
          layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
          terrain: { source: 'dem', exaggeration: 1 },
          sky: {},
        },
      })
    } catch {
      setFailed(true)
      return
    }
    mapRef.current = map
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')
    map.on('load', () => {
      const empty: Fc = { type: 'FeatureCollection', features: [] }
      for (const id of ['area', 'cells', 'wedges', 'lines', 'beams', 'segments', 'squares', 'sitePoints', 'reach']) map.addSource(id, { type: 'geojson', data: empty })
      map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#7f77dd', 'fill-opacity': 0.06 } })
      map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#7f77dd', 'line-width': 2 } })
      map.addLayer({
        id: 'cells-strong', type: 'fill', source: 'cells', filter: ['==', ['get', 'cover'], 'strong'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.38 },
      })
      map.addLayer({
        id: 'cells-shadow', type: 'fill', source: 'cells', filter: ['==', ['get', 'cover'], 'shadow'],
        paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.5 },
      })
      map.addLayer({ id: 'wedges-fill', type: 'fill', source: 'wedges', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 } })
      map.addLayer({ id: 'wedges-line', type: 'line', source: 'wedges', paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 } })
      map.addLayer({
        id: 'lines', type: 'line', source: 'lines',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [2, 2] },
      })
      map.addLayer({
        id: 'beams-halo', type: 'line', source: 'beams',
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': ['case', ['==', ['get', 'landed'], 1], 0.8, 0.35] },
      })
      map.addLayer({
        id: 'beams', type: 'line', source: 'beams',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': ['case', ['==', ['get', 'landed'], 1], 1, 0.45] },
      })
      map.addLayer({
        id: 'seg-strong', type: 'line', source: 'segments', filter: ['==', ['get', 'cover'], 'strong'],
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 9, 'line-opacity': 0.8 },
      })
      map.addLayer({
        id: 'seg-shadow', type: 'line', source: 'segments', filter: ['==', ['get', 'cover'], 'shadow'],
        paint: { 'line-color': '#1e293b', 'line-width': 5, 'line-opacity': 0.85, 'line-dasharray': [1, 1] },
      })
      map.addLayer({
        id: 'squares', type: 'circle', source: 'squares',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'ring'], 1], 4, 3],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['==', ['get', 'hollow'], 1], 0, 0.85],
          'circle-stroke-color': ['case', ['==', ['get', 'ring'], 1], '#ffffff', ['get', 'color']],
          'circle-stroke-width': ['case', ['any', ['==', ['get', 'hollow'], 1], ['==', ['get', 'ring'], 1]], 1.5, 0],
        },
      })
      map.addLayer({
        id: 'sitePoints', type: 'circle', source: 'sitePoints',
        paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#e6e9ef', 'circle-stroke-width': 2 },
      })
      map.addLayer({
        id: 'reach', type: 'circle', source: 'reach',
        paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
      })
      const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8 })
      for (const layer of ['cells-strong', 'cells-shadow', 'wedges-fill', 'lines', 'seg-strong', 'seg-shadow', 'beams', 'squares', 'sitePoints', 'reach']) {
        map.on('mousemove', layer, (e: MapLayerMouseEvent) => {
          const label = e.features?.[0]?.properties?.label
          if (!label) return
          map.getCanvas().style.cursor = 'pointer'
          popup.setLngLat(e.lngLat).setText(String(label)).addTo(map)
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
          popup.remove()
        })
      }
      setReady(true)
    })
    map.on('error', (e) => console.warn('3D map:', e.error?.message ?? e))
    const resize = new ResizeObserver(() => map.resize())
    resize.observe(boxRef.current)
    return () => {
      resize.disconnect()
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
    // The map is made once; the data effects below keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const [id, fc] of Object.entries(collections(data))) (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc)
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = data.sites.map((s) => {
      const el = document.createElement('span')
      el.className = 'site-mini-map-dot'
      el.style.cssText = `display:block;width:${s.size}px;height:${s.size}px;background:${s.color};`
      el.title = s.label
      return new Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map)
    }).concat(data.labels.map((t) => {
      const el = document.createElement('span')
      el.className = 'site-terrain-3d-label'
      el.style.borderColor = t.color
      el.textContent = t.text
      el.title = t.label
      return new Marker({ element: el, anchor: 'bottom', offset: [0, -8] }).setLngLat([t.lng, t.lat]).addTo(map)
    }))
  }, [data, ready])

  useEffect(() => {
    const src = mapRef.current?.getSource('satellite') as { setTiles?: (t: string[]) => void } | undefined
    if (ready) src?.setTiles?.(satelliteTiles(names))
  }, [names, ready])

  // Fit once the map is ready and when what is drawn changes size.
  const fitKey = `${data.corners.length}|${center[0]},${center[1]}`
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (data.corners.length > 1) {
      const b = new LngLatBounds()
      data.corners.forEach((c) => b.extend(ll(c)))
      map.fitBounds(b, { padding: 60, maxZoom: 17, pitch: 60, bearing: map.getBearing(), duration: 0 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready])

  useEffect(() => {
    if (ready) mapRef.current?.setTerrain({ source: 'dem', exaggeration })
  }, [exaggeration, ready])

  // Turn and tilt by buttons (2026-10-28): a touchpad has no right button,
  // and not everyone finds Ctrl+drag.
  const turn = (deg: number) => mapRef.current?.easeTo({ bearing: (mapRef.current.getBearing() + deg) % 360, duration: 400 })
  const tilt = (deg: number) => {
    const m = mapRef.current
    if (m) m.easeTo({ pitch: Math.max(0, Math.min(85, m.getPitch() + deg)), duration: 400 })
  }
  const reset = () => mapRef.current?.easeTo({ bearing: 0, pitch: 60, duration: 400 })

  if (failed) {
    return <div className="site-mini-map-empty">This browser cannot draw the 3D map (WebGL is off or not available).</div>
  }
  return (
    <div className="site-terrain-3d">
      <div ref={boxRef} className="site-terrain-3d-map" />
      <label className="site-terrain-3d-exag" title="How much the ground heights are stretched. ×1 is true scale.">
        Height{' '}
        <select value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))}>
          {EXAGGERATIONS.map((x) => <option key={x} value={x}>×{x}{x === 1 ? ' (true)' : ''}</option>)}
        </select>
      </label>
      <div className="site-terrain-3d-turn" role="group" aria-label="Turn and tilt the map">
        <button type="button" onClick={() => turn(-45)} title="Turn left">⟲</button>
        <button type="button" onClick={() => turn(45)} title="Turn right">⟳</button>
        <button type="button" onClick={() => tilt(15)} title="Tilt more (look along the ground)">◢</button>
        <button type="button" onClick={() => tilt(-15)} title="Tilt less (look down)">◣</button>
        <button type="button" onClick={reset} title="North up, standard tilt">N</button>
      </div>
      <div className="site-terrain-3d-hint">Or right-drag / Ctrl+drag to turn and tilt</div>
    </div>
  )
}
