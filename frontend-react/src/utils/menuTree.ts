import type { MenuTreeNode } from '../api/types'

/** Depth-first search through the WHOLE menu tree (not just the top
 * level) for the node whose `path` matches. Shared by `MenuSectionGate`
 * (existing hardcoded page routes) and `App.tsx`'s catch-all fallback
 * (brand-new custom paths created purely via Menu Admin, with no
 * dedicated page component at all — 2026-08-08, see App.tsx's
 * `DynamicMenuFallback` for why that second use exists). */
export function findNodeByPath(nodes: MenuTreeNode[], path: string): MenuTreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n
    const found = findNodeByPath(n.children ?? [], path)
    if (found) return found
  }
  return undefined
}
