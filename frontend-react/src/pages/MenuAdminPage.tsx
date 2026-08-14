import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useCreateMenuItem, useDeleteMenuItem, useMenuItems, useUpdateMenuItem } from '../api/queries'
import type { MenuAccess, MenuItem, MenuItemWrite, MenuLinkType } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { DASHBOARD_PATH, SITES_PATH } from '../constants/opaqueRoutes'

// Known internal routes (2026-08-08) — offered as a <datalist> so an
// admin picking "Internal route" doesn't have to remember exact paths
// (typos here would silently 404), while still allowing free text for
// routes added later without this list being kept perfectly in sync.
// Mirrors App.tsx's <Route path="..."> list.
//
// Most of these are now opaque, non-descriptive tokens rather than the
// readable names they used to be (2026-08-08, "secure the dynamic path
// url" follow-up — cosmetic obfuscation, see constants/opaqueRoutes.ts's
// OPAQUE_PATHS comment for the full explanation and caveats). `label` on
// each <option> keeps this dropdown usable despite that — a superadmin
// sees "SLA Tracker" in the picker even though the underlying value
// they're choosing is the opaque `/p3k7q2`. Dashboard and Sites Topology
// joined the rest of this list the same day (previously excluded, then
// added on request) — KEEP THIS MAPPING IN SYNC with
// constants/opaqueRoutes.ts's OPAQUE_PATHS and
// core/migrations/0018_obfuscate_builtin_menu_paths.py +
// core/migrations/0019_obfuscate_dashboard_sites_paths.py.
const KNOWN_ROUTES: { path: string; label: string }[] = [
  { path: DASHBOARD_PATH, label: 'Dashboard' },
  { path: SITES_PATH, label: 'Sites Topology' },
  { path: '/p3k7q2', label: 'SLA Tracker' },
  { path: '/x9f1lz', label: 'NTA Compliance' },
  { path: '/h4t8vn', label: 'Monthly Report' },
  { path: '/b6r0wc', label: 'Scatter Plot' },
  { path: '/q2n5je', label: 'KPI Trend' },
  { path: '/z8m3ky', label: 'RF Audit' },
  { path: '/w7h1sd', label: 'DT Data Manager (parent — auto-lists its children below)' },
  { path: '/n4v8gz', label: 'DT Upload' },
  { path: '/s2h6mp', label: 'DT Session History' },
  { path: '/e7x3kt', label: 'DT Explore' },
  { path: '/v8k3nq', label: 'TRP File Analysis' },
  { path: '/k5c9bf', label: 'Thresholds' },
  { path: '/r2v6mt', label: 'Tree Admin' },
  { path: '/f9j4qs', label: 'Backup' },
  { path: '/t3n7hy', label: 'DT Bands' },
  { path: '/d8k2wr', label: 'Users' },
  { path: '/y5b1qx', label: 'Permissions' },
  { path: '/c4h9lt', label: 'Menu Admin' },
  { path: '/j6r3fp', label: 'Branding' },
  { path: '/n8w5qk', label: 'API Access' },
]

// Generates a random opaque-looking route token in the same style as the
// hand-picked ones above (6 lowercase alphanumerics, e.g. "n8x2kw") — for
// the "Generate" button next to the Route field below. Added 2026-08-08
// alongside the Dashboard/Sites aliasing follow-up: the KNOWN_ROUTES list
// above only covers pages that already exist in App.tsx, but a
// superadmin can also create brand-new custom items purely through this
// page (e.g. "Master Data", "Setting" — see App.tsx's DynamicMenuFallback
// for how those render with no code change at all), and until now the
// Route field for those was just plain free text — nothing stopped a
// descriptive path like "/master-data" from ending up in the address
// bar, which is exactly what this whole feature was trying to avoid.
// This doesn't touch any EXISTING item — it only fills in a suggestion
// when clicked, so an admin can still type whatever they want.
function randomOpaqueToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return `/${s}`
}

const ACCESS_OPTIONS: [MenuAccess, string][] = [
  ['all', 'Any signed-in user'],
  ['permission', 'Governed by Permissions matrix'],
  ['admin', 'Admin + superadmin only'],
  ['superadmin', 'Superadmin only'],
]

