import { create } from 'zustand'

// Pure client view state (open/closed tree nodes, selected site) —
// deliberately NOT server state, so it doesn't get tangled with
// TanStack Query's cache (see api/queries.ts). Mirrors v1's
// netwatch_tree_state localStorage key conceptually, but Phase 1 keeps
// it in-memory only; persisting it is a small, low-risk follow-up once
// the tree ships, not a blocker for Phase 1 itself.

interface TreeState {
  expandedProvinces: Set<string>
  expandedDistricts: Set<string>
  selectedSiteId: string | null
  toggleProvince: (key: string) => void
  toggleDistrict: (key: string) => void
  selectSite: (id: string | null) => void
}

export const useTreeStore = create<TreeState>((set) => ({
  expandedProvinces: new Set(),
  expandedDistricts: new Set(),
  selectedSiteId: null,
  toggleProvince: (key) =>
    set((s) => {
      const next = new Set(s.expandedProvinces)
      next.has(key) ? next.delete(key) : next.add(key)
      return { expandedProvinces: next }
    }),
  toggleDistrict: (key) =>
    set((s) => {
      const next = new Set(s.expandedDistricts)
      next.has(key) ? next.delete(key) : next.add(key)
      return { expandedDistricts: next }
    }),
  selectSite: (id) => set({ selectedSiteId: id }),
}))
