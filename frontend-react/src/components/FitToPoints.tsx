import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

/** Zooms and moves the map so every point is in view (2026-10-15; the
 * Collections route opened on its first reading at a fixed zoom, so a longer
 * drive ran off the map). Runs again only when `fitKey` changes, e.g. another
 * session is opened, so readings still arriving do not undo the user's own
 * zoom. One point is shown at `singleZoom`. */
export default function FitToPoints({ points, fitKey, maxZoom = 17, singleZoom = 16 }: {
  points: [number, number][]
  fitKey: string | number
  maxZoom?: number
  singleZoom?: number
}) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    // After layout, so a map that has just appeared knows its size.
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      if (points.length === 1) map.setView(points[0], singleZoom)
      else map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey])
  return null
}
