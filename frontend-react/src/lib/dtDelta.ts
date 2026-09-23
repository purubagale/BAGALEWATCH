// Delta (before/after) comparison color scheme (2026-09-12) — for the
// new DtCompareDeltaMap.tsx "Delta" mode, ADDITIVE to DtCompareMap.tsx's
// existing "Overlay" mode. dtBands.ts's per-metric band arrays color an
// ABSOLUTE reading (e.g. "this RSRP value is good/bad on its own") --
// a delta is a different kind of value entirely (a session-to-session
// CHANGE), so it needs its own diverging red/grey/green scale rather
// than reusing those bands for something they were never designed to
// represent. Kept in its own file rather than folded into dtBands.ts
// since "diverging comparison delta" is a genuinely different concern
// from "absolute-value band lookup," even though both end in a color.
//
// DT_COMPARE_DIRECTION/DT_COMPARE_DEADBAND/DT_COMPARE_DEFAULT_DEADBAND
// below are mirrored EXACTLY from backend-django/core/drive_test.py
// (same names) -- that file is the source of truth for both; if it ever
// changes, update these to match, same convention DT_COMPARE_METRICS's
// own comment there calls out for dtBands.ts's metricsForTech().
import type { DtSample } from '../api/types'

export type DtCompareMetricKey = keyof Pick<DtSample, 'rsrp' | 'rsrq' | 'sinr' | 'ecno' | 'rx_qual' | 'cqi'>

// +1 = "higher is better" (every metric except rx_qual), -1 = "lower is
// better" (GSM RxQual — 0 is a clean read, 7 is the worst).
export const DT_COMPARE_DIRECTION: Partial<Record<DtCompareMetricKey, 1 | -1>> = {
  rx_qual: -1,
}

// Deadband (metric's own unit) below which a delta counts as
// "unchanged" rather than improved/degraded — 2 (dB/dBm) for the
// dB-scale RF metrics, 1 for rx_qual's short 0-7 integer scale and
// cqi's short 0-15 integer scale. No DT_COMPARE_DIRECTION entry needed
// for cqi -- higher is better, same as every metric except rx_qual, and
// directionFor()'s fallback below already defaults to +1.
export const DT_COMPARE_DEADBAND: Partial<Record<DtCompareMetricKey, number>> = {
  rx_qual: 1.0,
  cqi: 1.0,
}
export const DT_COMPARE_DEFAULT_DEADBAND = 2.0

export function directionFor(metricKey: string): 1 | -1 {
  return DT_COMPARE_DIRECTION[metricKey as DtCompareMetricKey] ?? 1
}

export function deadbandFor(metricKey: string): number {
  return DT_COMPARE_DEADBAND[metricKey as DtCompareMetricKey] ?? DT_COMPARE_DEFAULT_DEADBAND
}

export type DeltaStatus = 'improved' | 'degraded' | 'unchanged' | 'no-data'

// Same signed-deadband comparison compare()'s summary percentages use
// server-side (`signed = d * direction`) — kept as its own function so
// deltaColor() and any tooltip/label code agree on the exact same
// improved/degraded/unchanged classification for a given cell.
export function deltaStatus(value: number | null | undefined, deadband: number, direction: 1 | -1 = 1): DeltaStatus {
  if (value == null) return 'no-data'
  const signed = value * direction
  if (signed > deadband) return 'improved'
  if (signed < -deadband) return 'degraded'
  return 'unchanged'
}

// Diverging colors — deliberately distinct from every dtBands.ts band
// color palette so a delta map never reads as "just another absolute
// band map." Grey for "unchanged" reuses bandColor()'s own no-data grey
// tone family (#94a3b8) since both mean "nothing notable here," but a
// lighter grey marks true no-data (one side of the cell has no reading)
// so the two aren't visually confused on the map.
const IMPROVED_COLOR = '#16a34a'
const DEGRADED_COLOR = '#dc2626'
const UNCHANGED_COLOR = '#94a3b8'
const NO_DATA_COLOR = '#e2e8f0'

export function deltaColor(value: number | null | undefined, deadband: number, direction: 1 | -1 = 1): string {
  switch (deltaStatus(value, deadband, direction)) {
    case 'improved':
      return IMPROVED_COLOR
    case 'degraded':
      return DEGRADED_COLOR
    case 'unchanged':
      return UNCHANGED_COLOR
    default:
      return NO_DATA_COLOR
  }
}

export const DELTA_STATUS_LABELS: Record<DeltaStatus, string> = {
  improved: 'Improved',
  degraded: 'Degraded',
  unchanged: 'Unchanged',
  'no-data': 'No data',
}
