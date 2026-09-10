import { useState, type FormEvent } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useCreateLiveSiteSource,
  useDeleteLiveSiteSource,
  useLiveSiteSources,
  useSyncLiveSiteSource,
  useUpdateLiveSiteSource,
} from '../api/queries'
import type { LiveSiteSource, LiveSiteSourceInput } from '../api/types'

// Live Site Sync (2026-08-26) — status/manual-trigger surface for the
// Live Site Directory sync (core/live_sites.py).
//
// **2026-09-08 — multiple sources**: "add feature of multiple source api
// connection in import api access page along with their separate
// automatic sync time set option and manual sinc." Replaces the old
// single-source config+status form with a list of independently
// configured LiveSiteSource rows (see that model's docstring in
// core/models.py) — each with its own URL/credentials/auth scheme, its
// own sync interval (confirmed via AskUserQuestion: an interval in
// minutes/hours, not a specific clock time), and its own manual "Sync
// now". Every enabled source is still merged into the SAME Site table by
// site id (confirmed via AskUserQuestion) — this page has no per-source
// view of Sites, only of each source's own connection/run history.
//
// The token field never round-trips the real secret — GET only ever
// returns a masked tail; leaving the field blank on save keeps whatever
// key is already stored (same convention the old single-source config
// form used).
//
// Superadmin-only for add/edit/delete, doubly so: the MenuItem's own
// `access='superadmin'` gating (migration 0038_seed_live_site_sync_menuitem.py)
// controls who reaches this route at all, and LiveSiteSourceListView/
// DetailView's write methods are IsSuperadminOnly (stricter than the
// read/sync tier's plain IsAdminOrSuperadmin) since a credential write is
// a bigger blast radius than a status read or a manual trigger.

const AUTH_SCHEME_OPTIONS = [
  { value: 'Token', label: 'Token <key>  (NetBox)' },
  { value: 'Bearer', label: 'Bearer <key>' },
] as const

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

interface SourceFormValues {
  name: string
  api_url: string
  auth_scheme: 'Bearer' | 'Token'
  interval_value: string
  interval_unit: 'minutes' | 'hours'
  enabled: boolean
  api_key: string
}

function emptyForm(): SourceFormValues {
  return { name: '', api_url: '', auth_scheme: 'Token', interval_value: '60', interval_unit: 'minutes', enabled: true, api_key: '' }
}

function formFromSource(s: LiveSiteSource): SourceFormValues {
  // Shown in whichever unit divides evenly, purely so an admin who set
  // "every 6 hours" sees "6 hours" back, not "360 minutes" — the stored
  // value is always minutes either way (see LiveSiteSource's own
  // docstring for why minutes, not seconds, is the stored unit).
  if (s.sync_interval_minutes % 60 === 0) {
    return {
      name: s.name, api_url: s.api_url, auth_scheme: s.auth_scheme, enabled: s.enabled, api_key: '',
      interval_value: String(s.sync_interval_minutes / 60), interval_unit: 'hours',
    }
  }
  return {
    name: s.name, api_url: s.api_url, auth_scheme: s.auth_scheme, enabled: s.enabled, api_key: '',
    interval_value: String(s.sync_interval_minutes), interval_unit: 'minutes',
  }
}

function toInput(values: SourceFormValues): LiveSiteSourceInput | { error: string } {
  const name = values.name.trim()
  if (!name) return { error: 'Give this source a name (e.g. the system it points at).' }
  const raw = Number(values.interval_value)
  if (!Number.isFinite(raw) || raw < 1 || !Number.isInteger(raw)) {
    return { error: 'Sync interval must be a whole number of minutes/hours, at least 1.' }
  }
  const sync_interval_minutes = values.interval_unit === 'hours' ? raw * 60 : raw
  const input: LiveSiteSourceInput = {
    name,
    api_url: values.api_url.trim(),
    auth_scheme: values.auth_scheme,
    sync_interval_minutes,
    enabled: values.enabled,
  }
  if (values.api_key.trim()) input.api_key = values.api_key.trim()
  return input
}

