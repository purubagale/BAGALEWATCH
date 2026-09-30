import { createContext, useContext, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { DtTech, SiteListItem } from '../api/types'
import { ALL_METRICS, ALL_TECHS } from '../lib/dtBands'
import type { LatLng } from '../lib/geo'

// 2026-09-30 ("restore exact search" when returning from a site's detail
// page) — DtExploreTab's search/selection state used to be plain local
// useState, so navigating to /sites/:id and back unmounted+remounted it
// from scratch, losing the search text, point/shape, tech filter,
// selected site, active metric tab, etc. Same fix shape as
// SearchModalContext (see its own comment): lift the state up into
// Layout, which never unmounts across a route change, and have
// DtExploreTab read/write it through this context instead of owning it
// itself. Only the fields that actually define "what was searched for"
// are lifted here — purely cosmetic UI toggles (list-section
// expand/collapse, fullscreen, the transient search-error banner) stay as
// DtExploreTab's own local state, since resetting those on return is
// harmless and lifting them would just be unnecessary surface area.
export type DtExploreSearchShape = { type: 'circle' } | { type: 'polygon'; points: LatLng[]; name: string }

export interface DtExploreStateContextValue {
  inputText: string
  setInputText: Dispatch<SetStateAction<string>>
  radiusKm: number
  setRadiusKm: Dispatch<SetStateAction<number>>
  techFilter: Set<DtTech>
  setTechFilter: Dispatch<SetStateAction<Set<DtTech>>>
  point: { lat: number; lng: number } | null
  setPoint: Dispatch<SetStateAction<{ lat: number; lng: number } | null>>
  pointLabel: string
  setPointLabel: Dispatch<SetStateAction<string>>
  shape: DtExploreSearchShape
  setShape: Dispatch<SetStateAction<DtExploreSearchShape>>
  latestOnly: boolean
  setLatestOnly: Dispatch<SetStateAction<boolean>>
  selectedSite: SiteListItem | null
  setSelectedSite: Dispatch<SetStateAction<SiteListItem | null>>
  metricTag: string
  setMetricTag: Dispatch<SetStateAction<string>>
  mapLayer: 'street' | 'satellite'
  setMapLayer: Dispatch<SetStateAction<'street' | 'satellite'>>
}

const DtExploreStateContext = createContext<DtExploreStateContextValue | null>(null)

export function DtExploreStateProvider({ children }: { children: ReactNode }) {
  const [inputText, setInputText] = useState('')
  const [radiusKm, setRadiusKm] = useState(2)
  const [techFilter, setTechFilter] = useState<Set<DtTech>>(new Set(ALL_TECHS))
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null)
  const [pointLabel, setPointLabel] = useState('')
  const [shape, setShape] = useState<DtExploreSearchShape>({ type: 'circle' })
  const [latestOnly, setLatestOnly] = useState(false)
  const [selectedSite, setSelectedSite] = useState<SiteListItem | null>(null)
  // ALL_METRICS[0].tag rather than useDtMetrics()'s allMetrics[0].tag --
  // the two are always the same value (a server-saved band customization
  // only ever replaces a metric's `bands`, never its `tag`), and this way
  // Layout doesn't need to pull in a DT-specific data hook just to seed a
  // default every other page never reads.
  const [metricTag, setMetricTag] = useState(ALL_METRICS[0].tag)
  const [mapLayer, setMapLayer] = useState<'street' | 'satellite'>('street')

  return (
    <DtExploreStateContext.Provider
      value={{
        inputText, setInputText,
        radiusKm, setRadiusKm,
        techFilter, setTechFilter,
        point, setPoint,
        pointLabel, setPointLabel,
        shape, setShape,
        latestOnly, setLatestOnly,
        selectedSite, setSelectedSite,
        metricTag, setMetricTag,
        mapLayer, setMapLayer,
      }}
    >
      {children}
    </DtExploreStateContext.Provider>
  )
}

export function useDtExploreState(): DtExploreStateContextValue {
  const ctx = useContext(DtExploreStateContext)
  if (!ctx) throw new Error('useDtExploreState() must be used inside <DtExploreStateProvider>')
  return ctx
}
