import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useCreateDtPruneRun, useDtPruneRun, useDtPruneRunAction, useDtPruneRuns, useDtRetentionSettings,
  useSaveDtRetentionSettings,
} from '../api/queries'
import type { DtRetentionSettings } from '../api/types'
import { purposeLabel } from '../lib/dtPurpose'

// Drive-Test Retention (2026-10-14) -- superadmin. The rule that turns old
// full drive-test readings into 50 m summaries, a dry run of it, approval,
// and the permanent record of what was removed. Nothing is removed until a
// dry run is approved while the rule is switched on.

const NUMBER_FIELDS: { key: keyof DtRetentionSettings; label: string; hint: string }[] = [
  { key: 'yearly_keep', label: 'Yearly drives kept complete', hint: 'The latest yearly (NTA) drives that measured a place keep every reading there, at any age.' },
  { key: 'per_square_keep', label: 'Recent drives kept per place', hint: 'In each 50 m square, the most recent drives of any purpose keep their readings…' },
  { key: 'detail_months', label: 'Months of full readings', hint: '…while they are at most this many months old.' },
  { key: 'summary_years', label: 'Years summaries are kept', hint: 'A session with no full readings left is erased after this many years.' },
  { key: 'min_readings', label: 'Readings for a drive to count in a square', hint: 'Fewer readings than this in a square do not make it "measured" by that drive.' },
]

const STATUS_LABEL: Record<string, string> = {
  planned: 'Dry run, waiting for approval', approved: 'Approved, starting', running: 'Running',
  done: 'Done', failed: 'Failed', discarded: 'Discarded',
}

export default function DtRetentionPage() {
  const settings = useDtRetentionSettings()
  const save = useSaveDtRetentionSettings()
  const runs = useDtPruneRuns()
  const createRun = useCreateDtPruneRun()
  const [draft, setDraft] = useState<DtRetentionSettings | null>(null)
  const [openRun, setOpenRun] = useState<number | null>(null)
  useEffect(() => {
    if (settings.data) setDraft(settings.data)
  }, [settings.data])

  const changed = !!draft && !!settings.data && NUMBER_FIELDS.some((f) => draft[f.key] !== settings.data[f.key])

  return (
    <div className="admin-page" style={{ maxWidth: 1100 }}>
      <h1>Drive-Test Retention</h1>
      <p className="muted">
        Old drive-test readings are reduced to 50 m squares (count, weakest, strongest and average of each measurement)
        where newer drives measured the same places. The latest yearly drives, recent drives, kept sessions and sessions
        linked to an optimization activity keep every reading, and the last full readings of any place are never removed.
        Nothing is removed until you run a dry run, check it and approve it while retention is switched on. Every change
        is recorded below and kept.
      </p>

      <h2>Rule</h2>
      {settings.error && <p className="error">{apiErrorMessage(settings.error)}</p>}
      {draft && (
        <div className="retention-settings">
          {NUMBER_FIELDS.map((f) => (
            <label key={f.key} className="retention-field">
              <span>{f.label}</span>
              <input
                type="number"
                value={draft[f.key] as number}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              />
              <small className="muted">{f.hint}</small>
            </label>
          ))}
          <div className="retention-actions">
            <button type="button" className="btn-primary btn-small" disabled={!changed || save.isPending}
              onClick={() => save.mutate(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, draft[f.key]])))}>
              Save rule
            </button>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={!!settings.data?.enabled}
                disabled={save.isPending}
                onChange={(e) => save.mutate({ enabled: e.target.checked })}
              />
              Retention switched on (approved runs are carried out)
            </label>
            {settings.data?.updated_by && (
              <span className="muted" style={{ fontSize: 12 }}>
                Last changed by {settings.data.updated_by}, {new Date(settings.data.updated_at ?? '').toLocaleString()}
              </span>
            )}
          </div>
          {save.error && <p className="error">{apiErrorMessage(save.error)}</p>}
        </div>
      )}

      <h2>Dry runs and record</h2>
      <div className="retention-actions">
        <button type="button" className="btn-primary btn-small" disabled={createRun.isPending || changed}
          onClick={() => createRun.mutate(undefined, { onSuccess: (r) => setOpenRun(r.id) })}>
          {createRun.isPending ? 'Working it out…' : 'Run a dry run'}
        </button>
        {changed && <span className="muted" style={{ fontSize: 12 }}>Save the rule first.</span>}
        <span className="muted" style={{ fontSize: 12 }}>A dry run removes nothing; it lists what the rule would do now.</span>
      </div>
      {createRun.error && <p className="error">{apiErrorMessage(createRun.error)}</p>}

      <table className="admin-table" style={{ marginTop: 10 }}>
        <thead>
          <tr><th>When</th><th>By</th><th>Status</th><th>Sessions reduced</th><th>Sessions erased</th><th>Readings removed</th><th /></tr>
        </thead>
        <tbody>
          {(runs.data?.results ?? []).map((r) => (
            <tr key={r.id} className={openRun === r.id ? 'retention-row-open' : undefined}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.created_by ?? '—'}</td>
              <td>{STATUS_LABEL[r.status]}{r.approved_by ? ` (approved by ${r.approved_by})` : ''}</td>
              <td>{r.sessions_reduced}</td>
              <td>{r.sessions_erased}</td>
              <td>{r.readings_to_remove.toLocaleString()}</td>
              <td><button type="button" className="btn-secondary btn-small" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                {openRun === r.id ? 'Hide' : 'Open'}
              </button></td>
            </tr>
          ))}
          {!runs.isLoading && !runs.data?.results.length && (
            <tr><td colSpan={7} className="muted">No dry runs yet.</td></tr>
          )}
        </tbody>
      </table>
      {openRun != null && <RunDetail id={openRun} enabled={!!settings.data?.enabled} />}
    </div>
  )
}

