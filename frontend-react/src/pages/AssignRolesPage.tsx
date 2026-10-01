import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useRoles, useSetUserRoles, useUserRoles, useUsers } from '../api/queries'
import type { AdminUser } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Assign Roles (2026-10-01, "full parity" RBAC feature) — the other half
// of the Users page's role column: UsersPage.tsx's "Assign roles →" link
// navigates here with `?user=<id>` so a superadmin can jump straight to
// one user instead of searching again. Client-side filtered user search
// over useUsers(), same "load everything, filter locally" convention as
// the rest of this admin suite (user list is small enough this is fine).
function userLabel(u: AdminUser): string {
  return u.name ? `${u.username} — ${u.name}` : u.username
}

export default function AssignRolesPage() {
  const { user: me } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: users, isLoading: usersLoading, error: usersError } = useUsers()
  const { data: roles, isLoading: rolesLoading } = useRoles()
  const [search, setSearch] = useState('')

  const selectedUserId = searchParams.get('user') ? Number(searchParams.get('user')) : undefined
  const selectedUser = users?.find((u) => u.id === selectedUserId)

  const { data: userRoles, isLoading: userRolesLoading } = useUserRoles(selectedUserId)
  const setUserRoles = useSetUserRoles(selectedUserId)
  const [pendingRoleToAdd, setPendingRoleToAdd] = useState('')
  const [error, setError] = useState<string | null>(null)

  const q = search.trim().toLowerCase()
  const filteredUsers = useMemo(() => {
    if (!q) return users ?? []
    return (users ?? []).filter(
      (u) => u.username.toLowerCase().includes(q) || u.name?.toLowerCase().includes(q) || u.dept?.toLowerCase().includes(q),
    )
  }, [users, q])

  if (usersLoading || rolesLoading) return <div className="page-status">Loading…</div>
  if (usersError) return <div className="page-status page-status-error">Could not load users.</div>
  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can assign roles.</div>
  }

  function selectUser(id: number) {
    setError(null)
    setPendingRoleToAdd('')
    setSearchParams({ user: String(id) })
  }

  const heldNames = new Set((userRoles ?? []).map((r) => r.name))
  const availableToAdd = (roles ?? []).filter((r) => !heldNames.has(r.name))

  async function addRole() {
    if (!pendingRoleToAdd) return
    setError(null)
    try {
      await setUserRoles.mutateAsync([...heldNames, pendingRoleToAdd])
      setPendingRoleToAdd('')
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add this role.'))
    }
  }

  async function removeRole(name: string) {
    setError(null)
    try {
      await setUserRoles.mutateAsync([...heldNames].filter((n) => n !== name))
    } catch (err) {
      // Most likely cause: this was the user's only builtin-tier role --
      // the backend (core/roles.py's UserRolesView.put()) rejects leaving
      // a user with zero builtin privilege tier.
      setError(apiErrorMessage(err, 'Could not remove this role.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Assign Roles</h1>
      <p className="muted">
        Every user needs exactly one builtin-tier role (superadmin, admin, viewer, or rescue_operator) at all times —
        that's what drives their base access. Custom roles layer on top and only affect the Permission Matrix and
        Menu Visibility.
      </p>

      <div className="assign-roles-layout">
        <section className="assign-roles-users">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users…"
            style={{ marginBottom: 10, width: '100%', maxWidth: 320 }}
          />
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Current roles</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr
                  key={u.id}
                  className={u.id === selectedUserId ? 'admin-table-row-selected' : undefined}
                  onClick={() => selectUser(u.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{userLabel(u)}</td>
                  <td>
                    <span className="role-chip-row">
                      {(u.roles?.length ? u.roles : [u.role]).map((r) => (
                        <span key={r} className="role-chip">{r}</span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={2} className="page-status">No users match this search.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="assign-roles-detail">
          {!selectedUser && <p className="page-status">Select a user to manage their roles.</p>}
          {selectedUser && (
            <>
              <h2>{userLabel(selectedUser)}</h2>
              {error && <div className="form-error">{error}</div>}
              {userRolesLoading ? (
                <p className="page-status">Loading roles…</p>
              ) : (
                <>
                  <div className="role-chip-row" style={{ marginBottom: 12 }}>
                    {(userRoles ?? []).map((r) => (
                      <span key={r.id} className="role-chip">
                        {r.label}
                        <button
                          type="button"
                          className="role-chip-remove"
                          onClick={() => removeRole(r.name)}
                          disabled={setUserRoles.isPending}
                          aria-label={`Remove ${r.label}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {(userRoles ?? []).length === 0 && <span className="muted">No roles assigned.</span>}
                  </div>

                  <div className="edit-grid">
                    <label>
                      Add a role…
                      <select value={pendingRoleToAdd} onChange={(e) => setPendingRoleToAdd(e.target.value)}>
                        <option value="">Select a role</option>
                        {availableToAdd.map((r) => (
                          <option key={r.id} value={r.name}>{r.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="admin-page-actions">
                    <button
                      className="btn-primary"
                      onClick={addRole}
                      disabled={!pendingRoleToAdd || setUserRoles.isPending}
                    >
                      {setUserRoles.isPending ? 'Saving…' : 'Add role'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
