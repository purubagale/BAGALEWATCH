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

// A drive-test metric tab read from a phone reading (2026-10-14), so the
// Explore tabs cover telemetry too. The tab names the technology and a
// drive-test field; the phone keeps the same measure under its own name:
//   4G  rsrp, rsrq, sinr, cqi   (no DL throughput from phones)
//   3G  rsrp = RSCP -> rscp, ecno -> ecio
//   2G  rsrp = RxLevel -> rssi, rx_qual -> rxqual
// Null when the reading is on another technology or lacks that measure.
export interface PhoneMetrics extends PhoneLevels {
  rsrq: number | null | undefined
  sinr: number | null | undefined
  cqi: number | null | undefined
  ecio: number | null | undefined
  rxqual: number | null | undefined
}

export function telemetryMetricValue(p: PhoneMetrics, tech: DtTech, key: string): number | null {
  if (techOf(p.network_type) !== tech) return null
  const field: Record<DtTech, Record<string, keyof PhoneMetrics>> = {
    '4G': { rsrp: 'rsrp', rsrq: 'rsrq', sinr: 'sinr', cqi: 'cqi' },
    '3G': { rsrp: 'rscp', ecno: 'ecio' },
    '2G': { rsrp: 'rssi', rx_qual: 'rxqual' },
  }
  const name = field[tech][key]
  const value = name ? p[name] : null
  return typeof value === 'number' ? value : null
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
