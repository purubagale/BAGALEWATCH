import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from '../api/queries'
import type { AdminUser, Role, UserWrite } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { ASSIGN_ROLES_PATH } from '../constants/opaqueRoutes'

// Role chips (2026-10-01, "full parity" RBAC feature) — a user can now
// hold multiple roles (one builtin tier plus any number of custom ones),
// so the plain `{u.role}` text this used to render is replaced with one
// chip per entry in `u.roles` (falls back to `[u.role]` for the
// vanishingly unlikely case of a user with no `roles` rows at all, so
// this never renders as empty). Read-only here — actual role assignment
// moved to its own Assign Roles page (AssignRolesPage.tsx), reachable via
// the link this renders; EditableUserRow below no longer edits role at
// all, matching the reference app's own split between "user account CRUD"
// and "role assignment" as two separate concerns/pages.
function RoleChips({ u }: { u: AdminUser }) {
  const roles = u.roles?.length ? u.roles : [u.role]
  return (
    <span className="role-chip-row">
      {roles.map((r) => (
        <span key={r} className="role-chip">{r}</span>
      ))}
    </span>
  )
}

const emptyNewUser: UserWrite = { username: '', password: '', role: 'viewer', name: '', dept: '', operator_mncs: [] }

// operator_mncs is edited here as a plain comma-separated string and
// parsed to/from string[] at the boundary -- a JSON array input has no
// real advantage for a handful of 2-3 digit MNC codes and would just
// make the common case (leave blank for unrestricted NTA/government/
// superadmin access) more fiddly to type. See AdminUser.operator_mncs'
// doc comment (api/types.ts) for what an empty vs non-empty list means.
function mncsToText(mncs: string[] | undefined): string {
  return (mncs ?? []).join(', ')
}
function textToMncs(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}

