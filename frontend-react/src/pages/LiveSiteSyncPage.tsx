import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useLiveSiteSyncStatus, useTriggerLiveSiteSync } from '../api/queries'

// Live Site Sync (2026-08-26) — status/manual-trigger surface for the
// Live Site Directory sync (core/live_sites.py). Deliberately does NOT
// let an admin edit the API URL/key here — those stay .env-only so the
// credential never touches Postgres (see LiveSiteSyncView's docstring
// for the full reasoning, confirmed via AskUserQuestion the same day).
// This page is the middle ground: real visibility and a "Sync now"
// button, without becoming a second place a secret can leak from.
//
// Superadmin-only via the MenuItem's own `access='superadmin'` gating
// (migration 0038_seed_live_site_sync_menuitem.py) — same "reaching this
// route already requires the menu's own gating" reasoning ApiAccessPage.tsx
// documents, so no separate isAllowed() check is needed inside the page.

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

export default function LiveSiteSyncPage() {
  const { data: status, isLoading, error } = useLiveSiteSyncStatus()
  const triggerSync = useTriggerLiveSiteSync()
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ created: number; updated: number } | null>(null)

  async function handleSync() {
    setTriggerError(null)
    setLastResult(null)
    try {
      const result = await triggerSync.mutateAsync()
      setLastResult({ created: result.created, updated: result.updated })
    } catch (err) {
      setTriggerError(apiErrorMessage(err, 'Sync failed.'))
    }
  }

  if (isLoading) return <div className="page-status">Loading sync status…</div>
  if (error || !status) return <div className="page-status page-status-error">Could not load sync status.</div>

  return (
    <div className="admin-page">
      <h1>Live Site Sync</h1>
      <p className="muted">
        Pulls site identity/location/on-air status (name, province, district, palika, ward, lat/long, deployment
        status, operational technologies) from an external Site Directory API and overwrites those fields on the
        matching site here. Sector details, KPI data, and drive-test sessions are never touched by this — those stay
        manually uploaded via the Sites and Backup pages, exactly as before.
      </p>

      <section>
        <h2>Configuration</h2>
        {status.configured ? (
          <p>
            <strong style={{ color: 'var(--status-ok, #16a34a)' }}>Configured.</strong> The scheduled sync runs
            automatically every {Math.round(status.sync_interval_seconds / 60)} minute(s).
          </p>
        ) : (
          <p className="form-error">
            <strong>Not configured.</strong> Set <code>LIVE_SITE_API_URL</code> (and <code>LIVE_SITE_API_KEY</code>
            {' '}if the source requires one) in the server's <code>.env</code> file and restart the <code>django</code>
            {' '}and <code>site-sync</code> containers. These are never editable from this page — the credential
            stays out of the database on purpose.
          </p>
        )}
      </section>

      <section>
        <h2>Status</h2>
        <table className="admin-table">
          <tbody>
            <tr>
              <th style={{ textAlign: 'left' }}>Last run</th>
              <td>{formatDate(status.last_run_at)}</td>
            </tr>
            <tr>
              <th style={{ textAlign: 'left' }}>Last success</th>
              <td>{formatDate(status.last_success_at)}</td>
            </tr>
            <tr>
              <th style={{ textAlign: 'left' }}>Last result</th>
              <td>
                {status.last_created === null && status.last_updated === null
                  ? '—'
                  : `${status.last_created ?? 0} created, ${status.last_updated ?? 0} updated`}
              </td>
            </tr>
          </tbody>
        </table>

        {status.last_error && (
          <div className="form-error" style={{ marginTop: 12 }}>
            <strong>Last run failed:</strong> {status.last_error}
          </div>
        )}
        {status.last_warnings.length > 0 && (
          <div className="form-error form-error-inline" style={{ marginTop: 12 }}>
            <strong>{status.last_warnings.length} warning(s) from the last run:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {status.last_warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2>Manual sync</h2>
        <p className="muted">
          Runs immediately instead of waiting for the next scheduled pull — useful right after fixing something at
          the source.
        </p>
        {triggerError && <div className="form-error">{triggerError}</div>}
        {lastResult && !triggerError && (
          <div className="form-error" style={{ background: 'var(--brand-primary-soft)', borderColor: 'var(--link-accent)', color: 'var(--text-primary)' }}>
            Synced: {lastResult.created} created, {lastResult.updated} updated.
          </div>
        )}
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleSync} disabled={triggerSync.isPending}>
            {triggerSync.isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </section>
    </div>
  )
}
