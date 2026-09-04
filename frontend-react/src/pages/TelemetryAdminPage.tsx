import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useCreateTelemetryKey,
  useDeleteTelemetryKey,
  useDriveTestConsentMessage,
  useRescueConsentPolicy,
  useSetDriveTestConsentMessage,
  useSetRescueConsentPolicy,
  useTelemetryKeys,
  useTelemetryStats,
  useUpdateTelemetryKey,
} from '../api/queries'
import type {
  TelemetryIngestKeyCreate,
  TelemetryIngestKeyCreateResponse,
  TelemetryIngestKeyRow,
} from '../api/types'

// Telemetry Admin (2026-08-31) — superadmin-only management of the
// crowdsourced-telemetry ingest credentials (core/telemetry_admin.py's
// TelemetryIngestKeyViewSet, backing /api/v2/telemetry/keys/) plus a
// volume overview. The keys minted here authenticate the SEPARATE public
// ingest endpoint at /api/telemetry/v1/samples/ — not this JWT-
// authenticated /api/v2/ admin surface.
//
// Same "reaching this route already requires the menu's own gating"
// reasoning ApiAccessPage.tsx documents — gating is access='superadmin'
// on the MenuItem itself (migration 0041_seed_telemetry_menuitems.py),
// so there's no separate isAllowed() check needed inside the page.

