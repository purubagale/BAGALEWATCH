// Coverage-band color tables for the Drive-Test Data Manager's map — ported
// field-for-field from bts_monitor.html (~6144-6272: rsrpDotColor,
// RSRP_BANDS, RXLEV_BANDS, RSRQ_BANDS, SINR_BANDS, ECIO_BANDS,
// RXQUAL_BANDS, _dtMetricsForTech). Deliberately verbatim, not
// re-derived — these breakpoints were verified against real reference
// TEMS-style route plots (see the RSRQ_BANDS comment in v1: "each band's
// point count sums to the source file's total sample count of 3797").
import type { DtSample, DtTech } from '../api/types'

export interface Band {
  label: string
  min: number
  max: number
  color: string
}

export const RSRP_BANDS: Band[] = [
  { label: '< -105', min: -999, max: -105, color: '#dc2626' },
  { label: '-105 to -95', min: -105, max: -95, color: '#f97316' },
  { label: '-95 to -87', min: -95, max: -87, color: '#eab308' },
  { label: '-87 to -77', min: -87, max: -77, color: '#84cc16' },
  { label: '> -77', min: -77, max: 0, color: '#16a34a' },
]

// 2G RxLevel uses different breakpoints than 4G RSRP / 3G RSCP, even
// though it shares the same 5-color red→green palette — GSM RxLev is
// conventionally banded at -105/-92/-82/-72, not -105/-95/-87/-77.
export const RXLEV_BANDS: Band[] = [
  { label: '< -105', min: -999, max: -105, color: '#dc2626' },
  { label: '-105 to -92', min: -105, max: -92, color: '#f97316' },
  { label: '-92 to -82', min: -92, max: -82, color: '#eab308' },
  { label: '-82 to -72', min: -82, max: -72, color: '#84cc16' },
  { label: '> -72', min: -72, max: 999, color: '#16a34a' },
]

export const RSRQ_BANDS: Band[] = [
  { label: '< -20', min: -999, max: -20, color: '#dc2626' },
  { label: '-20 to -17', min: -20, max: -17, color: '#f97316' },
  { label: '-17 to -15', min: -17, max: -15, color: '#eab308' },
  { label: '-15 to -13', min: -15, max: -13, color: '#2563eb' },
  { label: '-13 to -10', min: -13, max: -10, color: '#22d3ee' },
  { label: '-10 to -3', min: -10, max: -3, color: '#84cc16' },
  { label: '>= -3', min: -3, max: 999, color: '#16a34a' },
]

export const SINR_BANDS: Band[] = [
  { label: '< -5', min: -999, max: -5, color: '#dc2626' },
  { label: '-5 to 0', min: -5, max: 0, color: '#f97316' },
  { label: '0 to 5', min: 0, max: 5, color: '#eab308' },
  { label: '5 to 10', min: 5, max: 10, color: '#2563eb' },
  { label: '10 to 15', min: 10, max: 15, color: '#22d3ee' },
  { label: '15 to 20', min: 15, max: 20, color: '#84cc16' },
  { label: '>= 20', min: 20, max: 999, color: '#16a34a' },
]

export const ECIO_BANDS: Band[] = [
  { label: '< -18', min: -999, max: -18, color: '#94a3b8' },
  { label: '-18 to -15', min: -18, max: -15, color: '#dc2626' },
  { label: '-15 to -13', min: -15, max: -13, color: '#f97316' },
  { label: '-13 to -11', min: -13, max: -11, color: '#fb923c' },
  { label: '-11 to -9', min: -11, max: -9, color: '#eab308' },
  { label: '-9 to -7', min: -9, max: -7, color: '#a3e635' },
  { label: '-7 to -5', min: -7, max: -5, color: '#22c55e' },
  { label: '-5 to 0', min: -5, max: 0, color: '#15803d' },
  { label: '>= 0', min: 0, max: 999, color: '#052e16' },
]

export const RXQUAL_BANDS: Band[] = [
  { label: '0', min: 0, max: 1, color: '#84cc16' },
  { label: '1', min: 1, max: 2, color: '#16a34a' },
  { label: '2', min: 2, max: 3, color: '#eab308' },
  { label: '3', min: 3, max: 4, color: '#f97316' },
  { label: '4', min: 4, max: 5, color: '#f472b6' },
  { label: '5', min: 5, max: 6, color: '#991b1b' },
  { label: '6', min: 6, max: 7, color: '#dc2626' },
  { label: '>= 7', min: 7, max: 999, color: '#7f1d1d' },
]

export function bandColor(bands: Band[], v: number | null | undefined): string {
  if (v === null || v === undefined) return '#94a3b8'
  for (const b of bands) if (v >= b.min && v < b.max) return b.color
  return '#94a3b8'
}

export interface DtMetric {
  key: keyof Pick<DtSample, 'rsrp' | 'rsrq' | 'sinr' | 'ecno' | 'rx_qual'>
  label: string
  unit: string
  bands: Band[]
}

