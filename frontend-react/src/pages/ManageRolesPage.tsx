import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useCreateRole, useDeleteRole, useRoles, useUpdateRole } from '../api/queries'
import type { RoleRow, RoleWrite } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Manage Roles (2026-10-01, "full parity" RBAC feature) — CRUD for
// custom role DEFINITIONS (name/label/description), backing the new
// Role model (core/models.py) via RoleViewSet (core/roles.py). Same
// inline-edit-row pattern as UsersPage.tsx's EditableUserRow, including
// the same "load everything, edit in place" shape — this list is always
// small (a handful of builtin + custom roles), no pagination needed.
//
// `is_builtin` rows (superadmin/admin/viewer/rescue_operator) can have
// their label/description edited but never their `name` (RoleSerializer.
// validate() rejects a rename server-side regardless) and can never be
// deleted (RoleViewSet.destroy() 400s) — every DRF permission class and
// MenuItem access tier hardcodes those 4 literal strings, so either
// action would silently strip privilege from whoever held the role.
const emptyNewRole: RoleWrite = { name: '', label: '', description: '' }

function EditableRoleRow({ role, canWrite }: { role: RoleRow; canWrite: boolean }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(role.label)
  const [description, setDescription] = useState(role.description)
  const [error, setError] = useState<string | null>(null)
  const updateRole = useUpdateRole(role.id)
  const deleteRole = useDeleteRole()

  async function save() {
    setError(null)
    try {
      await updateRole.mutateAsync({ label, description })
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function remove() {
    if (!window.confirm(`Delete role "${role.name}"? This also removes it from every user who holds it. This cannot be undone.`)) return
    try {
      await deleteRole.mutateAsync(role.id)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete this role.'))
    }
  }

  if (!editing) {
    return (
      <tr>
        <td className="admin-table-key">{role.name}</td>
        <td>{role.label}</td>
        <td>{role.description || <span className="muted">—</span>}</td>
        <td>{role.is_builtin ? <span className="muted">Builtin</span> : new Date(role.created_at).toLocaleDateString()}</td>
        {canWrite && (
          <td className="admin-table-actions">
            {error && <div className="form-error form-error-inline">{error}</div>}
            <button className="btn-secondary btn-small" onClick={() => setEditing(true)}>Edit</button>
            <button
              className="btn-danger btn-small"
              onClick={remove}
              disabled={deleteRole.isPending || role.is_builtin}
              title={role.is_builtin ? 'Builtin roles cannot be deleted' : undefined}
            >
              Delete
            </button>
          </td>
        )}
      </tr>
    )
  }

  return (
    <tr>
      <td className="admin-table-key">{role.name}</td>
      <td><input value={label} onChange={(e) => setLabel(e.target.value)} /></td>
      <td><input value={description} onChange={(e) => setDescription(e.target.value)} /></td>
      <td className="admin-table-actions" colSpan={2}>
        {error && <div className="form-error form-error-inline">{error}</div>}
        <button className="btn-secondary btn-small" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn-primary btn-small" onClick={save} disabled={updateRole.isPending}>
          {updateRole.isPending ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  )
}

export default function ManageRolesPage() {
  const { user: me } = useAuth()
  const { data: roles, isLoading, error } = useRoles()
  const createRole = useCreateRole()
  const [newRole, setNewRole] = useState<RoleWrite>(emptyNewRole)
  const [createError, setCreateError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  if (isLoading) return <div className="page-status">Loading roles…</div>
  if (error) return <div className="page-status page-status-error">Could not load roles.</div>
  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can manage roles.</div>
  }

  const canWrite = true
  const q = search.trim().toLowerCase()
  const visibleRoles = (roles ?? []).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.label.toLowerCase().includes(q),
  )

  async function handleCreate() {
    setCreateError(null)
    const name = newRole.name.trim().toLowerCase()
    if (!name || !newRole.label.trim()) {
      setCreateError('Name and label are required.')
      return
    }
    if (!/^[a-z0-9_]+$/.test(name)) {
      setCreateError('Name must be lowercase letters, numbers, and underscores only (e.g. ftth_leader).')
      return
    }
    try {
      await createRole.mutateAsync({ ...newRole, name })
      setNewRole(emptyNewRole)
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create role.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Manage Roles</h1>
      <p className="muted">
        Create custom roles for the Permission Matrix and Menu Visibility, or edit the label/description of an
        existing one. The 4 builtin roles (superadmin, admin, viewer, rescue_operator) can be relabeled but never
        renamed or deleted — every part of this app's access control depends on their exact names.
      </p>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search roles…"
        style={{ marginBottom: 10, maxWidth: 260 }}
      />

      <table className="admin-table">
        <thead>
          <tr>
            <th>Role Name</th>
            <th>Label</th>
            <th>Description</th>
            <th>Created At</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {visibleRoles.map((r) => (
            <EditableRoleRow key={r.id} role={r} canWrite={canWrite} />
          ))}
          {visibleRoles.length === 0 && (
            <tr>
              <td colSpan={5} className="page-status">No roles match this search.</td>
            </tr>
          )}
        </tbody>
      </table>

      <section>
        <h2>New Role</h2>
        {createError && <div className="form-error">{createError}</div>}
        <div className="edit-grid">
          <label>
            Name (slug)
            <input
              value={newRole.name}
              onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
              placeholder="e.g. ftth_leader"
            />
          </label>
          <label>
            Label
            <input
              value={newRole.label}
              onChange={(e) => setNewRole({ ...newRole, label: e.target.value })}
              placeholder="e.g. FTTH Leader"
            />
          </label>
          <label>
            Description
            <input
              value={newRole.description ?? ''}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
              placeholder="Optional"
            />
          </label>
        </div>
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleCreate} disabled={createRole.isPending}>
            {createRole.isPending ? 'Creating…' : '+ New Role'}
          </button>
        </div>
      </section>
    </div>
  )
}
