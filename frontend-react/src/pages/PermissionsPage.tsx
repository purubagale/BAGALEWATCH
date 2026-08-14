import { useEffect, useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useMenuItems, usePermissionsMatrix, useUpdatePermissionsMatrix } from '../api/queries'
import type { CrudPerm, PermissionsMatrix, PermissionValue } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Full menu key list + CRUD-vs-simple shape, matching v1's DEFAULT_PERMS /
// CRUD_MENUS in bagalewatch_api.py exactly (confirmed by reading it
// directly, not inferred) — superadmin is deliberately excluded here,
// same reasoning as PermissionsMatrixView on the backend: it's an
// implicit-full-access role with no role_permissions rows to edit.
const CRUD_MENU_KEYS: [string, string][] = [
  ['sites', 'Sites Topology'],
  ['rsrpmgr', 'DT Data Manager'],
  ['tree', 'Tree Structure'],
  ['thresholds', 'KPI Thresholds'],
  ['datasource', 'Data Source'],
  ['backup', 'Backup'],
  ['kpireports', 'KPI Reports'],
]
// 'topology' removed from this list 2026-08-05 — the standalone Topology
// page/nav-link it used to (nominally) gate was retired the same day,
// folded into the 'sites' CRUD menu above (see SitesPage.tsx). It was
// already dead in practice before that: Layout.tsx's old Topology
// NavLink was never actually wrapped in an isAllowed() check, so toggling
// this checkbox never gated anything real in v2 — only kept here earlier
// for v1-schema parity. Any existing `menu_key='topology'` rows already
// in the database are harmless leftovers, not read by anything now; not
// worth a migration to delete them.
// Kept hardcoded (not derived from MenuItem) for these 6 original items
// plus the legacy 'reports' row — see the dynamicSimpleKeys memo in the
// component below for how a NEW custom menu item's permission_key gets
// appended to this list at render time without needing a code change
// here.
const SIMPLE_MENU_KEYS: [string, string][] = [
  ['reports', 'Reports'],
  ['rfaudit', 'RF Audit'],
  ['kpitrend', 'KPI Trend'],
  ['nta', 'NTA Compliance'],
  ['monthly', 'Monthly Report'],
  ['scatter', 'Scatter Plot'],
  ['sla', 'SLA Tracker'],
]
const CRUD_ACTIONS: (keyof CrudPerm)[] = ['read', 'write', 'update', 'delete']
const ROLES: ('admin' | 'viewer')[] = ['admin', 'viewer']

function asCrud(v: PermissionValue | undefined): CrudPerm {
  if (v && typeof v === 'object') return v
  return {}
}

export default function PermissionsPage() {
  const { user } = useAuth()
  const { data: matrix, isLoading, error } = usePermissionsMatrix()
  const updateMatrix = useUpdatePermissionsMatrix()
  // Dynamic top-nav (2026-08-08) — a superadmin can now add a brand new
  // custom menu item with access='permission' and an arbitrary
  // permission_key via the new Menu admin page. That key needs a toggle
  // HERE too, or there'd be no way to actually grant admin/viewer access
  // to it — MenuItemViewSet is already superadmin-only, matching this
  // page's own gate, so reusing useMenuItems() here doesn't loosen
  // anything. Only items not already covered by the hardcoded
  // SIMPLE_MENU_KEYS below are appended, so existing rows/labels for the
  // 6 original simple menus are untouched.
  const { data: menuItems } = useMenuItems()
  const dynamicSimpleKeys = useMemo<[string, string][]>(() => {
    const known = new Set(SIMPLE_MENU_KEYS.map(([key]) => key))
    const extra: [string, string][] = []
    for (const item of menuItems ?? []) {
      if (item.access === 'permission' && item.permission_key && !known.has(item.permission_key)) {
        known.add(item.permission_key)
        extra.push([item.permission_key, item.label])
      }
    }
    return extra
  }, [menuItems])

  const [draft, setDraft] = useState<PermissionsMatrix | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (matrix) setDraft(matrix)
  }, [matrix])

  if (isLoading) return <div className="page-status">Loading permissions…</div>
  if (error) return <div className="page-status page-status-error">Could not load the permission matrix.</div>
  if (!user || !draft) return null

  // Editing this page only makes sense for superadmin (the only role the
  // backend lets PUT here) — matches v1's own /permissions PUT gate.
  if (user.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can manage permissions.</div>
  }

  function setSimple(role: 'admin' | 'viewer', menuKey: string, value: boolean) {
    setDraft((d) => (d ? { ...d, [role]: { ...d[role], [menuKey]: value } } : d))
    setSaved(false)
  }

  function setCrud(role: 'admin' | 'viewer', menuKey: string, action: keyof CrudPerm, value: boolean) {
    setDraft((d) => {
      if (!d) return d
      const current = asCrud(d[role][menuKey])
      return { ...d, [role]: { ...d[role], [menuKey]: { ...current, [action]: value } } }
    })
    setSaved(false)
  }

  async function handleSave() {
    if (!draft) return
    setSaveError(null)
    setSaved(false)
    try {
      await updateMatrix.mutateAsync(draft)
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save permissions.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Permissions</h1>
      <p className="muted">
        Note: a signed-in admin/viewer won't see menu changes reflected until they log in again — permissions
        are resolved once at login, not re-fetched live.
      </p>
      {saveError && <div className="form-error">{saveError}</div>}
      {saved && <div className="form-success">Saved.</div>}

      <h2>CRUD menus</h2>
      <table className="admin-table permissions-table">
        <thead>
          <tr>
            <th>Menu</th>
            {ROLES.map((role) =>
              CRUD_ACTIONS.map((action) => (
                <th key={`${role}-${action}`}>{role}<br /><span className="muted">{action}</span></th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {CRUD_MENU_KEYS.map(([key, label]) => (
            <tr key={key}>
              <td>{label}</td>
              {ROLES.map((role) =>
                CRUD_ACTIONS.map((action) => (
                  <td key={`${role}-${action}`}>
                    <input
                      type="checkbox"
                      checked={!!asCrud(draft[role][key])[action]}
                      onChange={(e) => setCrud(role, key, action, e.target.checked)}
                    />
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Simple menus</h2>
      <table className="admin-table permissions-table">
        <thead>
          <tr>
            <th>Menu</th>
            {ROLES.map((role) => (
              <th key={role}>{role}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...SIMPLE_MENU_KEYS, ...dynamicSimpleKeys].map(([key, label]) => (
            <tr key={key}>
              <td>{label}</td>
              {ROLES.map((role) => (
                <td key={role}>
                  <input
                    type="checkbox"
                    checked={draft[role][key] === true}
                    onChange={(e) => setSimple(role, key, e.target.checked)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-page-actions">
        <button className="btn-primary" onClick={handleSave} disabled={updateMatrix.isPending}>
          {updateMatrix.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