const emptyNewKey: TelemetryIngestKeyCreate = { name: '', rate_limit_per_min: 600 }

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function EditableKeyRow({ k }: { k: TelemetryIngestKeyRow }) {
  const [editing, setEditing] = useState(false)
  const [rate, setRate] = useState(k.rate_limit_per_min)
  const [error, setError] = useState<string | null>(null)
  const updateKey = useUpdateTelemetryKey(k.id)
  const deleteKey = useDeleteTelemetryKey()

  async function save() {
    setError(null)
    if (!Number.isFinite(rate) || rate < 1) {
      setError('Rate must be a positive number of batches/minute.')
      return
    }
    try {
      await updateKey.mutateAsync({ rate_limit_per_min: rate })
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function toggleActive() {
    await updateKey.mutateAsync({ is_active: !k.is_active })
  }

  async function remove() {
    if (
      !window.confirm(
        `Permanently delete the telemetry ingest key "${k.name}"? Any device or SDK build using it will immediately stop being able to upload. This cannot be undone.`,
      )
    )
      return
    await deleteKey.mutateAsync(k.id)
  }

  return (
    <tr>
      <td>{k.name}</td>
      <td>
        <code>tel_{k.key_prefix}…</code>
      </td>
      <td>
        {editing ? (
          <input
            type="number"
            min={1}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            style={{ width: 90 }}
          />
        ) : (
          `${k.rate_limit_per_min}/min`
        )}
      </td>
      <td>
        <label className="inline-checkbox">
          <input
            type="checkbox"
            checked={k.is_active}
            onChange={toggleActive}
            disabled={updateKey.isPending}
          />
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
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                setEditing(false)
                setRate(k.rate_limit_per_min)
              }}
            >
              Cancel
            </button>
            <button className="btn-primary btn-small" onClick={save} disabled={updateKey.isPending}>
              {updateKey.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            <button className="btn-secondary btn-small" onClick={() => setEditing(true)}>
              Edit rate
            </button>
            <button className="btn-danger btn-small" onClick={remove} disabled={deleteKey.isPending}>
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

function StatsPanel() {
  const { data: stats, isLoading, error } = useTelemetryStats()
  if (isLoading) return <p className="muted">Loading ingest stats…</p>
  if (error || !stats) return <p className="form-error form-error-inline">Could not load ingest stats.</p>

  return (
    <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
      <div>
        <div className="muted">Active keys</div>
        <strong style={{ fontSize: 20 }}>
          {stats.keys.active} / {stats.keys.total}
        </strong>
      </div>
      <div>
        <div className="muted">Batches received</div>
        <strong style={{ fontSize: 20 }}>{stats.batches.count.toLocaleString()}</strong>
      </div>
      <div>
        <div className="muted">Samples (all time)</div>
        <strong style={{ fontSize: 20 }}>{stats.batches.sample_total.toLocaleString()}</strong>
      </div>
      <div>
        <div className="muted">Samples · last 24h</div>
        <strong style={{ fontSize: 20 }}>{stats.samples.last_24h.toLocaleString()}</strong>
      </div>
      <div>
        <div className="muted">Samples · last 7d</div>
        <strong style={{ fontSize: 20 }}>{stats.samples.last_7d.toLocaleString()}</strong>
      </div>
      <div>
        <div className="muted">Coverage bins</div>
        <strong style={{ fontSize: 20 }}>{stats.coverage_bins.toLocaleString()}</strong>
      </div>
      <div>
        <div className="muted">Last batch at</div>
        <strong>{formatDate(stats.batches.last_received_at)}</strong>
      </div>
      <div>
        <div className="muted">By network · 7d</div>
        <strong>
          {stats.by_network_7d.length
            ? stats.by_network_7d.map((n) => `${n.network_type}: ${n.samples.toLocaleString()}`).join(' · ')
            : '—'}
        </strong>
      </div>
    </div>
  )
}

// Rescue-consent policy (2026-09-02) -- superadmin control over
// core/models.py's RescueConsentPolicy singleton. 'mandatory' (the
// default) requires each subscriber's own opt-in before a rescue lookup
// can ever match them; 'optional' is a time-boxed emergency override for
// the disaster-response scenario where the real integration (a carrier
// or government app) has no in-app consent screen at all -- the
// subscriber controls collection via OS-level app permission, not a tap
// in this SDK, so during an actual emergency there may be no deliberate
// "I consent" moment on record. See RescueConsentPolicy's docstring
// (core/models.py) for exactly what 'optional' does and does not unlock
// -- it never invents a phone-number link, only relaxes enforcement on
// subscribers who already have one on file.
function RescueConsentPolicyPanel() {
  const { data: policy, isLoading, error } = useRescueConsentPolicy()
  const setPolicy = useSetRescueConsentPolicy()
  const [mode, setMode] = useState<'mandatory' | 'optional'>('mandatory')
  const [reason, setReason] = useState('')
  const [activeUntil, setActiveUntil] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  // Seed the form from the fetched policy exactly once it arrives -- an
  // effect (not a render-phase setState) because useRescueConsentPolicy()
  // resolves asynchronously, so `policy` is undefined on the first render.
  useEffect(() => {
    if (!policy) return
    setMode(policy.mode)
    setReason(policy.reason)
    setActiveUntil(policy.active_until ? policy.active_until.slice(0, 16) : '')
  }, [policy])

  async function save() {
    setSaveError(null)
    try {
      await setPolicy.mutateAsync({
        mode,
        reason,
        active_until: activeUntil ? new Date(activeUntil).toISOString() : null,
      })
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  if (isLoading) return <p className="muted">Loading rescue-consent policy…</p>
  if (error) return <p className="form-error form-error-inline">Could not load rescue-consent policy.</p>

  return (
    <section>
      <h2>Rescue consent policy</h2>
      <p className="muted">
        Controls whether a rescue-operator lookup (<code>/api/v2/rescue/lookup/</code>) requires the subscriber's own
        opt-in ("Mandatory," the normal drive-test / day-to-day posture) or accepts any subscriber with a known
        number on file regardless of consent ("Optional," a declared disaster/rescue emergency). Every change here is
        written to an audit log. This never fabricates a new phone-number link for an anonymous device — it only
        relaxes enforcement on subscribers who already enrolled at least once.
      </p>
      {policy && (
        <p>
          Effective state:{' '}
          <strong>{policy.is_optional_active ? 'Optional (emergency override active)' : 'Mandatory'}</strong>
          {policy.mode === 'optional' && !policy.is_optional_active && (
            <span className="muted"> — stored mode is "optional" but it has expired</span>
          )}
        </p>
      )}
      {saveError && <div className="form-error">{saveError}</div>}
      <div className="edit-grid">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'mandatory' | 'optional')}>
            <option value="mandatory">Mandatory (default)</option>
            <option value="optional">Optional (emergency override)</option>
          </select>
        </label>
        <label>
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Flood response — Sindhupalchok, Sept 2026"
          />
        </label>
        <label>
          Active until (optional)
          <input type="datetime-local" value={activeUntil} onChange={(e) => setActiveUntil(e.target.value)} />
        </label>
      </div>
      <div className="admin-page-actions">
        <button className="btn-primary" onClick={save} disabled={setPolicy.isPending}>
          {setPolicy.isPending ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </section>
  )
}

// Drive-test consent MESSAGE (2026-09-02) -- the wording shown before a
// subscriber answers setDriveTestConsent(), separate from whether they
// accepted (that's TelemetryDriveTestConsentSummary, shown on the Drive
// Test page). The SDK renders no consent UI of its own; this exists so a
// deployment that wants to fetch and display centrally-editable copy can
// (the project's own demo app does) without baking wording into an app
// release. No audit log here, unlike Rescue consent policy above -- this
// only ever changes display text, never who's found or what's collected.
function DriveTestConsentMessagePanel() {
  const { data, isLoading, error } = useDriveTestConsentMessage()
  const setMessage = useSetDriveTestConsentMessage()
  const [message, setMessageText] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (data) setMessageText(data.message)
  }, [data])

  async function save() {
    setSaveError(null)
    setSaved(false)
    try {
      await setMessage.mutateAsync(message)
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  if (isLoading) return <p className="muted">Loading consent message…</p>
  if (error) return <p className="form-error form-error-inline">Could not load the drive-test consent message.</p>

  return (
    <section>
      <h2>Drive-test consent message</h2>
      <p className="muted">
        The copy a host app can fetch and show a subscriber before they accept or decline drive-test participation
        (<code>GET /api/telemetry/v1/drive-test-consent-message/</code>). Purely a convenience — the SDK shows no
        consent screen of its own, so a deployment is equally free to hardcode its own wording and ignore this
        entirely.
      </p>
      {saveError && <div className="form-error">{saveError}</div>}
      <label>
        Message
        <textarea
          value={message}
          onChange={(e) => {
            setMessageText(e.target.value)
            setSaved(false)
          }}
          rows={4}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </label>
      <div className="admin-page-actions">
        <button className="btn-primary" onClick={save} disabled={setMessage.isPending}>
          {setMessage.isPending ? 'Saving…' : 'Save message'}
        </button>
        {saved && !setMessage.isPending && <span className="muted"> Saved.</span>}
      </div>
    </section>
  )
}

export default function TelemetryAdminPage() {
  const { data: keys, isLoading, error } = useTelemetryKeys()
  const createKey = useCreateTelemetryKey()
  const [newKey, setNewKey] = useState<TelemetryIngestKeyCreate>(emptyNewKey)
  const [createError, setCreateError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<TelemetryIngestKeyCreateResponse | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleCreate() {
    setCreateError(null)
    if (!newKey.name.trim()) {
      setCreateError("Give this key a name (e.g. the SDK build or partner it's for).")
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
    navigator.clipboard
      .writeText(justCreated.key)
      .then(() => setCopied(true))
      .catch(() => {})
  }

  if (isLoading) return <div className="page-status">Loading telemetry keys…</div>
  if (error) return <div className="page-status page-status-error">Could not load telemetry keys.</div>

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="admin-page">
      <h1>Telemetry Admin</h1>
      <p className="muted">
        Ingest credentials and volume overview for the crowdsourced network-telemetry pilot. Keys created here
        authenticate the public ingest endpoint at <code>{origin}/api/telemetry/v1/samples/</code> — a separate
        surface from this app's own login and from the API Access keys.
      </p>

      <section>
        <h2>Overview</h2>
        <StatsPanel />
      </section>

      <RescueConsentPolicyPanel />
      <DriveTestConsentMessagePanel />

      {justCreated && (
        <div
          className="form-error"
          style={{
            background: 'var(--brand-primary-soft)',
            borderColor: 'var(--link-accent)',
            color: 'var(--text-primary)',
          }}
        >
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

      <section>
        <h2>Ingest keys</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Rate limit</th>
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
                <td colSpan={8} className="muted">
                  No telemetry ingest keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Create a new key</h2>
        {createError && <div className="form-error">{createError}</div>}
        <div className="edit-grid">
          <label>
            Name
            <input
              value={newKey.name}
              placeholder="e.g. NetPlanning SDK v1 — pilot"
              onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
            />
          </label>
          <label>
            Rate limit (batches / minute)
            <input
              type="number"
              min={1}
              value={newKey.rate_limit_per_min ?? 600}
              onChange={(e) => setNewKey({ ...newKey, rate_limit_per_min: Number(e.target.value) })}
            />
          </label>
          <label>
            Expires (optional)
            <input
              type="date"
              value={newKey.expires_at ? newKey.expires_at.slice(0, 10) : ''}
              onChange={(e) =>
                setNewKey({ ...newKey, expires_at: e.target.value ? `${e.target.value}T23:59:59Z` : null })
              }
            />
          </label>
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
          Point the SDK's <code>TelemetryConfig.apiKey</code> at it, or send it directly as a bearer token:
        </p>
        <pre className="code-block">
{`curl -X POST "${origin}/api/telemetry/v1/samples/" \\
  -H "Authorization: Bearer tel_..." \\
  -H "Content-Type: application/json" \\
  -d '[{"device_id":"<uuid>","ts":1725100000000,"lat":27.7,"lon":85.3,"network_type":"LTE","rsrp_dbm":-95}]'

curl "${origin}/api/telemetry/v1/health/"`}
        </pre>
      </section>
      <section>
        <h2>Dev tools</h2>
        <p className="muted">
          Raw, per-sample view for verifying test-device uploads during development -- not a coverage or
          subscriber-tracking feature. Superadmin-only, not linked from the main menu.
        </p>
        <a href="/telemetry-live-samples" className="btn-secondary btn-small">
          Live samples (dev)
        </a>{' '}
        <a href="/telemetry-dt-sessions" className="btn-secondary btn-small">
          Drive-test sessions
        </a>
      </section>
    </div>
  )
}

