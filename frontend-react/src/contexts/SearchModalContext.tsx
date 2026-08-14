import { createContext, useContext } from 'react'

// 2026-08-07 — supports "← Back to search results" (see SiteDetailPage.tsx).
// The Advanced Site Search modal is global and route-independent (opened
// from Layout.tsx's header on any page), and its filters/results now live
// lifted up in Layout too, specifically so closing it to visit a site's
// detail page and then reopening it shows the SAME results instead of an
// empty form the user has to re-fill. This context is just the "reopen it"
// half of that — SiteDetailPage doesn't own the modal, Layout does, so it
// needs a way to ask Layout to show it again without prop-drilling through
// every route.
export interface SearchModalContextValue {
  openSearch: () => void
}

export const SearchModalContext = createContext<SearchModalContextValue | null>(null)

// 2026-08-07 — this used to throw if the provider wasn't found, on the
// assumption that Layout always wraps every route (it does, per App.tsx).
// A real crash on /sites/:id right after this shipped means that
// assumption isn't safe to enforce with a throw, whatever the exact cause
// turns out to be (still being investigated — see RUNBOOK's 36th pass).
// Falling back to a no-op means a page can, at worst, silently not reopen
// the search modal — never blank itself out entirely over it.
const noopSearchModal: SearchModalContextValue = { openSearch: () => {} }

export function useSearchModal(): SearchModalContextValue {
  return useContext(SearchModalContext) ?? noopSearchModal
}