function SourceFormFields({
  values, onChange, apiKeyPlaceholder,
}: {
  values: SourceFormValues
  onChange: (next: SourceFormValues) => void
  apiKeyPlaceholder: string
}) {
  return (
    <div className="edit-grid" style={{ gridTemplateColumns: '1fr', gap: 12, maxWidth: 520 }}>
      <label>
        Name
        <input
          type="text" value={values.name} placeholder="e.g. NetBox (production)"
          onChange={(e) => onChange({ ...values, name: e.target.value })}
        />
      </label>
      <label>
        API URL
        <input
          type="text" value={values.api_url} placeholder="https://netbox.ntc.net.np/api/dcim/sites/"
          onChange={(e) => onChange({ ...values, api_url: e.target.value })}
        />
      </label>
      <label>
        Auth header
        <select
          value={values.auth_scheme}
          onChange={(e) => onChange({ ...values, auth_scheme: e.target.value as 'Bearer' | 'Token' })}
        >
          {AUTH_SCHEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label>
        API token
        <input
          type="password" value={values.api_key} autoComplete="new-password"
          placeholder={apiKeyPlaceholder}
          onChange={(e) => onChange({ ...values, api_key: e.target.value })}
        />
        {/* Never shows the real key -- only whether one is already stored, and its last few
            characters, so an admin can confirm WHICH token is saved without it ever
            round-tripping over the wire in full. */}
      </label>
      <label>
        Sync automatically every
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number" min={1} value={values.interval_value} style={{ width: 90 }}
            onChange={(e) => onChange({ ...values, interval_value: e.target.value })}
          />
          <select
            value={values.interval_unit}
            onChange={(e) => onChange({ ...values, interval_unit: e.target.value as 'minutes' | 'hours' })}
          >
            <option value="minutes">minute(s)</option>
            <option value="hours">hour(s)</option>
          </select>
        </div>
      </label>
      <label className="inline-checkbox">
        <input
          type="checkbox" checked={values.enabled}
          onChange={(e) => onChange({ ...values, enabled: e.target.checked })}
        />
        Enabled (unchecked pauses this source — the scheduled sync skips it, but its settings and history are kept)
      </label>
    </div>
  )
}

function SourceRow({ source }: { source: LiveSiteSource }) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<SourceFormValues>(() => formFromSource(source))
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tracks "a sync we started is still running" purely client-side --
  // see LiveSiteSourceSyncStartResponse's docstring for why this button
  // no longer gets an immediate created/updated result: a real sync
  // against a large source can take well over a minute, so the request
  // only starts it and returns right away. `pendingSince` is the click
  // time (Date.now()); as long as source.last_run_at (refreshed by the
  // list's own 15s poll) hasn't advanced PAST that moment yet, the run
  // we kicked off hasn't landed -- once it has (success or failure),
  // this clears itself with no timer or extra state to reset.
  const [pendingSince, setPendingSince] = useState<number | null>(null)
  const syncing = pendingSince !== null && (!source.last_run_at || new Date(source.last_run_at).getTime() < pendingSince)
  const updateSource = useUpdateLiveSiteSource(source.id)
  const deleteSource = useDeleteLiveSiteSource()
  const syncSource = useSyncLiveSiteSource()

  function startEdit() {
    setValues(formFromSource(source))
    setError(null)
    setEditing(true)
  }

  async function save() {
    setError(null)
    const input = toInput(values)
    if ('error' in input) {
      setError(input.error)
      return
    }
    try {
      await updateSource.mutateAsync(input)
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    }
  }

  async function toggleEnabled() {
    await updateSource.mutateAsync({ enabled: !source.enabled })
  }

  async function remove() {
    if (!window.confirm(`Remove the source "${source.name}"? Its saved URL/token and run history will be deleted. This cannot be undone.`)) return
    await deleteSource.mutateAsync(source.id)
  }

  async function sync() {
    setError(null)
    try {
      await syncSource.mutateAsync(source.id)
      setPendingSince(Date.now())
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start sync.'))
    }
  }

  const lastResult =
    source.last_created === null && source.last_updated === null
      ? '—'
      : `${source.last_created ?? 0} created, ${source.last_updated ?? 0} updated`
  const warningCount = source.last_warnings?.length ?? 0

  if (editing) {
    return (
      <tr>
        <td colSpan={7}>
          {error && <div className="form-error">{error}</div>}
          <SourceFormFields
            values={values}
            onChange={setValues}
            apiKeyPlaceholder={source.api_key_set ? `Leave blank to keep the saved token (${source.api_key_masked})` : 'Paste a token'}
          />
          <div className="admin-page-actions">
            <button className="btn-secondary btn-small" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-primary btn-small" onClick={save} disabled={updateSource.isPending}>
              {updateSource.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <>
      <tr>
        <td>{source.name}</td>
        <td style={{ wordBreak: 'break-all' }}>{source.api_url || <span className="muted">not set</span>}</td>
        <td>Every {formatInterval(source.sync_interval_minutes)}</td>
        <td>
          <label className="inline-checkbox">
            <input type="checkbox" checked={source.enabled} onChange={toggleEnabled} disabled={updateSource.isPending} />
            {source.enabled ? 'Enabled' : 'Paused'}
          </label>
        </td>
        <td>
          {syncing ? (
            <span className="muted">Syncing…</span>
          ) : source.last_error ? (
            <span style={{ color: 'var(--status-error, #dc2626)' }}>Failed</span>
          ) : source.last_success_at ? (
            <span style={{ color: 'var(--status-ok, #16a34a)' }}>OK</span>
          ) : (
            <span className="muted">Never run</span>
          )}
          {' '}
          <button type="button" className="btn-secondary btn-small" onClick={() => setDetailsOpen((v) => !v)}>
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
        </td>
        <td>{lastResult}{warningCount > 0 && ` (${warningCount} warning${warningCount === 1 ? '' : 's'})`}</td>
        <td className="admin-table-actions">
          {syncing && <div className="form-error form-error-inline" style={{ marginBottom: 4 }}>Sync started — this can take a minute or more for a large source; status updates automatically.</div>}
          {error && <div className="form-error form-error-inline">{error}</div>}
          <button className="btn-secondary btn-small" onClick={sync} disabled={syncSource.isPending || syncing || !source.api_url}>
            {syncSource.isPending || syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button className="btn-secondary btn-small" onClick={startEdit}>Edit</button>
          <button className="btn-danger btn-small" onClick={remove} disabled={deleteSource.isPending}>Delete</button>
        </td>
      </tr>
      {detailsOpen && (
        <tr>
          <td colSpan={7}>
            <table className="admin-table" style={{ margin: 0 }}>
              <tbody>
                <tr>
                  <th style={{ textAlign: 'left' }}>Last run</th>
                  <td>{formatDate(source.last_run_at)}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Last success</th>
                  <td>{formatDate(source.last_success_at)}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Auth header / token</th>
                  <td>{source.auth_scheme} — {source.api_key_set ? source.api_key_masked : <span className="muted">not set</span>}</td>
                </tr>
                <tr>
                  <th style={{ textAlign: 'left' }}>Last updated by</th>
                  <td>{source.updated_by_name ?? '—'} ({formatDate(source.updated_at)})</td>
                </tr>
              </tbody>
            </table>
            {source.last_error && (
              <div className="form-error" style={{ marginTop: 12 }}>
                <strong>Last run failed:</strong> {source.last_error}
              </div>
            )}
            {warningCount > 0 && (
              <div className="form-error form-error-inline" style={{ marginTop: 12 }}>
                <strong>{warningCount} warning(s) from the last run:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {(source.last_warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default function LiveSiteSyncPage() {
  const { data: sources, isLoading, error } = useLiveSiteSources()
  const createSource = useCreateLiveSiteSource()
  const [addOpen, setAddOpen] = useState(false)
  const [newValues, setNewValues] = useState<SourceFormValues>(emptyForm)
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setCreateError(null)
    const input = toInput(newValues)
    if ('error' in input) {
      setCreateError(input.error)
      return
    }
    try {
      await createSource.mutateAsync(input)
      setNewValues(emptyForm())
      setAddOpen(false)
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create source.'))
    }
  }

  if (isLoading) return <div className="page-status">Loading sync sources…</div>
  if (error) return <div className="page-status page-status-error">Could not load sync sources.</div>

  return (
    <div className="admin-page">
      <h1>Live Site Sync</h1>
      <p className="muted">
        Pulls site identity/location/on-air status (name, province, district, palika, ward, lat/long, deployment
        status, operational technologies) from one or more external Site Directory API connections and overwrites
        those fields on the matching site here — every source is merged into the same Site table by site ID. Sector
        details, KPI data, and drive-test sessions are never touched by this — those stay manually uploaded via the
        Sites and Backup pages, exactly as before.
      </p>

      <section>
        <h2>Sources</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>API URL</th>
              <th>Automatic sync</th>
              <th>Enabled</th>
              <th>Status</th>
              <th>Last result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(sources ?? []).map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
            {sources && sources.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">No sources configured yet — add one below.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Add a source</h2>
        {!addOpen ? (
          <div className="admin-page-actions">
            <button className="btn-primary" onClick={() => setAddOpen(true)}>Add source</button>
          </div>
        ) : (
          <form onSubmit={handleCreate}>
            {createError && <div className="form-error">{createError}</div>}
            <SourceFormFields values={newValues} onChange={setNewValues} apiKeyPlaceholder="Paste a token" />
            <div className="admin-page-actions">
              <button type="button" className="btn-secondary" onClick={() => { setAddOpen(false); setNewValues(emptyForm()); setCreateError(null) }}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={createSource.isPending}>
                {createSource.isPending ? 'Adding…' : 'Add source'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}