const emptyDraft: MenuItemWrite = {
  label: '', link_type: 'route', path: '', parent: null, order: 0, access: 'all', permission_key: '', is_active: true,
  icon: '', description: '',
}

// Max upload size for a per-item icon image (2026-08-08 follow-up) —
// mirrors MAX_MENU_ICON_BYTES on the Django side (core/serializers.py),
// checked here too so a too-large file is rejected instantly client-side
// instead of round-tripping to the server first.
const MAX_ICON_IMAGE_BYTES = 2 * 1024 * 1024

/** Strips the read-only `id`/`icon_image_url` fields off a fetched
 * MenuItem so it can seed a MenuItemWrite draft — used when opening a
 * row for editing. Deliberately does NOT set `icon_image_data_url`/
 * `remove_icon_image`: leaving both undefined means "don't touch the
 * existing icon image," which is the correct default until the user
 * actually picks a new file or clicks Remove. */
function toMenuItemWrite(item: MenuItem): MenuItemWrite {
  const { id: _id, icon_image_url: _iconImageUrl, ...rest } = item
  return rest
}

// Multi-level submenu support (2026-08-08 follow-up: "need multilevel
// submenu") — these three helpers all walk the same flat MenuItem[] via
// its `parent` pointers, since the API returns a flat list (unlike
// useMenuTree()'s already-nested shape, which is server-filtered and NOT
// what this raw-CRUD admin page uses).

/** Depth-first traversal in parent->children order (root items first,
 * each immediately followed by its own descendants) — used both for the
 * admin table (so nesting is visually obvious via indentation) and for
 * the Parent picker's option order (so children stay grouped near their
 * parent instead of scattered across a flat id/order sort). */
