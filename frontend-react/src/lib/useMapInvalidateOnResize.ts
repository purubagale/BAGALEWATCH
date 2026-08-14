import { useEffect } from 'react'
import { useMap } from 'react-leaflet'

// Leaflet caches its container's pixel size at init and after its own
// pan/zoom operations — it has no way to know the container changed size
// for a reason outside its control (a CSS resize from a drag-resize
// handle, a window resize, a flex sibling collapsing/expanding, etc.), so
// without this the map keeps rendering tiles sized for its old container,
// leaving grey/missing tile bands until the next pan/zoom forces a
// recalculation. A ResizeObserver on the map's own container is the
// general fix — it doesn't need to know *why* the size changed, so it
// covers plain window resizes too, not just the specific trigger that
// motivated adding it.
//
// Shared across every map component in this app (MapView, DtCoverageMap,
// DtExploreTab) since 2026-07-30's drag-to-resize sidebars/panels made
// this a real, reachable bug rather than a theoretical one — call once
// from any component rendered inside a react-leaflet <MapContainer>.
export default function useMapInvalidateOnResize() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [map])
}