function RunDetail({ id, enabled }: { id: number; enabled: boolean }) {
  const { data: run, error } = useDtPruneRun(id)
  const act = useDtPruneRunAction()
  if (error) return <p className="error">{apiErrorMessage(error)}</p>
  if (!run) return <p className="muted">Loading…</p>
  const done = run.status === 'done'
  return (
    <div className="retention-run">
      <h3>
        {done ? 'What was done' : 'What this run would do'}: {run.sessions_reduced} session(s) reduced,{' '}
        {run.sessions_erased} erased, {run.readings_to_remove.toLocaleString()} readings removed
      </h3>
      {run.error && <p className="error">{run.error}</p>}
      {run.status === 'planned' && (
        <div className="retention-actions">
          <button type="button" className="btn-primary btn-small" disabled={!enabled || act.isPending || !run.plan_total}
            onClick={() => {
              if (window.confirm(`Remove ${run.readings_to_remove.toLocaleString()} readings and erase ${run.sessions_erased} session(s)? This cannot be undone.`)) {
                act.mutate({ id, action: 'approve' })
              }
            }}>
            Approve and carry out
          </button>
          <button type="button" className="btn-secondary btn-small" disabled={act.isPending}
            onClick={() => act.mutate({ id, action: 'discard' })}>
            Discard
          </button>
          {!enabled && <span className="muted" style={{ fontSize: 12 }}>Switch retention on to approve.</span>}
        </div>
      )}
      {act.error && <p className="error">{apiErrorMessage(act.error)}</p>}
      <table className="admin-table">
        <thead>
          <tr><th>Session</th><th>Technology</th><th>Purpose</th><th>Drive date</th><th>Action</th><th>Readings removed</th><th>Squares</th></tr>
        </thead>
        <tbody>
          {done
            ? (run.records ?? []).map((r) => (
              <tr key={`${r.session_id}-${r.action}`}>
                <td>{r.name}</td><td>{r.tech}</td><td>{purposeLabel(r.purpose)}</td><td>{r.drive_date ?? '—'}</td>
                <td>{r.action === 'erased' ? 'Erased' : 'Reduced to summary'}</td><td>{r.readings_removed.toLocaleString()}</td><td>—</td>
              </tr>
            ))
            : (run.plan ?? []).map((p) => (
              <tr key={p.session_id}>
                <td>{p.name}</td><td>{p.tech}</td><td>{purposeLabel(p.purpose)}</td><td>{p.drive_date}</td>
                <td>{p.action === 'erased' ? 'Erase' : 'Reduce to summary'}</td>
                <td>{p.action === 'erased' ? 'all' : p.readings_removed.toLocaleString()}</td><td>{p.squares}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {!done && (run.plan_total ?? 0) > (run.plan?.length ?? 0) && (
        <p className="muted">Showing {run.plan?.length} of {run.plan_total} sessions.</p>
      )}
    </div>
  )
}
