import { CircleMarker, Tooltip } from 'react-leaflet'
import type { TelemetryNearPoint } from '../api/types'
import { telemetryLevel } from '../lib/telemetryLevel'

// Telemetry readings on the Explore map (2026-10-12): the samples of the
// phone drives and Telemetry Drive Test sessions found around the search
// point, drawn only when "Include telemetry sessions" is ticked. Coloured
// by signal level on the shared scales, using the level of whatever
// technology the phone was on at that reading (lib/telemetryLevel.ts). A
// white ring sets them apart from the uploaded drive-test samples, which
// have none.

export default function TelemetryNearLayer({
  points,
  names,
}: {
  points: TelemetryNearPoint[]
  names: Record<string, string>
}) {
  return (
    <>
      {points.map((p, i) => {
        const level = telemetryLevel(p)
        return (
          <CircleMarker
            key={`${p.session}-${i}`}
            center={[p.lat, p.lng]}
            radius={5}
            pathOptions={{ color: '#ffffff', weight: 1.5, fillColor: level.color, fillOpacity: 0.95 }}
          >
            <Tooltip>
              {names[p.session] ?? 'Telemetry'} · {level.tech ?? p.network_type}
              {level.value != null ? ` · ${level.name} ${level.value} dBm` : ' · no level'}
              {level.tech === '4G' && p.rsrq != null ? ` · RSRQ ${p.rsrq} dB` : ''}
              {level.tech === '4G' && p.sinr != null ? ` · SINR ${p.sinr} dB` : ''}
              {level.tech === '4G' && p.cqi != null ? ` · CQI ${p.cqi}` : ''}
              {level.tech === '3G' && p.ecio != null ? ` · Ec/Io ${p.ecio} dB` : ''}
              {level.tech === '2G' && p.rxqual != null ? ` · RxQual ${p.rxqual}` : ''}
              {` · ${new Date(p.ts).toLocaleString()}`}
            </Tooltip>
          </CircleMarker>
        )
      })}
    </>
  )
}
