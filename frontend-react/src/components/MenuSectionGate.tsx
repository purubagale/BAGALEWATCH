import type { ReactNode } from 'react'
import { useMenuTree } from '../api/queries'
import MenuSectionPage from '../pages/MenuSectionPage'
import { findNodeByPath } from '../utils/menuTree'

/** Shows an auto-generated section listing (`MenuSectionPage`) INSTEAD OF
 * a route's own dedicated page component, whenever a superadmin has given
 * that menu item one or more children via Menu Admin (2026-08-08 request:
 * "for top level item menu if submenu is present then... display all the
 * inside submenu items" — since generalized to any depth via the shared
 * `findNodeByPath` in utils/menuTree.ts, a recursive tree search rather
 * than a top-level-only lookup). Wraps every protected route in App.tsx except
 * `/dashboard` (already its own customizable overview page, not one more
 * page that could itself get overridden by this same mechanism — kept
 * deliberately separate to avoid two "home" concepts fighting each
 * other). The vast majority of the time `node` has no children yet, so
 * this is a no-op passthrough straight to `children`.
 *
 * Reads from the SAME `useMenuTree()` query Layout.tsx already fetches
 * (shared React Query cache, same key — this never triggers an extra
 * network request), so a section can only ever list children the current
 * user can actually see in the sidebar; nothing hidden leaks through. */
export default function MenuSectionGate({ path, children }: { path: string; children: ReactNode }) {
  const { data: menuTree } = useMenuTree()
  const node = findNodeByPath(menuTree ?? [], path)
  if (node && node.children.length > 0) {
    return <MenuSectionPage node={node} />
  }
  return <>{children}</>
}
