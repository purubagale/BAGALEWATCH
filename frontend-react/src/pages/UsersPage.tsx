import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from '../api/queries'
import type { AdminUser, Role, UserWrite } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const emptyNewUser: UserWrite = { username: '', password: '', role: 'viewer', name: '', dept: '' }

function EditableUserRow({ u, canWrite }: { u: AdminUser; canWrite: boolean }) {
  const [editing, setEditing] = useState(false)
  const [role, setRole] = useState<Role>(u.role)
  const [name, setName] = useState(u.name)
  const [dept, setDept] = useState(u.dept)
  const [isActive, setIsActive] = useState(u.is_active)
  const [password, setPassword] = useState('')
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
      const patch: Partial<UserWrite> = { name, dept, is_active: isActive }
      if (!ssoManaged) patch.role = role
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
          {u.role}
          {ssoManaged && <span className="user-sso-tag" title="Role is managed by Keycloak SSO">SSO</span>}
        </td>
        <td>{u.name}</td>
        <td>{u.dept}</td>
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
        {ssoManaged ? (
          <span title="Managed by Keycloak SSO — change the user's group in Keycloak instead">
            {u.role} <span className="user-sso-tag">SSO</span>
          </span>
        ) : (
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
            <option value="superadmin">superadmin</option>
          </select>
        )}
      </td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input value={dept} onChange={(e) => setDept(e.target.value)} /></td>
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