// Every tech's list of plottable metrics, primary signal first — mirrors
// v1's _dtMetricsForTech() exactly. `rsrp` always carries the unified
// dBm-scale primary signal reading regardless of tech (RxLevel for 2G,
// RSCP for 3G, true RSRP for 4G) — the label is what changes per tech,
// never the storage field, same convention the backend model uses.
export function metricsForTech(tech: DtTech): DtMetric[] {
  if (tech === '2G') {
    return [
      { key: 'rsrp', label: 'RxLevel', unit: ' dBm', bands: RXLEV_BANDS },
      { key: 'rx_qual', label: 'RxQual', unit: '', bands: RXQUAL_BANDS },
    ]
  }
  if (tech === '3G') {
    return [
      { key: 'rsrp', label: 'RSCP', unit: ' dBm', bands: RSRP_BANDS },
      { key: 'ecno', label: 'Ec/Io', unit: ' dB', bands: ECIO_BANDS },
    ]
  }
  return [
    { key: 'rsrp', label: 'RSRP', unit: ' dBm', bands: RSRP_BANDS },
    { key: 'rsrq', label: 'RSRQ', unit: ' dB', bands: RSRQ_BANDS },
    { key: 'sinr', label: 'SINR', unit: ' dB', bands: SINR_BANDS },
  ]
}

export function signalLabel(tech: DtTech): string {
  return tech === '2G' ? 'RxLevel' : tech === '3G' ? 'RSCP' : 'RSRP'
}

// Flattened metric list across all three techs (2026-08-05, moved here
// from DtExploreTab.tsx so DtCompareMap.tsx can share the exact same
// tab set instead of re-deriving a second copy) — matches v1's actual
// per-tech metric tabs ("RSRP:4G", "RSRQ:4G", "SINR:4G", "RSCP:3G",
// "Ec/Io:3G", "RxLevel:2G", "RxQual:2G"). Any multi-session/multi-tech
// view (Explore, Compare) needs this one flat list rather than the
// single-session coverage map's per-tech metric switcher.
export const ALL_TECHS: DtTech[] = ['4G', '3G', '2G']

export interface TaggedMetric extends DtMetric {
  tech: DtTech
  tag: string
}

export const ALL_METRICS: TaggedMetric[] = ALL_TECHS.flatMap((tech) =>
  metricsForTech(tech).map((m) => ({ ...m, tech, tag: `${m.label}:${tech}` })),
)

// "Poor" bucket, generalized across all 5 band tables above (2026-08-05,
// for DtCompareMap's per-metric stats column) — rather than hand-picking
// a numeric cutoff per metric (RSRP_BANDS/RXLEV_BANDS/RSRQ_BANDS/
// SINR_BANDS/ECIO_BANDS/RXQUAL_BANDS each use a different scale, and
// RXQUAL's is even inverted — low value is GOOD, unlike every other
// metric here), this defines "poor" as "the band's own color is one of
// the red shades every table already uses to mean degraded/bad" — a
// color-based rule holds up across all of them without needing a
// separate best/worst-direction flag per metric. ECIO_BANDS' very
// bottom band ("< -18", grey) is deliberately NOT counted as poor here:
// it shares bandColor()'s own grey no-data fallback color, so by this
// codebase's own convention grey already means "not a real degraded
// reading," not "worse than red."
const POOR_COLORS = new Set(['#dc2626', '#991b1b', '#7f1d1d'])
export function isPoorBand(bands: Band[], v: number | null | undefined): boolean {
  return POOR_COLORS.has(bandColor(bands, v))
}

// Caps how many real samples get drawn as individual Leaflet markers
// (2026-08-14 fix — a real 363,082-sample .trp-derived session made "the
// application" feel slow: DtCoverageMap.tsx draws ONE real
// L.circleMarker (SVG, not canvas — see that file's own history comment)
// per GPS-tagged sample, which that component's own comment says was
// only ever built/verified against "a few thousand points at most" — not
// the real scale multi-file .trp upload now produces. Same "cap what's
// rendered, don't fabricate" principle as
// feedback_unbounded_result_tables_crash_browser — evenly STRIDES
// through the array rather than truncating to the first N, so a long
// route still shows its full geographic extent (just less densely
// sampled) instead of only its first few kilometers.
//
// Deliberately NOT applied to DtCompareMap.tsx's real-map mode without a
// separate decision — that file's own comment records an explicit prior
// user reversal of a similar cap on its blank/plots-only panel ("do not
// limit to 500... need full plot there"); its guidance for that panel
// type is to prefer canvas rendering over dropping points again, not to
// silently reapply a cap. If Compare's real-Leaflet-map mode needs this
// same treatment, that's a separate call, not an automatic extension of
// this one.
export const MAX_MAP_DOTS = 15000

export function subsampleForMap<T>(items: T[], max: number = MAX_MAP_DOTS): T[] {
  if (items.length <= max) return items
  const stride = items.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * stride)])
  return out
}
