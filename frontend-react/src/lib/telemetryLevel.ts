import { RSRP_BANDS, RXLEV_BANDS, bandColor, type Band } from './dtBands'
import type { DtTech } from '../api/types'

// Signal level of one phone reading, whatever technology the phone was on
// (2026-10-12). A phone drive is rarely on one technology from start to
// end: it drops to 3G or 2G and comes back. Each technology reports its
// level under a different name, and until this helper the telemetry plots
// read RSRP only, so every 3G and 2G reading was drawn as "no data".
//
//   4G / 5G  RSRP             RSRP scale
//   3G       RSCP             same scale as RSRP
//   2G       RSSI (RxLevel)   the separate RxLevel scale
//
// The same choice the mobile app makes for its own route colours.

export interface PhoneLevels {
  network_type: string
  rsrp: number | null | undefined
  rscp: number | null | undefined
  rssi: number | null | undefined
}

export interface TelemetryLevel {
  /** The technology as the DT pages name it, or null when the phone had no service. */
  tech: DtTech | null
  /** RSRP, RSCP or RxLev: what the number is. */
  name: string
  value: number | null
  bands: Band[]
  color: string
}

export function techOf(networkType: string): DtTech | null {
  if (networkType === 'LTE' || networkType === 'NR') return '4G'
  if (networkType === 'UMTS') return '3G'
  if (networkType === 'GSM') return '2G'
  return null
}

export function telemetryLevel(p: PhoneLevels): TelemetryLevel {
  const tech = techOf(p.network_type)
  const [name, value, bands]: [string, number | null, Band[]] =
    tech === '3G'
      ? ['RSCP', p.rscp ?? null, RSRP_BANDS]
      : tech === '2G'
        ? ['RxLev', p.rssi ?? null, RXLEV_BANDS]
        : ['RSRP', p.rsrp ?? null, RSRP_BANDS]
  return { tech, name, value, bands, color: bandColor(bands, value) }
}
