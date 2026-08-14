import { useMemo } from 'react'
import { useDtBands } from '../api/queries'
import type { DtTech } from '../api/types'
import { ALL_METRICS, type TaggedMetric } from './dtBands'

// Overlays server-saved band customizations (DtBandsPage.tsx / the new
// /api/v2/dt-bands/ endpoint, 2026-08-05) onto the static ALL_METRICS
// defaults from dtBands.ts, without changing that file's own exports or
// any call site's data SHAPE — every consumer still gets back plain
// TaggedMetric objects with the same `key`/`label`/`unit`/`tech`/`tag`/
// `bands` fields it already expects, just with `bands` possibly replaced
// by whatever an admin most recently saved for that tag.
//
// This is deliberately a merge, not a replace-wholesale: a metric tag an
// admin has never touched keeps using the hardcoded default from
// dtBands.ts (which is also what the one-time seed migration wrote into
// the database in the first place, so in practice the two start
// identical) — a tag customization is per-tag, not all-or-nothing.
//
// `useDtBands()` already has its own 60s staleTime and starts undefined
// on first render (before the query resolves) — this hook falls back to
// the plain hardcoded ALL_METRICS during that window so every map still
// renders correctly on first paint instead of waiting on a network
// round-trip just to know what color to draw a dot.
export function useDtMetrics() {
  const { data: customBands, isLoading } = useDtBands()

  const allMetrics = useMemo<TaggedMetric[]>(() => {
    if (!customBands) return ALL_METRICS
    return ALL_METRICS.map((m) => {
      const custom = customBands[m.tag]
      return custom && custom.length ? { ...m, bands: custom } : m
    })
  }, [customBands])

  const metricsForTech = useMemo(() => {
    return (tech: DtTech): TaggedMetric[] => allMetrics.filter((m) => m.tech === tech)
  }, [allMetrics])

  return { allMetrics, metricsForTech, isLoading }
}
