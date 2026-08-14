import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useDtBands, useUpdateDtBands } from '../api/queries'
import type { DtBandRow, DtBandsMap } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { ALL_METRICS } from '../lib/dtBands'

// Editable coverage-band colors/ranges for the DT maps (2026-08-05) — per
// explicit user request: "add a feature to add, edit, delete index
// details/legend to display in map and changing color also." Confirmed
// via AskUserQuestion: shared/server-saved (not per-browser), a
// dedicated page (this one), superadmin-or-admin editable.
//
// Gated directly on `user.role`, NOT the per-menu permissions matrix —
// deliberately, matching UsersPage's own gating. This feature has no v1
// equivalent (see core/models.py's DtBand docstring), so there's no
// CRUD_MENUS entry to hang a matrix checkbox on; adding one anyway would
// just recreate the exact "checkbox that doesn't actually gate anything"
// trap the old 'topology' permission key turned out to be (removed the
// same day this page was built, see PermissionsPage.tsx).
const emptyRow: DtBandRow = { label: '', min: 0, max: 0, color: '#84cc16' }

function toNum(v: unknown): number {
  if (v === '' || v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export default function DtBandsPage() {
  const { user } = useAuth()
  const { data: bands, isLoading, error } = useDtBands()
  const updateBands = useUpdateDtBands()

  const [draft, setDraft] = useState<DtBandsMap>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Seed the editable draft from the fetched data — same "reload from
  // server on (re)fetch" pattern as ThresholdsPage, not something that
  // needs optimistic-lock handling for an admin-only config screen.
  useEffect(() => {
    if (bands) setDraft(bands)
  }, [bands])

  if (isLoading) return <div className="page-status">Loading band colors…</div>
  if (error) return <div className="page-status page-status-error">Could not load band colors.</div>
  if (!user) return null

  const canEdit = user.role === 'superadmin' || user.role === 'admin'

  // Fixed tag order (matches ALL_METRICS / every DT map's own tab order)
  // rather than however keys happen to land in the fetched object — and
  // guarantees all 7 tags always have a section to edit, even one with
  // zero rows (shouldn't normally happen after the seed migration, but
  // an admin who deletes every band for a tag should still see it here
  // to add new ones back, not have the whole section vanish).
  const tags = ALL_METRICS.map((m) => m.tag)

  function setRow(tag: string, index: number, patch: Partial<DtBandRow>) {
    setDraft((d) => {
      const rows = [...(d[tag] ?? [])]
      rows[index] = { ...rows[index], ...patch }
      return { ...d, [tag]: rows }
    })
    setSaved(false)
  }

  function addRow(tag: string) {
    setDraft((d) => ({ ...d, [tag]: [...(d[tag] ?? []), { ...emptyRow }] }))
    setSaved(false)
  }

  function deleteRow(tag: string, index: number) {
    setDraft((d) => ({ ...d, [tag]: (d[tag] ?? []).filter((_, i) => i !== index) }))
    setSaved(false)
  }

  function moveRow(tag: string, index: number, dir: -1 | 1) {
    setDraft((d) => {
      const rows = [...(d[tag] ?? [])]
      const target = index + dir
      if (target < 0 || target >= rows.length) return d
      ;[rows[index], rows[target]] = [rows[target], rows[index]]
      return { ...d, [tag]: rows }
    })
    setSaved(false)
  }

  async function handleSave() {
    setSaveError(null)
    setSaved(false)
    try {
      // min/max are edited as raw strings (see the onChange handlers
      // below) — coerced to real numbers right before the API call, same
      // "convert at save time, not every keystroke" fix ThresholdsPage
      // and SiteDetailPage both already use (converting mid-typing strips
      // a trailing "." or "-" before the next digit can land).
      const normalized: DtBandsMap = Object.fromEntries(
        Object.entries(draft).map(([tag, rows]) => [
          tag,
          rows.map((r) => ({ ...r, min: toNum(r.min), max: toNum(r.max), label: r.label.trim(), color: r.color.trim() })),
        ]),
      )
      await updateBands.mutateAsync(normalized)
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save band colors.'))
    }
  }

  return (
    <div className="admin-page">
      <h1>Band Colors</h1>
      <p className="muted">
        Coverage-band ranges and colors used for dots and legends across Explore, Compare Sessions, and single-session
        coverage maps. One editable table per metric type — order matters (the first band whose range contains a value
        wins), so use ↑/↓ to reorder if you insert a band in the middle.
      </p>
      {saveError && <div className="form-error">{saveError}</div>}
      {saved && <div className="form-success">Saved.</div>}

      {tags.map((tag) => {
        const rows = draft[tag] ?? []
        return (
          <div key={tag} style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>{tag}</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Color</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <input disabled={!canEdit} value={row.label} onChange={(e) => setRow(tag, i, { label: e.target.value })} />
                    </td>
                    <td>
                      <input
                        type="number" step="any" disabled={!canEdit}
                        value={row.min}
                        onChange={(e) => setRow(tag, i, { min: e.target.value as unknown as number })}
                      />
                    </td>
                    <td>
                      <input
                        type="number" step="any" disabled={!canEdit}
                        value={row.max}
                        onChange={(e) => setRow(tag, i, { max: e.target.value as unknown as number })}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="color" disabled={!canEdit}
                          value={/^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : '#000000'}
                          onChange={(e) => setRow(tag, i, { color: e.target.value })}
                          style={{ width: 32, height: 26, padding: 0, border: '1px solid #2a2f3a', background: 'none' }}
                        />
                        <input
                          disabled={!canEdit}
                          value={row.color}
                          onChange={(e) => setRow(tag, i, { color: e.target.value })}
                          style={{ width: 80 }}
                        />
                      </div>
                    </td>
                    {canEdit && (
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button type="button" className="btn-secondary btn-small" onClick={() => moveRow(tag, i, -1)} disabled={i === 0} title="Move up">↑</button>
                          <button type="button" className="btn-secondary btn-small" onClick={() => moveRow(tag, i, 1)} disabled={i === rows.length - 1} title="Move down">↓</button>
                          <button type="button" className="btn-danger btn-small" onClick={() => deleteRow(tag, i)}>Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 5 : 4} className="muted">No bands defined for {tag} — every value will show as no-data grey until you add one.</td>
                  </tr>
                )}
                {canEdit && (
                  <tr>
                    <td colSpan={5}>
                      <button type="button" className="btn-secondary btn-small" onClick={() => addRow(tag)}>
                        + Add band
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      })}

      {canEdit && (
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleSave} disabled={updateBands.isPending}>
            {updateBands.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  )
}
