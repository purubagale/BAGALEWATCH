import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { useEffect } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { Sector, SiteListItem } from '../api/types'
import { divergentSectorPoints } from '../lib/sectorLocation'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Nepal's rough bounding box — same center/zoom v1 defaults to before any
// site data narrows it down.
const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7
// Street/satellite toggle (2026-08-11, "add feature to toggle between
// satellite view also") — same two tile sources + subdomains override
// DtExploreTab.tsx already uses (Google's hybrid imagery+roads layer;
// `subdomains="0123"` is REQUIRED for it, not cosmetic — see that file's
// own comment on why the tiles 404 as a blank grey map without it).
const STREET_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
// Rough bounding box covering all of Nepal — fallback target when a
// scope has no sites with real coordinates to fit to. Same footprint
// TopologyMap.tsx's own NEPAL_BOUNDS uses.
const NEPAL_BOUNDS = L.latLngBounds([26.3, 80.0], [30.6, 88.3])

// Leaflet's default marker icon references image URLs that Vite doesn't
// bundle correctly out of the box — this is the standard fix.
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
})

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

// Click-to-add-site (2026-07-30 request) — only listens while `active`
// (the page's "+ Add Site" toggle), so a normal map click (panning,
// dismissing a popup, etc.) never accidentally opens the add-site form.
// Plain `map.on('click', ...)`/`map.off` via useMap(), matching every
// other imperative layer in this file, rather than react-leaflet's
// useMapEvent hook — unverified against this project's specific
// react-leaflet v5 install, and the existing pattern is already known to
// work (see ClusteredMarkers' own doc comment on the react-leaflet-
// cluster version mismatch this project already got bitten by once).
function AddSiteClickLayer({ active, onMapClick }: { active: boolean; onMapClick?: (lat: number, lng: number) => void }) {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    container.style.cursor = active ? 'crosshair' : ''
    if (!active || !onMapClick) return
    function handleClick(e: L.LeafletMouseEvent) {
      onMapClick!(e.latlng.lat, e.latlng.lng)
    }
    map.on('click', handleClick)
    return () => {
      map.off('click', handleClick)
      container.style.cursor = ''
    }
  }, [active, onMapClick, map])
  return null
}

// A pulsing gold ring drawn at the selected site's coordinates, on the
// map itself (not inside ClusteredMarkers' cluster group), so it always
// renders regardless of whether that site's own marker is currently
// swallowed into a cluster bubble. `interactive: false` so it never
// steals clicks meant for the real marker/tiles underneath it.
const selectedIcon = L.divIcon({
  className: 'selected-site-marker',
  html: '<span class="selected-site-marker-ring"></span><span class="selected-site-marker-dot"></span>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
})

function SelectedHighlight({ site }: { site: SiteListItem | undefined }) {
  const map = useMap()
  useEffect(() => {
    if (site?.lat == null || site?.lng == null) return
    const marker = L.marker([site.lat, site.lng], { icon: selectedIcon, interactive: false, zIndexOffset: 1000 })
    marker.addTo(map)
    return () => {
      map.removeLayer(marker)
    }
  }, [site, map])
  return null
}

// Small purple dot for a sector whose own GPS override genuinely differs
// from its site's location — same color/shape convention
// SiteLocationMiniMap.tsx uses on the Site Detail page, so a sector
// looks the same whether you're spotting it here or there.
const sectorPinIcon = L.divIcon({
  className: 'site-mini-map-dot-marker',
  html: '<span class="site-mini-map-dot" style="width:13px;height:13px;background:#a855f7;"></span>',
  iconSize: [13, 13],
  iconAnchor: [6, 6],
})

