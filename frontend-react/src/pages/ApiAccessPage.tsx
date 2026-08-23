import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useApiKeys, useCreateApiKey, useDeleteApiKey, useUpdateApiKey } from '../api/queries'
import { API_KEY_SCOPES, type ApiKeyCreate, type ApiKeyCreateResponse, type ApiKeyRow, type ApiKeyScope } from '../api/types'

// API Access (2026-08-12, "add feature to create api to share certain
// data of system to other and to receive certain data from other
// system") — superadmin-only management of the external data-exchange
// API's credentials (core/api_auth.py's ApiKeyViewSet, backing
// /api/v2/api-keys/). The keys created here authenticate calls to a
// SEPARATE, API-key-only surface at /api/external/v1/ (core/
// external_api.py) — not the JWT-authenticated /api/v2/ this admin page
// itself runs on.
//
// This is a read-only diagnostic/management tool from the frontend's own
// point of view (nothing here is consumed by any other v2 page) — same
// "reaching this route already requires the menu's own gating" reasoning
// TrpAnalysisPage.tsx documents, except here the gating is
// `access='superadmin'` on the MenuItem itself (see migration
// 0030_seed_api_access_menuitem.py), not a permission_key, so there's no
// separate isAllowed() check needed inside the page either.

const emptyNewKey: ApiKeyCreate = { name: '', scopes: [] }

