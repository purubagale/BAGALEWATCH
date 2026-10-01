import { apiErrorMessage } from '../api/client'
import { useMenuItems, useMenuVisibility, useRoles, useUpdateMenuVisibility } from '../api/queries'
import type { MenuItem } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useState } from 'react'

// Menu Visibility (2026-10-01, "full parity" RBAC feature) — a sparse,
// per-(menu item, role) override grid layered on top of MenuItem.access's
// existing coarse tier (all/permission/admin/superadmin/rescue). A missing
// cell means "inherit the coarse default"; a cell holds true/false only
// when a superadmin has explicitly decided to override it for that role.
// See get_visible_menu_items()/own_access_ok() in core/views.py for the
// precedence this backs: explicit ALLOW on any held role wins, else
// explicit DENY on every role-with-an-override wins, else inherit.
//
// Superadmin is deliberately NOT a column here — core/views.py skips the
// override lookup entirely for superadmin (same reasoning as
// PermissionsMatrixView excluding it: a superadmin's access is absolute
// and was never meant to be narrowable through this screen).

/** Same depth-first, parent-grouped flatten as MenuAdminPage.tsx's own
 * (private) flattenTree — duplicated rather than imported since that one
 * isn't exported and this page's needs (just id/label/depth/parent-ness)
 * are simpler than that page's drag/edit-aware version. */
function flattenForGrid(all: MenuItem[]): { item: MenuItem; depth: number; isGroup: boolean }[] {
  const byParent = new Map<number | null, MenuItem[]>()
  for (const it of all) {
    const list = byParent.get(it.parent) ?? []
    list.push(it)
    byParent.set(it.parent, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || a.id - b.id)
  const out: { item: MenuItem; depth: number; isGroup: boolean }[] = []
  function walk(parentId: number | null, depth: number) {
    for (const it of byParent.get(parentId) ?? []) {
      out.push({ item: it, depth, isGroup: (byParent.get(it.id)?.length ?? 0) > 0 })
      walk(it.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function nextOverride(current: boolean | undefined): boolean | null {
  if (current === undefined) return true
  if (current === true) return false
  return null
}

function CellLabel({ value }: { value: boolean | undefined }) {
  if (value === true) return <span className="menu-vis-cell menu-vis-cell-allow">✓</span>
  if (value === false) return <span className="menu-vis-cell menu-vis-cell-deny">✕</span>
  return <span className="menu-vis-cell menu-vis-cell-inherit">·</span>
}

export default function MenuVisibilityPage() {
  const { user: me } = useAuth()
  const { data: items, isLoading: itemsLoading, error: itemsError } = useMenuItems()
  const { data: roles, isLoading: rolesLoading } = useRoles()
  const { data: matrix, isLoading: matrixLoading } = useMenuVisibility()
  const updateVisibility = useUpdateMenuVisibility()
  const [error, setError] = useState<string | null>(null)
  const [pendingCell, setPendingCell] = useState<string | null>(null)

  if (itemsLoading || rolesLoading || matrixLoading) return <div className="page-status">Loading…</div>
  if (itemsError) return <div className="page-status page-status-error">Could not load menu items.</div>
  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can manage menu visibility.</div>
  }

  const visibleRoles = (roles ?? []).filter((r) => r.name !== 'superadmin')
  const rows = flattenForGrid(items ?? [])

  async function toggle(itemId: number, roleName: string, current: boolean | undefined) {
    const key = `${itemId}:${roleName}`
    setError(null)
    setPendingCell(key)
    try {
      await updateVisibility.mutateAsync({ [String(itemId)]: { [roleName]: nextOverride(current) } })
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not update this override.'))
    } finally {
      setPendingCell(null)
    }
  }

  return (
    <div className="admin-page">
      <h1>Menu Visibility</h1>
      <p className="muted">
        Click a cell to cycle it: <strong>·</strong> inherit the item's default access tier → <strong>✓</strong> always
        show for that role → <strong>✕</strong> always hide for that role → back to inherit. Superadmin always sees
        everything and isn't shown as a column here.
      </p>
      {error && <div className="form-error">{error}</div>}

      <table className="admin-table menu-visibility-table">
        <thead>
          <tr>
            <th>Menu item</th>
            {visibleRoles.map((r) => (
              <th key={r.id} style={{ textAlign: 'center' }}>{r.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, depth, isGroup }) => (
            <tr key={item.id}>
              <td style={{ paddingLeft: 10 + depth * 18, fontWeight: isGroup ? 600 : 400 }}>{item.label}</td>
              {visibleRoles.map((r) => {
                const current = matrix?.[String(item.id)]?.[r.name]
                const key = `${item.id}:${r.name}`
                return (
                  <td key={r.id} style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      className="menu-vis-cell-btn"
                      onClick={() => toggle(item.id, r.name, current)}
                      disabled={pendingCell === key}
                      title={current === true ? 'Always visible — click to deny' : current === false ? 'Always hidden — click to reset' : 'Inherits default access — click to allow'}
                    >
                      <CellLabel value={current} />
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={1 + visibleRoles.length} className="page-status">No menu items found.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
