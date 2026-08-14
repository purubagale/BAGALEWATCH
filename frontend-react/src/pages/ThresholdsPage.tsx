import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useDeleteThreshold, useThresholds, useUpdateThresholds } from '../api/queries'
import { isAllowed } from '../api/types'
import type { KpiThreshold, ThresholdMap } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const emptyThreshold: KpiThreshold = { warn: null, crit: null, hi: false, max: null, unit: '' }

function toNum(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export default function ThresholdsPage() {
  const { user } = useAuth()
  const { data: thresholds, isLoading, error } = useThresholds()
  const updateThresholds = useUpdateThresholds()
  const deleteThreshold = useDeleteThreshold()

  const [draft, setDraft] = useState<ThresholdMap>({})
  const [newKey, setNewKey] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Seed the editable draft from the fetched data whenever it (re)loads —
  // e.g. after a save invalidates and refetches. Not a controlled/
  // uncontrolled mismatch concern since thresholds is a small, admin-only
  // dataset, not something that changes from other users mid-edit often
  // enough to need optimistic-lock handling here.
  useEffect(() => {
    if (thresholds) setDraft(thresholds)
  }, [thresholds])

  if (isLoading) return <div className="page-status">Loading thresholds…</div>
  if (error) return <div className="page-status page-status-error">Could not load thresholds.</div>
  if (!user) return null

  const canUpdate = isAllowed(user.role, user.permissions.thresholds, 'update')
  const canWrite = isAllowed(user.role, user.permissions.thresholds, 'write')

  function setEntry(key: string, patch: Partial<KpiThreshold>) {
    setDraft((d) => ({ ...d, [key]: { ...(d[key] ?? emptyThreshold), ...patch } }))
    setSaved(false)
  }

  function addKey() {
    const key = newKey.trim()
    if (!key || draft[key]) return
    setDraft((d) => ({ ...d, [key]: { ...emptyThreshold } }))
    setNewKey('')
  }

  async function handleSave() {
    setSaveError(null)
    setSaved(false)
    try {
      // warn/crit/max are stored as raw strings while editing (see the
      // onChange handlers below) — coerced to real numbers here, right
      // before the API call. Same fix as SiteDetailPage's normalizeForSave:
      // converting on every keystroke strips the trailing "." out of a
      // decimal before the next digit can land.
      const normalized: ThresholdMap = Object.fromEntries(
        Object.entries(draft).map(([key, t]) => [key, { ...t, warn: toNum(t.warn), crit: toNum(t.crit), max: toNum(t.max) }]),
      )
      // Send the full draft — simpler than diffing against the original
      // for a dataset this small, and PUT only touches the keys present
      // in the body (see ThresholdsView), so this can never wipe out a
      // key some other admin added moments ago.
      await updateThresholds.mutateAsync(normalized)
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save thresholds.'))
    }
  }

  async function handleDelete(key: string) {
    if (!window.confirm(`Delete the "${key}" threshold? This cannot be undone.`)) return
    setDeleteError(null)
    try {
      await deleteThreshold.mutateAsync(key)
    } catch (err) {
      setDeleteError(apiErrorMessage(err, `Could not delete "${key}".`))
    }
  }

  const keys = Object.keys(draft).sort()

  return (
    <div className="admin-page">
      <h1>KPI Thresholds</h1>
      <p className="muted">Warn/critical bounds used for KPI status coloring across the dashboard.</p>
      {saveError && <div className="form-error">{saveError}</div>}
      {deleteError && <div className="form-error">{deleteError}</div>}
      {saved && <div className="form-success">Saved.</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>KPI Key</th>
            <th>Warn</th>
            <th>Crit</th>
            <th>Higher is better</th>
            <th>Max</th>
            <th>Unit</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const t = draft[key]
            return (
              <tr key={key}>
                <td className="admin-table-key">{key}</td>
                <td>
                  <input
                    type="number" step="any" disabled={!canUpdate}
                    value={t.warn ?? ''}
                    onChange={(e) => setEntry(key, { warn: e.target.value as unknown as number | null })}
                  />
                </td>
                <td>
                  <input
                    type="number" step="any" disabled={!canUpdate}
                    value={t.crit ?? ''}
                    onChange={(e) => setEntry(key, { crit: e.target.value as unknown as number | null })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox" disabled={!canUpdate}
                    checked={t.hi}
                    onChange={(e) => setEntry(key, { hi: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="number" step="any" disabled={!canUpdate}
                    value={t.max ?? ''}
                    onChange={(e) => setEntry(key, { max: e.target.value as unknown as number | null })}
                  />
                </td>
                <td>
                  <input
                    disabled={!canUpdate}
                    value={t.unit}
                    onChange={(e) => setEntry(key, { unit: e.target.value })}
                  />
                </td>
                {canWrite && (
                  <td>
                    <button
                      className="btn-danger btn-small"
                      onClick={() => handleDelete(key)}
                      disabled={deleteThreshold.isPending}
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
          {canWrite && (
            <tr>
              <td>
                <input
                  placeholder="new kpi key (e.g. callDrop)"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addKey()}
                />
              </td>
              <td colSpan={6}>
                <button className="btn-secondary btn-small" onClick={addKey} disabled={!newKey.trim()}>
                  + Add
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canUpdate && (
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleSave} disabled={updateThresholds.isPending}>
            {updateThresholds.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  )
}