function EditableUserRow({ u, canWrite }: { u: AdminUser; canWrite: boolean }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(u.name)
  const [dept, setDept] = useState(u.dept)
  const [isActive, setIsActive] = useState(u.is_active)
  const [password, setPassword] = useState('')
  const [mncsText, setMncsText] = useState(mncsToText(u.operator_mncs))
  const [error, setError] = useState<string | null>(null)
  const updateUser = useUpdateUser(u.id)
  const deleteUser = useDeleteUser()

  // Keycloak owns an SSO user's role and re-applies it on every login
  // (2026-08-23), so the role is shown but not editable here — otherwise an
  // admin's change silently reverts next time that person signs in and looks
  // like a bug in this app. Password is hidden for the same class of reason
  // but a sharper one: setting a password on an SSO account would make it
  // reachable through local login, quietly undoing the point of SSO.
  const ssoManaged = u.auth_source === 'sso'

  async function save() {
    setError(null)
    try {
      // `role` is deliberately NOT sent here any more (2026-10-01) —
      // this row no longer edits it at all; Assign Roles (linked from the
      // Role column below) is the one place that edits a user's roles.
      const patch: Partial<UserWrite> = { name, dept, is_active: isActive, operator_mncs: textToMncs(mncsText) }
      if (!ssoManaged && password) patch.password = password
      await updateUser.mutateAsync(patch)
      setPassword('')
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function remove() {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
    await deleteUser.mutateAsync(u.id)
  }

  if (!editing) {
    return (
      <tr>
        <td>{u.username}</td>
        <td>
          <RoleChips u={u} />
          {ssoManaged && <span className="user-sso-tag" title="Role is managed by Keycloak SSO">SSO</span>}
          {canWrite && (
            <Link to={`${ASSIGN_ROLES_PATH}?user=${u.id}`} className="role-assign-link">
              Assign roles →
            </Link>
          )}
        </td>
        <td>{u.name}</td>
        <td>{u.dept}</td>
        <td>{u.operator_mncs?.length ? u.operator_mncs.join(', ') : <span className="muted">Unrestricted</span>}</td>
        <td>{u.is_active ? 'Active' : 'Disabled'}</td>
        <td>{u.last_login ? new Date(u.last_login).toLocaleString() : '—'}</td>
        {canWrite && (
          <td className="admin-table-actions">
            <button className="btn-secondary btn-small" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn-danger btn-small" onClick={remove} disabled={deleteUser.isPending}>Delete</button>
          </td>
        )}
      </tr>
    )
  }

  return (
    <tr>
      <td>{u.username}</td>
      <td>
        {/* Read-only here even while editing other fields (2026-10-01) --
            role editing moved entirely to Assign Roles; this row no longer
            has a role <select> at all, SSO-managed or not. */}
        <RoleChips u={u} />
        {ssoManaged && <span className="user-sso-tag" title="Role is managed by Keycloak SSO">SSO</span>}
      </td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input value={dept} onChange={(e) => setDept(e.target.value)} /></td>
      <td>
        <input
          value={mncsText}
          onChange={(e) => setMncsText(e.target.value)}
          placeholder="Unrestricted"
          title="Comma-separated MNC codes, e.g. 02, 03 -- leave blank for unrestricted (NTA/government/superadmin) access"
          style={{ width: 100 }}
        />
      </td>
      <td>
        <label className="inline-checkbox">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
      </td>
      <td>
        {ssoManaged ? (
          <span aria-label="not applicable">—</span>
        ) : (
          <input
            type="password" placeholder="New password (optional)"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </td>
      <td className="admin-table-actions">
        {error && <div className="form-error form-error-inline">{error}</div>}
        <button className="btn-secondary btn-small" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn-primary btn-small" onClick={save} disabled={updateUser.isPending}>
          {updateUser.isPending ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  )
}

export default function UsersPage() {
  const { user: me } = useAuth()
  const { data: users, isLoading, error } = useUsers()
  const createUser = useCreateUser()
  const [newUser, setNewUser] = useState<UserWrite>(emptyNewUser)
  const [createError, setCreateError] = useState<string | null>(null)

  if (isLoading) return <div className="page-status">Loading users…</div>
  if (error) return <div className="page-status page-status-error">Could not load users.</div>
  if (!me) return null

  // Matches v1 exactly: reading the user list is superadmin OR admin,
  // but only superadmin can create/edit/delete accounts — see
  // core/views.py's UserViewSet.get_permissions().
  const canWrite = me.role === 'superadmin'

  async function handleCreate() {
    setCreateError(null)
    if (!newUser.username || !newUser.password) {
      setCreateError('Username and password are required.')
      return
    }
    try {
      await createUser.mutateAsync(newUser)
      setNewUser(emptyNewUser)
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create user.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Users</h1>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Name</th>
            <th>Dept</th>
            <th>Operator scope</th>
            <th>Status</th>
            <th>Last login</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((u) => (
            <EditableUserRow key={u.id} u={u} canWrite={canWrite} />
          ))}
        </tbody>
      </table>

      {canWrite && (
        <section>
          <h2>Add user</h2>
          {createError && <div className="form-error">{createError}</div>}
          <div className="edit-grid">
            <label>
              Username
              <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            </label>
            <label>
              Password
              <input
                type="password"
                value={newUser.password ?? ''}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              />
            </label>
            <label>
              Role
              <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
                <option value="superadmin">superadmin</option>
                <option value="rescue_operator">rescue_operator</option>
              </select>
            </label>
            <label>
              Name
              <input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
            </label>
            <label>
              Dept
              <input value={newUser.dept} onChange={(e) => setNewUser({ ...newUser, dept: e.target.value })} />
            </label>
            <label>
              Operator scope
              <input
                value={mncsToText(newUser.operator_mncs)}
                onChange={(e) => setNewUser({ ...newUser, operator_mncs: textToMncs(e.target.value) })}
                placeholder="Unrestricted (e.g. NTA/government)"
                title="Comma-separated MNC codes, e.g. 02, 03 -- leave blank for unrestricted access"
              />
            </label>
          </div>
          <div className="admin-page-actions">
            <button className="btn-primary" onClick={handleCreate} disabled={createUser.isPending}>
              {createUser.isPending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
