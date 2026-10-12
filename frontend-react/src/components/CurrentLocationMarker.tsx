import { useEffect, useState } from 'react'
import { Circle, CircleMarker, Tooltip, useMap } from 'react-leaflet'

// The viewer's own position on a map (2026-10-12). Put it inside any
// <MapContainer>. The browser asks for location permission the first time;
// if the answer is no, or the device has no position, nothing is drawn and
// the map works as before. The position stays in the browser: it is not
// sent to the server.
//
// `centerOnce` moves the map to the position the first time it is known.
// Leave it off on maps that frame their own data.

type Fix = { lat: number; lng: number; accuracy: number }

export default function CurrentLocationMarker({ centerOnce = false }: { centerOnce?: boolean }) {
  const map = useMap()
  const [fix, setFix] = useState<Fix | null>(null)
  const [centered, setCentered] = useState(false)

  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      // Denied, switched off or timed out: show the map with no position.
      () => setFix(null),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  useEffect(() => {
    if (centerOnce && fix && !centered) {
      map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 14), { animate: false })
      setCentered(true)
    }
  }, [centerOnce, fix, centered, map])

  if (!fix) return null
  return (
    <>
      {fix.accuracy > 15 && (
        <Circle
          center={[fix.lat, fix.lng]}
          radius={fix.accuracy}
          interactive={false}
          pathOptions={{ color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.08 }}
        />
      )}
      <CircleMarker
        center={[fix.lat, fix.lng]}
        radius={7}
        pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }}
      >
        <Tooltip>Your position (±{Math.round(fix.accuracy)} m)</Tooltip>
      </CircleMarker>
    </>
  )
}
