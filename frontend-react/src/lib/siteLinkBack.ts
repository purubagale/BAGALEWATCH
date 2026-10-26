import { useCallback } from 'react'
import { useLocation } from 'react-router-dom'

// A site link that carries the way back (2026-10-26). A site opened from the
// Problem Dashboard gets `?back=<this address>`, and the bar Layout shows on
// every page (BackToProfileBar) leads back to the complaint, on the same tab.
export function useSiteLinkBack() {
  const location = useLocation()
  return useCallback(
    (siteId: string) => `/sites/${encodeURIComponent(siteId)}?${new URLSearchParams({ back: `${location.pathname}${location.search}` })}`,
    [location.pathname, location.search],
  )
}