// Plots each of the selected site's sectors that sit at a genuinely
// different GPS point than the site itself (2026-08-09, "sometimes same
// sites with multiple sectors may have different lat long location as
// sector expansion. manage this condition also in the system"). Only
// wired up for the currently SELECTED site, not every site on the map —
// the bulk sites/map endpoint (SiteListItem[]) deliberately excludes
// sector data for ~4,700 sites' worth of payload/performance reasons
// (see SiteListSerializer's docstring); SitesPage.tsx fetches the one
// selected site's full detail (with sectors) separately, same pattern
// SiteDetailPage.tsx already uses, and passes it down here.
function SelectedSectorPins({ site, sectors }: { site: SiteListItem | undefined; sectors: Sector[] }) {
  const map = useMap()
  useEffect(() => {
    if (site?.lat == null || site?.lng == null || !sectors.length) return
    const points = divergentSectorPoints(site.lat, site.lng, sectors)
    if (!points.length) return
    const layer = L.layerGroup()
    for (const p of points) {
      L.marker([p.lat, p.lng], { icon: sectorPinIcon, interactive: true, zIndexOffset: 900 })
        .bindTooltip(p.label)
        .addTo(layer)
    }
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [site, sectors, map])
  return null
}

// Re-fits the viewport whenever the map's SCOPE changes (2026-08-05 fix)
// — the "All Nepal / province / district / single-site" scope filtering
// added the same day only ever changed which markers `ClusteredMarkers`
// draws; nothing ever moved the viewport to actually frame them, so
// picking a new province/district updated the "Showing: X" status line
// and the marker set but left the map staring at wherever it happened to
// be pointed before, looking exactly like nothing happened until the
// user manually panned/zoomed to find the new sites. Mirrors
// TopologyMap.tsx's own `FitToScope` component: keyed on `scopeKey`
// (not `sites` itself, and not `selected`) so it only fires on a real
// scope change — re-selecting a site within the same scope, or an
// unrelated parent re-render, must not fight the user's own pan/zoom by
// refitting on every render.
function FitToScope({ sites, scopeKey }: { sites: SiteListItem[]; scopeKey: string }) {
  const map = useMap()
  useEffect(() => {
    const withCoords = sites.filter((s) => s.lat != null && s.lng != null)
    if (!withCoords.length) {
      map.fitBounds(NEPAL_BOUNDS, { animate: false })
      return
    }
    const bounds = L.latLngBounds(withCoords.map((s) => [s.lat as number, s.lng as number] as [number, number]))
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15, animate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, map])
  return null
}

function FlyToSelected({ site }: { site: SiteListItem | undefined }) {
  const map = useMap()
  useEffect(() => {
    if (site?.lat && site?.lng) {
      // Zoom target raised from 13 to 15 (2026-07-30) — 13 is BELOW
      // ClusteredMarkers' disableClusteringAtZoom: 14, so a "selected"
      // site could still be sitting inside an unopened cluster bubble at
      // that zoom, with nothing individually visible to highlight at
      // all. 15 guarantees the map has actually zoomed past the
      // clustering threshold before SelectedHighlight's ring has
      // anything real to point at.
      map.flyTo([site.lat, site.lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
    }
  }, [site, map])
  return null
}

/** Clustering built directly against `leaflet.markercluster` (the same
 * engine v1 already uses) via react-leaflet's `useMap()` hook, rather
 * than a React wrapper component. `react-leaflet-cluster@2.1.0` declares
 * a peer dependency on `react-leaflet@^4`, but this project is on `^5` —
 * it installed without a version-conflict error (before `.npmrc`'s
 * `legacy-peer-deps` was even relevant) but rendered as `undefined` at
 * runtime (React error #130, found 2026-07-27) because its internals no
 * longer match v5's API. Imperative Leaflet layers sidestep the
 * incompatibility entirely — same `disableClusteringAtZoom`/chunked-load
 * tuning v1 already relies on for ~4,700 sites (see CLAUDE.md's
 * "MarkerCluster" decision), just built by hand instead of through an
 * unmaintained wrapper. */
function ClusteredMarkers({
  sites,
  onSelect,
  canRelocate,
  onRelocateRequest,
}: {
  sites: SiteListItem[]
  onSelect: (id: string) => void
  canRelocate: boolean
  onRelocateRequest?: (site: SiteListItem, oldLat: number, oldLng: number, newLat: number, newLng: number) => void
}) {
  const map = useMap()

  useEffect(() => {
    const cluster = (L as unknown as { markerClusterGroup: (opts: object) => L.LayerGroup }).markerClusterGroup({
      chunkedLoading: true,
      disableClusteringAtZoom: 14,
    })
    const withCoords = sites.filter((s) => s.lat != null && s.lng != null)
    for (const s of withCoords) {
      const marker = L.marker([s.lat as number, s.lng as number], { icon: defaultIcon, draggable: canRelocate })
      marker.bindTooltip(s.name || s.id)
      marker.on('click', () => onSelect(s.id))
      if (canRelocate && onRelocateRequest) {
        // Drag-to-relocate, confirm-before-save (2026-07-30, confirmed
        // via AskUserQuestion). Snap back to the original position
        // immediately on drop — the marker only actually moves once the
        // parent's confirm modal saves successfully, at which point
        // useRelocateSite's cache invalidation refetches `sites` and this
        // effect re-runs, rebuilding the marker at the new real position.
        // No separate "revert" callback needed: since nothing here is
        // ever left in the dragged position, there's nothing to undo on
        // Cancel beyond what already happened synchronously below.
        marker.on('dragend', () => {
          const dropped = marker.getLatLng()
          const oldLat = s.lat as number
          const oldLng = s.lng as number
          marker.setLatLng([oldLat, oldLng])
          onRelocateRequest(s, oldLat, oldLng, dropped.lat, dropped.lng)
        })
      }
      cluster.addLayer(marker)
    }
    map.addLayer(cluster)
    return () => {
      map.removeLayer(cluster)
    }
  }, [sites, map, onSelect, canRelocate, onRelocateRequest])

  return null
}

export default function MapView({
  sites,
  scopeKey,
  selected,
  selectedSectors,
  onSelect,
  addMode = false,
  onMapClick,
  canRelocate = false,
  onRelocateRequest,
  mapLayer = 'street',
}: {
  sites: SiteListItem[]
  /** Stable identity for the current scope ('all' | 'prov-X' | 'dist-X-Y'
   * | 'site-X') — drives FitToScope below. A *new* scope should re-fit
   * the view; re-rendering with the same scope (e.g. selecting a site
   * within it) must not, or every click would fight the user's own pan/
   * zoom. Optional only so existing callers that don't pass it yet don't
   * break; without it the map simply never auto-refits (previous
   * behavior), so any page filtering `sites` by scope should pass this. */
  scopeKey?: string
  selected: SiteListItem | undefined
  /** Optional — the selected site's own sectors (with their optional GPS
   * override), so SelectedSectorPins can plot any that diverge from the
   * site's location. Omitted entirely = no sector pins, same as before
   * this existed; SitesPage.tsx fetches this via useSite() only for
   * whichever one site is currently selected. */
  selectedSectors?: Sector[]
  onSelect: (id: string) => void
  /** Page's "+ Add Site" toggle — while true, the next map click reports
   * its lat/lng via onMapClick instead of doing nothing. */
  addMode?: boolean
  onMapClick?: (lat: number, lng: number) => void
  /** Gated by the page on canUpdate (isAllowed(..., 'sites', 'update')) —
   * markers are only draggable at all when this is true. */
  canRelocate?: boolean
  onRelocateRequest?: (site: SiteListItem, oldLat: number, oldLng: number, newLat: number, newLng: number) => void
  /** Street/satellite basemap (2026-08-11) — owned by the page (same as
   * every other map toolbar toggle here, e.g. addMode) rather than this
   * component's own local state, so the toggle button itself can live in
   * SitesPage.tsx's toolbar alongside "+ Add Site" instead of this
   * component needing to render its own floating UI. Defaults to
   * 'street' so every existing/future caller that doesn't pass this still
   * renders exactly as before. */
  mapLayer?: 'street' | 'satellite'
}) {
  return (
    // `key={mapLayer}` forces a full MapContainer remount on toggle,
    // same approach DtExploreTab.tsx already uses for its own street/
    // satellite switch — swapping just the TileLayer's `url` prop in
    // place hasn't been verified to reliably clear the old tile source's
    // cached tiles on this project's react-leaflet version, so this
    // sidesteps that entirely rather than risk a mixed-tile render.
    <MapContainer key={mapLayer} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="site-map" preferCanvas>
      <TileLayer
        attribution={mapLayer === 'street' ? '&copy; OpenStreetMap contributors' : '&copy; Google'}
        url={mapLayer === 'street' ? STREET_URL : SATELLITE_URL}
        subdomains={mapLayer === 'street' ? 'abc' : '0123'}
        maxZoom={20}
      />
      <ClusteredMarkers sites={sites} onSelect={onSelect} canRelocate={canRelocate} onRelocateRequest={onRelocateRequest} />
      {scopeKey && <FitToScope sites={sites} scopeKey={scopeKey} />}
      <SelectedHighlight site={selected} />
      <SelectedSectorPins site={selected} sectors={selectedSectors ?? []} />
      <FlyToSelected site={selected} />
      <AddSiteClickLayer active={addMode} onMapClick={onMapClick} />
      <InvalidateOnResize />
    </MapContainer>
  )
}
