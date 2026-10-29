import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import CellKpiSourceSection from '../components/CellKpiSourceSection'
import { apiErrorMessage } from '../api/client'
import {
  useAlarmSource,
  useAlarmSummary,
  useRefreshAlarms,
  useSaveAlarmSource,
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

      <AlarmFeedSection />
      <CellKpiSourceSection />
    </div>
  )
}

// Active alarms (2026-10-26, core/alarms.py). Unlike the site sources above
// nothing is copied in: alarms are read live from the alarm system, kept for
// a minute and shown per site ("Active alarms" on each site page). This card
// shows whether the feed answers and what it holds now.
// The alarm connection (2026-10-26, core/alarms.py AlarmSourceView): address,
// header, key and refresh time, saved here instead of in the server's .env.
// The key is never shown again; leaving it blank keeps the saved one.
function AlarmSourceForm() {
  const { data: src } = useAlarmSource()
  const save = useSaveAlarmSource()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [scheme, setScheme] = useState<'Bearer' | 'Token'>('Bearer')
  const [key, setKey] = useState('')
  const [cacheS, setCacheS] = useState(60)
  const [enabled, setEnabled] = useState(true)
  const [msg, setMsg] = useState('')
  const start = () => {
    setUrl(src?.api_url || src?.env_url || ''); setScheme(src?.auth_scheme ?? 'Bearer'); setKey('')
    setCacheS(src?.cache_seconds ?? 60); setEnabled(src?.enabled ?? true); setMsg(''); setOpen(true)
  }
  const where = src?.origin === 'page'
    ? `Set on this page${src.updated_by ? ` by ${src.updated_by}` : ''}${src.updated_at ? `, ${new Date(src.updated_at).toLocaleString()}` : ''}`
    : src?.origin === 'env' ? 'Set on the server' : 'Not set'
  if (!open) {
    return (
      <div className="admin-page-actions" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'center' }}>
        <span className="muted">Connection: <b>{src?.api_url || src?.env_url || '—'}</b> · {where}{src?.origin === 'page' && !src.enabled ? ' · paused' : ''}</span>
        <button type="button" className="btn-secondary btn-small" onClick={start}>Edit connection</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    )
  }
  return (
    <form className="alarm-source-form" onSubmit={(e) => {
      e.preventDefault()
      save.mutate({ api_url: url.trim(), auth_scheme: scheme, cache_seconds: cacheS, enabled, ...(key.trim() ? { api_key: key.trim() } : {}) },
        { onSuccess: () => { setOpen(false); setMsg('Saved. The next look asks the alarm system again.') } })
    }}>
      <label>Address of the active-alarm list
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Address ending in /api/v1/alarms/active" />
      </label>
      <label>Header
        <select value={scheme} onChange={(e) => setScheme(e.target.value as 'Bearer' | 'Token')}>
          <option value="Bearer">Bearer &lt;key&gt;</option>
          <option value="Token">Token &lt;key&gt;</option>
        </select>
      </label>
      <label>Key
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password"
          placeholder={src?.has_key ? 'Leave blank to keep the saved key' : 'Paste the key'} />
      </label>
      <label>Keep the list for
        <select value={cacheS} onChange={(e) => setCacheS(Number(e.target.value))}>
          {[30, 60, 120, 300, 600].map((s) => <option key={s} value={s}>{s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}</option>)}
        </select>
      </label>
      <label className="alarm-source-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On (untick to pause)</label>
      <p className="muted" style={{ margin: 0 }}>Leave the address empty to use the connection set on the server.</p>
      {save.error && <p className="error">{apiErrorMessage(save.error)}</p>}
      <div className="admin-page-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn-secondary btn-small" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="btn-primary btn-small" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        {src?.has_key && (
          <button type="button" className="btn-secondary btn-small" disabled={save.isPending}
            onClick={() => { if (window.confirm('Remove the saved key?')) save.mutate({ clear_key: true }) }}>Remove saved key</button>
        )}
      </div>
    </form>
  )
}

function AlarmFeedSection() {
  const { data: s, isLoading, error } = useAlarmSummary()
  const refresh = useRefreshAlarms()
  return (
    <section>
      <h2>Active alarms</h2>
      <p className="muted">
        Live alarms from NTC's alarm system. They are not copied into DT-WATCH: each site page asks for its own when
        opened (button "Active alarms"), and the list is kept for {s?.cache_seconds ?? 60} seconds so every user shares
        one fetch. Set the connection here, not as a site source above: a site source overwrites site details with
        what it returns.
      </p>
      <AlarmSourceForm />
      {isLoading ? <p className="muted">Asking the alarm system…</p>
        : error ? <p className="error">{apiErrorMessage(error)}</p>
          : !s?.configured ? <p className="muted">No alarm connection is set yet.</p>
            : (
              <>
                <div className="admin-page-actions" style={{ justifyContent: 'flex-start', gap: 12, alignItems: 'center' }}>
                  <span>{s.error ? <span className="error">{s.error}</span>
                    : <>Connected · <b>{s.total}</b> active alarms on <b>{s.sites}</b> sites · fetched {s.fetched_at ? new Date(s.fetched_at).toLocaleString() : '-'}</>}</span>
                  <button className="btn-secondary btn-small" disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}>
                    {refresh.isPending ? 'Refreshing…' : '↻ Refresh now'}
                  </button>
                </div>
                {!s.error && (
                  <div className="alarm-summary-grid">
                    <div>
                      <h3>By severity</h3>
                      <ul>{(s.by_severity ?? []).map(([k, n]) => <li key={k}>{k}: <b>{n}</b></li>)}</ul>
                      <h3>By network element</h3>
                      <ul>{(s.by_ne_type ?? []).map(([k, n]) => <li key={k}>{k}: <b>{n}</b></li>)}</ul>
                      {(s.no_site ?? 0) > 0 && <p className="muted">{s.no_site} alarms name no site.</p>}
                      {(s.unknown_sites ?? 0) > 0 && <p className="muted">{s.unknown_sites} sites with alarms are not in the site list.</p>}
                    </div>
                    <div>
                      <h3>Most common alarms</h3>
                      <ul>{(s.by_type ?? []).map(([k, n]) => <li key={k}>{k}: <b>{n}</b></li>)}</ul>
                    </div>
                    <div>
                      <h3>Sites with the most alarms</h3>
                      <table className="admin-table" data-pager="off">
                        <thead><tr><th>Site</th><th>Alarms</th></tr></thead>
                        <tbody>
                          {(s.top_sites ?? []).map((t) => (
                            <tr key={t.site_id}>
                              <td>{t.known ? <Link to={`/sites/${t.site_id}`}>{t.site_id}</Link> : t.site_id}{t.name ? ` · ${t.name}` : ''}</td>
                              <td>{t.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
    </section>
  )
}