function scopeLabel(scope: ApiKeyScope): string {
  return API_KEY_SCOPES.find((s) => s.value === scope)?.label ?? scope
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function EditableKeyRow({ k }: { k: ApiKeyRow }) {
  const [editing, setEditing] = useState(false)
  const [scopes, setScopes] = useState<ApiKeyScope[]>(k.scopes)
  const [error, setError] = useState<string | null>(null)
  const updateKey = useUpdateApiKey(k.id)
  const deleteKey = useDeleteApiKey()

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  async function save() {
    setError(null)
    if (!scopes.length) {
      setError('Select at least one scope.')
      return
    }
    try {
      await updateKey.mutateAsync({ scopes })
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function toggleActive() {
    await updateKey.mutateAsync({ is_active: !k.is_active })
  }

  async function remove() {
    if (!window.confirm(`Permanently delete the API key "${k.name}"? Any system using it will immediately lose access. This cannot be undone.`)) return
    await deleteKey.mutateAsync(k.id)
  }

  return (
    <tr>
      <td>{k.name}</td>
      <td><code>bw_{k.key_prefix}…</code></td>
      <td>
        {editing ? (
          <div className="edit-grid" style={{ gridTemplateColumns: '1fr', gap: 2 }}>
            {API_KEY_SCOPES.map((s) => (
              <label key={s.value} className="inline-checkbox">
                <input type="checkbox" checked={scopes.includes(s.value)} onChange={() => toggleScope(s.value)} /> {s.label}
              </label>
            ))}
          </div>
        ) : (
          k.scopes.map(scopeLabel).join(', ') || '—'
        )}
      </td>
      <td>
        <label className="inline-checkbox">
          <input type="checkbox" checked={k.is_active} onChange={toggleActive} disabled={updateKey.isPending} />
          {k.is_active ? 'Active' : 'Revoked'}
        </label>
      </td>
      <td>{formatDate(k.created_at)}</td>
      <td>{formatDate(k.last_used_at)}</td>
      <td>{k.expires_at ? formatDate(k.expires_at) : 'Never'}</td>
      <td className="admin-table-actions">
        {error && <div className="form-error form-error-inline">{error}</div>}
        {editing ? (
          <>
            <button className="btn-secondary btn-small" onClick={() => { setEditing(false); setScopes(k.scopes) }}>Cancel</button>
            <button className="btn-primary btn-small" onClick={save} disabled={updateKey.isPending}>
              {updateKey.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            <button className="btn-secondary btn-small" onClick={() => setEditing(true)}>Edit scopes</button>
            <button className="btn-danger btn-small" onClick={remove} disabled={deleteKey.isPending}>Delete</button>
          </>
        )}
      </td>
    </tr>
  )
}

export default function ApiAccessPage() {
  const { data: keys, isLoading, error } = useApiKeys()
  const createKey = useCreateApiKey()
  const [newKey, setNewKey] = useState<ApiKeyCreate>(emptyNewKey)
  const [createError, setCreateError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<ApiKeyCreateResponse | null>(null)
  const [copied, setCopied] = useState(false)

  function toggleNewScope(scope: ApiKeyScope) {
    setNewKey((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope) ? prev.scopes.filter((s) => s !== scope) : [...prev.scopes, scope],
    }))
  }

  async function handleCreate() {
    setCreateError(null)
    if (!newKey.name.trim()) {
      setCreateError('Give this key a name (e.g. the external system it\'s for).')
      return
    }
    if (!newKey.scopes.length) {
      setCreateError('Select at least one scope.')
      return
    }
    try {
      const created = await createKey.mutateAsync(newKey)
      setJustCreated(created)
      setNewKey(emptyNewKey)
      setCopied(false)
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create key.'))
    }
  }

  function copyKey() {
    if (!justCreated) return
    navigator.clipboard.writeText(justCreated.key).then(() => setCopied(true)).catch(() => {})
  }

  if (isLoading) return <div className="page-status">Loading API keys…</div>
  if (error) return <div className="page-status page-status-error">Could not load API keys.</div>

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="admin-page">
      <h1>API Access</h1>
      <p className="muted">
        Manage credentials for external systems to share data with, or receive data from, DT-WATCH — a separate
        API-key-authenticated surface at <code>{origin}/api/external/v1/</code>, distinct from this app's own login.
      </p>

      {justCreated && (
        <div className="form-error" style={{ background: 'var(--brand-primary-soft)', borderColor: 'var(--link-accent)', color: 'var(--text-primary)' }}>
          <strong>"{justCreated.name}" created.</strong> Copy this key now — it will never be shown again. If it's
          lost, delete this key and create a new one.
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <code style={{ padding: '4px 8px', background: 'var(--bg-app)', borderRadius: 4, wordBreak: 'break-all' }}>
              {justCreated.key}
            </code>
            <button type="button" className="btn-secondary btn-small" onClick={copyKey}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={() => setJustCreated(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Scopes</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <EditableKeyRow key={k.id} k={k} />
          ))}
          {keys && keys.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">No API keys yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <section>
        <h2>Create a new key</h2>
        {createError && <div className="form-error">{createError}</div>}
        <div className="edit-grid">
          <label>
            Name
            <input
              value={newKey.name} placeholder="e.g. Regional NOC KPI feed"
              onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
            />
          </label>
          <label>
            Expires (optional)
            <input
              type="date"
              value={newKey.expires_at ? newKey.expires_at.slice(0, 10) : ''}
              onChange={(e) => setNewKey({ ...newKey, expires_at: e.target.value ? `${e.target.value}T23:59:59Z` : null })}
            />
          </label>
        </div>
        <div style={{ margin: '8px 0' }}>
          {API_KEY_SCOPES.map((s) => (
            <label key={s.value} className="inline-checkbox" style={{ marginRight: 16 }}>
              <input type="checkbox" checked={newKey.scopes.includes(s.value)} onChange={() => toggleNewScope(s.value)} /> {s.label}
            </label>
          ))}
        </div>
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleCreate} disabled={createKey.isPending}>
            {createKey.isPending ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </section>

      <section>
        <h2>Using a key</h2>
        <p className="muted">
          Send it as a header on every request: <code>X-API-Key: bw_&lt;your key&gt;</code>. Full endpoint list and
          request/response shapes are in the API schema at <code>{origin}/api/v2/docs/</code> (the external endpoints
          are grouped under <code>/api/external/v1/</code> there too).
        </p>
        <pre className="code-block">
{`curl -H "X-API-Key: bw_..." ${origin}/api/external/v1/sites/?region=Bagmati%20Province

curl -X POST -H "X-API-Key: bw_..." -H "Content-Type: application/json" \\
  -d '{"id":"CDR0123","call_drop":1.2,"cell_avail":99.8}' \\
  ${origin}/api/external/v1/sites/`}
        </pre>
      </section>
    </div>
  )
}