function flattenTree(all: MenuItem[]): { item: MenuItem; depth: number }[] {
  const byParent = new Map<number | null, MenuItem[]>()
  for (const it of all) {
    const list = byParent.get(it.parent) ?? []
    list.push(it)
    byParent.set(it.parent, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || a.id - b.id)
  const out: { item: MenuItem; depth: number }[] = []
  function walk(parentId: number | null, depth: number) {
    for (const it of byParent.get(parentId) ?? []) {
      out.push({ item: it, depth })
      walk(it.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Every id reachable downward from `rootId` — used to keep the Parent
 * picker from offering a choice that would create a cycle (the backend
 * also rejects this in MenuItemSerializer.validate(), but filtering it
 * out of the dropdown is better UX than a save-time error). */
function collectDescendantIds(all: MenuItem[], rootId: number): Set<number> {
  const ids = new Set<number>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as number
    for (const child of all) {
      if (child.parent === id && !ids.has(child.id)) {
        ids.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return ids
}

function ItemFields({
  draft, setDraft, allItems, excludeId, currentIconImageUrl,
}: {
  draft: MenuItemWrite
  setDraft: (d: MenuItemWrite) => void
  allItems: MenuItem[]
  excludeId?: number
  // Only set when editing an existing item — lets the file-upload UI
  // show what's currently saved, distinct from `draft.icon_image_data_url`
  // (a NEW file picked but not yet saved) and `draft.remove_icon_image`
  // (the user asked to clear it, but hasn't saved that yet either).
  currentIconImageUrl?: string | null
}) {
  const excludedIds = excludeId !== undefined ? collectDescendantIds(allItems, excludeId) : new Set<number>()
  const parentOptions = flattenTree(allItems).filter(
    ({ item }) => item.id !== excludeId && !excludedIds.has(item.id),
  )
  const [iconFileError, setIconFileError] = useState<string | null>(null)

  // Preview precedence mirrors the server's own rule (see MenuItem's
  // docstring in models.py): a newly-picked file wins, then "removed"
  // shows nothing, then whatever's already saved.
  const previewSrc = draft.icon_image_data_url ?? (draft.remove_icon_image ? null : (currentIconImageUrl ?? null))

  function handleIconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setIconFileError(null)
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setIconFileError('Please choose an image file.')
      return
    }
    if (file.size > MAX_ICON_IMAGE_BYTES) {
      setIconFileError('Image is too large (max 2MB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setDraft({ ...draft, icon_image_data_url: reader.result as string, remove_icon_image: false })
    reader.readAsDataURL(file)
  }

  return (
    <div className="edit-grid">
      <label>
        Label
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
      </label>
      <label>
        Icon (single emoji — used as a fallback whenever no icon image is set)
        <input
          value={draft.icon}
          placeholder="🔗"
          maxLength={8}
          onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
        />
      </label>
      <label>
        Icon image (optional — overrides the emoji above; PNG/SVG/JPG, shown on the sidebar rail)
        <input type="file" accept="image/*" onChange={handleIconFileChange} />
      </label>
      {iconFileError && <div className="form-error-inline">{iconFileError}</div>}
      {previewSrc && (
        <div className="menu-icon-preview-row">
          <img src={previewSrc} alt="Icon preview" className="menu-icon-preview" />
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => setDraft({ ...draft, icon_image_data_url: undefined, remove_icon_image: true })}
          >
            Remove image
          </button>
        </div>
      )}
      <label>
        Description (sidebar hover detail / dashboard card body)
        <input
          value={draft.description}
          placeholder="One-line detail…"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <label>
        Link type
        <select
          value={draft.link_type}
          onChange={(e) => setDraft({ ...draft, link_type: e.target.value as MenuLinkType })}
        >
          <option value="route">Internal route</option>
          <option value="external">External URL</option>
        </select>
      </label>
      <label>
        {draft.link_type === 'route' ? 'Route' : 'URL'}
        <div className="menu-route-row">
          <input
            value={draft.path}
            list={draft.link_type === 'route' ? 'menu-known-routes' : undefined}
            placeholder={draft.link_type === 'route' ? '/n8x2kw (not a descriptive name)' : 'https://…'}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
          {draft.link_type === 'route' && (
            <button
              type="button"
              className="btn-secondary btn-small"
              title="Fill in a random, non-descriptive route so this page's URL doesn't reveal what it is"
              onClick={() => setDraft({ ...draft, path: randomOpaqueToken() })}
            >
              Generate
            </button>
          )}
        </div>
      </label>
      <label>
        Parent (submenu of — any existing item, nested as deep as you like)
        <select
          value={draft.parent ?? ''}
          onChange={(e) => setDraft({ ...draft, parent: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">— Top-level item —</option>
          {parentOptions.map(({ item, depth }) => (
            <option key={item.id} value={item.id}>
              {'  '.repeat(depth)}{depth > 0 ? '↳ ' : ''}{item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Order
        <input
          type="number"
          value={draft.order}
          onChange={(e) => setDraft({ ...draft, order: Number(e.target.value) })}
        />
      </label>
      <label>
        Access
        <select value={draft.access} onChange={(e) => setDraft({ ...draft, access: e.target.value as MenuAccess })}>
          {ACCESS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {draft.access === 'permission' && (
        <label>
          Permission key
          <input
            value={draft.permission_key}
            placeholder="e.g. wiki-link"
            onChange={(e) => setDraft({ ...draft, permission_key: e.target.value })}
          />
        </label>
      )}
      <label className="inline-checkbox">
        <input
          type="checkbox"
          checked={draft.is_active}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
        />
        Active
      </label>
    </div>
  )
}

function EditableMenuRow({
  item, allItems, depth, childCount,
}: {
  item: MenuItem
  allItems: MenuItem[]
  depth: number
  childCount: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<MenuItemWrite>(() => toMenuItemWrite(item))
  const [error, setError] = useState<string | null>(null)
  const updateItem = useUpdateMenuItem(item.id)
  const deleteItem = useDeleteMenuItem()

  async function save() {
    setError(null)
    try {
      await updateItem.mutateAsync(draft)
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function remove() {
    // Deleting a parent cascades to its children at the DB level (see
    // MenuItem.parent's on_delete=CASCADE) — warn before that's a
    // surprise, matching this app's other destructive-delete confirms.
    const warning = childCount > 0
      ? `Delete "${item.label}"? This will also delete its ${childCount} submenu item${childCount === 1 ? '' : 's'}.`
      : `Delete "${item.label}"?`
    if (!window.confirm(warning)) return
    try {
      await deleteItem.mutateAsync(item.id)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete.'))
    }
  }

  if (!editing) {
    return (
      <tr>
        <td>
          {depth > 0 && <span className="muted">{'  '.repeat(depth - 1)}↳ </span>}
          {item.icon_image_url ? <img src={item.icon_image_url} alt="" className="menu-icon-thumb" /> : item.icon} {item.label}
        </td>
        <td>{item.link_type === 'external' ? 'External' : 'Route'}</td>
        <td>{item.path}</td>
        <td>{item.access}{item.access === 'permission' && item.permission_key ? ` (${item.permission_key})` : ''}</td>
        <td>{item.order}</td>
        <td>{item.is_active ? 'Active' : 'Disabled'}</td>
        <td className="admin-table-actions">
          {error && <div className="form-error form-error-inline">{error}</div>}
          <button className="btn-secondary btn-small" onClick={() => { setDraft(toMenuItemWrite(item)); setEditing(true) }}>Edit</button>
          <button className="btn-danger btn-small" onClick={remove} disabled={deleteItem.isPending}>Delete</button>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td colSpan={7}>
        {error && <div className="form-error">{error}</div>}
        <ItemFields
          draft={draft} setDraft={setDraft} allItems={allItems} excludeId={item.id}
          currentIconImageUrl={item.icon_image_url}
        />
        <div className="admin-page-actions">
          <button className="btn-secondary btn-small" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn-primary btn-small" onClick={save} disabled={updateItem.isPending}>
            {updateItem.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function MenuAdminPage() {
  const { user } = useAuth()
  const { data: items, isLoading, error } = useMenuItems()
  const createItem = useCreateMenuItem()
  const [newItem, setNewItem] = useState<MenuItemWrite>(emptyDraft)
  const [createError, setCreateError] = useState<string | null>(null)

  if (isLoading) return <div className="page-status">Loading menu items…</div>
  if (error) return <div className="page-status page-status-error">Could not load menu items.</div>
  if (!user) return null

  // Matches MenuItemViewSet's own gate (IsSuperadminOnly) — a non-
  // superadmin reaching this route (e.g. by URL) sees a plain message
  // rather than a broken/empty admin table.
  if (user.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can manage the top menu.</div>
  }

  const all = items ?? []
  const rows = flattenTree(all)
  const childCountOf = (id: number) => all.filter((it) => it.parent === id).length

  async function handleCreate() {
    setCreateError(null)
    if (!newItem.label || !newItem.path) {
      setCreateError('Label and path/URL are required.')
      return
    }
    try {
      await createItem.mutateAsync(newItem)
      setNewItem(emptyDraft)
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create menu item.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Menu Admin</h1>
      <p className="muted">
        Manages the sidebar (Layout.tsx renders it live from this table). Submenus can nest as deep as you like —
        pick any existing item as the parent. A new item with access "Governed by Permissions matrix" needs a
        superadmin to grant it per-role on the Permissions page before admin/viewer can see it — same default-deny
        behavior every other menu already has.
      </p>
      <datalist id="menu-known-routes">
        {KNOWN_ROUTES.map((r) => <option key={r.path} value={r.path} label={r.label} />)}
      </datalist>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Type</th>
            <th>Path / URL</th>
            <th>Access</th>
            <th>Order</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, depth }) => (
            <EditableMenuRow key={item.id} item={item} allItems={all} depth={depth} childCount={childCountOf(item.id)} />
          ))}
        </tbody>
      </table>

      <section>
        <h2>Add menu item</h2>
        {createError && <div className="form-error">{createError}</div>}
        <ItemFields draft={newItem} setDraft={setNewItem} allItems={all} />
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleCreate} disabled={createItem.isPending}>
            {createItem.isPending ? 'Creating…' : 'Add item'}
          </button>
        </div>
      </section>
    </div>
  )
}
