import type { ThresholdMap } from '../api/types'

// snake_case Site/KpiSnapshot field -> v1's camelCase KPI-threshold key
// (bts_monitor.html's th()/kpiSt()/KPI_LABELS, ~line 2981-2982/5239).
// Shared by ScatterPlotPage and KpiTrendPage so both look up KPI status
// against /api/v2/thresholds/ the exact same way — a single source of
// truth instead of two copies that could drift.
export const KPI_THRESHOLD_KEY: Record<string, string> = {
  rrc: 'rrc', erab: 'erab', call_setup: 'callSetup', call_drop: 'callDrop',
  svc_drop: 'svcDrop', intra_ho: 'intraHO', inter_ho: 'interHO', inter_rat: 'interRAT',
  ip_thru: 'ipThru', ip_lat: 'ipLat', prb: 'prb', bearer_util: 'bearerUtil',
  lic_util: 'licUtil', cell_avail: 'cellAvail', rssi: 'rssi', load: 'load',
}

export type KpiStatus = 'ok' | 'warn' | 'crit' | 'nodata'

// Matches v1's kpiSt() exactly (bts_monitor.html ~2981).
export function kpiStatus(v: number | null | undefined, key: string, thresholds: ThresholdMap | undefined): KpiStatus {
  if (v === null || v === undefined || Number.isNaN(v)) return 'nodata'
  const t = thresholds?.[KPI_THRESHOLD_KEY[key] ?? key]
  if (!t || t.warn === null || t.crit === null) return 'ok'
  if (t.hi) return v >= t.warn ? 'ok' : v >= t.crit ? 'warn' : 'crit'
  return v <= t.warn ? 'ok' : v <= t.crit ? 'warn' : 'crit'
}

// Matches v1's kpiClr() exactly (bts_monitor.html ~2982).
export function kpiStatusColor(st: KpiStatus | string): string {
  return st === 'ok' ? '#22c55e' : st === 'warn' ? '#eab308' : st === 'nodata' ? '#5a5a78' : '#ef4444'
}
