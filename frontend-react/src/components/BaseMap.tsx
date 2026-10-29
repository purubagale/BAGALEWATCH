import { useEffect, useState } from 'react'
import { TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { leafletLayer } from 'protomaps-leaflet'

// The street map under every Leaflet map (2026-10-29, option A): NTC's own
// Nepal map file, OpenStreetMap data cut by Protomaps and served by our own
// nginx at /maps/nepal.pmtiles, drawn sharp at any zoom in the browser. No
// key, no outside service: the only condition is the OpenStreetMap credit.
// Until the file is on the server (or outside Nepal, where it has nothing),
// the public OpenStreetMap tiles are used as before.

export const NEPAL_MAP_URL = '/maps/nepal.pmtiles'
const ATTRIBUTION = '&copy; OpenStreetMap contributors · Protomaps'
const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

let available: Promise<boolean> | null = null
/** Asked once per page load: is the Nepal map file on this server? */
export function nepalMapAvailable(): Promise<boolean> {
  if (!available) {
    available = fetch(NEPAL_MAP_URL, { method: 'HEAD' })
      .then((r) => r.ok && (r.headers.get('content-type') ?? '').indexOf('text/html') === -1)
      .catch(() => false)
  }
  return available
}

export default function BaseMap() {
  const map = useMap()
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    nepalMapAvailable().then((v) => { if (alive) setOk(v) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!ok) return
    const layer = leafletLayer({
      url: NEPAL_MAP_URL, flavor: 'light', lang: 'en', attribution: ATTRIBUTION,
      // The file holds detail up to zoom 14; closer in, that detail is enlarged.
      maxDataZoom: 14,
    } as Parameters<typeof leafletLayer>[0]) as unknown as L.GridLayer
    layer.addTo(map)
    layer.bringToBack()
    return () => { map.removeLayer(layer) }
  }, [ok, map])
  if (ok === false) return <TileLayer attribution="&copy; OpenStreetMap contributors" url={OSM_URL} />
  return null
}
