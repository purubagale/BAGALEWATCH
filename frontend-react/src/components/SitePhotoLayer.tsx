import { useEffect, useMemo, useState } from 'react'
import { Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { useSitePhotoPoints } from '../api/queries'
import type { SitePhoto } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { PhotoImage, compassPoint } from './SitePhotoCard'

// Approved site photos as a map layer (2026-10-12). Put it inside any
// <MapContainer>: it shows a small camera marker with an arrow for the
// direction the phone faced, and a popup with the picture. Photos are for
// admins and superadmins, so for anyone else this draws nothing and asks
// the server nothing.
//
// With `driveSessionId` it shows the photos of that one phone drive test.
// Without it, it shows the photos inside the area the map currently shows
// and asks again when the map is moved.

type Box = { min_lat: number; max_lat: number; min_lng: number; max_lng: number }

function boxOf(map: L.Map): Box {
  const b = map.getBounds()
  // Rounded so a tiny pan does not make a new request.
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { min_lat: r(b.getSouth()), max_lat: r(b.getNorth()), min_lng: r(b.getWest()), max_lng: r(b.getEast()) }
}

function photoIcon(bearing: number): L.DivIcon {
  // The arrow is drawn pointing up (north) and turned to the bearing.
  return L.divIcon({
    className: 'site-photo-marker',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html:
      `<div class="site-photo-marker-arrow" style="transform:rotate(${Math.round(bearing)}deg)">` +
      '<svg viewBox="0 0 34 34" width="34" height="34"><path d="M17 1 L24 13 L10 13 Z" /></svg></div>' +
      '<div class="site-photo-marker-dot">📷</div>',
  })
}

function PhotoPopup({ photo }: { photo: SitePhoto }) {
  const diff = photo.azimuth_difference
  return (
    <div className="site-photo-popup">
      <PhotoImage id={photo.id} alt={`Photo facing ${Math.round(photo.bearing_deg)}°`} />
      <div className="site-photo-bearing">
        Facing {Math.round(photo.bearing_deg)}° {compassPoint(photo.bearing_deg)}
      </div>
      {photo.site_id && (
        <div>
          {photo.site_id}
          {photo.planned_azimuth != null ? ` · planned ${Math.round(photo.planned_azimuth)}° · difference ${diff}°` : ''}
        </div>
      )}
      <div className="muted">{new Date(photo.taken_at).toLocaleString()}</div>
      {photo.signal.rsrp != null && <div className="muted">RSRP {photo.signal.rsrp} dBm</div>}
      {photo.note && <div className="site-photo-note">{photo.note}</div>}
    </div>
  )
}

export default function SitePhotoLayer({ driveSessionId }: { driveSessionId?: string | null }) {
  const { user } = useAuth()
  const allowed = !!user && (user.role === 'admin' || user.role === 'superadmin')
  const map = useMap()
  const [box, setBox] = useState<Box | null>(null)

  useEffect(() => {
    if (allowed && !driveSessionId) setBox(boxOf(map))
  }, [allowed, driveSessionId, map])
  useMapEvents({
    moveend: () => {
      if (allowed && !driveSessionId) setBox(boxOf(map))
    },
  })

  const { data } = useSitePhotoPoints(
    driveSessionId ? { drive_session_id: driveSessionId } : (box ?? {}),
    allowed && (!!driveSessionId || box != null),
  )
  const photos = useMemo(() => data?.photos ?? [], [data])

  if (!allowed) return null
  return (
    <>
      {photos.map((photo) => (
        <Marker key={photo.id} position={[photo.lat, photo.lng]} icon={photoIcon(photo.bearing_deg)}>
          <Popup minWidth={240} maxWidth={280}>
            <PhotoPopup photo={photo} />
          </Popup>
        </Marker>
      ))}
    </>
  )
}
