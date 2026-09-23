import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useAttachSessionToActivity,
  useCreateOptimizationActivity,
  useIssues,
  useOptimizationActivities,
} from '../api/queries'
import type { DtSessionListItem, OptimizationActivityRole } from '../api/types'
import SearchableSelect from './SearchableSelect'

// Human-readable labels matching OptimizationActivitySession.ROLE_CHOICES
// on the backend (core/models.py) exactly.
export const ACTIVITY_ROLE_LABELS: Record<OptimizationActivityRole, string> = {
  baseline: 'Baseline (pre)',
  after_change: 'After Change',
  re_verify: 'Re-verify',
}

// Link-one-session-to-an-activity modal (2026-09-12) — used both from
// DtSessionHistoryPage's per-row "Link" action and from the upload-time
// link-suggestion banner (see that page for how initialActivityId/
// initialNewName get pre-filled in the suggestion case). Same
// modal-overlay/modal-box chrome RelocateConfirmModal.tsx already
// established for this app (a plain per-page overlay div against shared
// CSS classes, not a shared <Modal> component) — reused as-is rather
// than inventing a new pattern for one more dialog.
export default function AttachActivityModal({
  session,
  onClose,
  initialActivityId = null,
  initialRole = 'baseline',
  initialNewName = '',
}: {
  session: DtSessionListItem
  onClose: () => void
  initialActivityId?: number | null
  initialRole?: OptimizationActivityRole
  initialNewName?: string
}) {
  const { data: activities } = useOptimizationActivities()
  const attach = useAttachSessionToActivity()
  const createActivity = useCreateOptimizationActivity()
  // Open Issues this new activity could resolve (2026-09-14) -- only
  // fetched/shown in 'new' mode, see resolveIssueId's own comment below
  // for why this is create-only.
  const { data: openIssues } = useIssues({ status: 'open' })

  const [mode, setMode] = useState<'existing' | 'new'>(initialActivityId != null ? 'existing' : 'new')
  const [activityId, setActivityId] = useState<number | null>(initialActivityId)
  const [newName, setNewName] = useState(initialNewName)
  const [newNotes, setNewNotes] = useState('')
  const [role, setRole] = useState<OptimizationActivityRole>(initialRole)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Optional link to an existing open Issue this activity resolves
  // (2026-09-14 request) -- passed as OptimizationActivityWrite's
  // `resolve_issue_id` on create(); see OptimizationActivitySerializer.
  // create()'s docstring in the backend for the resulting side effect
  // (issue moved to resolved_by_activity=this activity, status='resolved').
  // Create-only: OptimizationActivityViewSet has no update/partial_update
  // at all, so this picker only makes sense in 'new' mode.
  const [resolveIssueId, setResolveIssueId] = useState<number | null>(null)

  const pending = attach.isPending || createActivity.isPending

  // SearchableSelect (SitesPage.tsx's Region/District picker) only knows
  // plain strings — it's both the option's value AND its displayed label.
  // Activity names aren't guaranteed unique, so each option is composed
  // as "<name> (#<id>)" and unpacked back to an id on choose(), rather
  // than adding an id-aware variant of that shared component for this
  // one dropdown.
  const composeLabel = (a: { id: number; name: string }) => `${a.name} (#${a.id})`
  const activityOptions = useMemo(() => (activities ?? []).map(composeLabel), [activities])
  const selectedActivity = (activities ?? []).find((a) => a.id === activityId)
  const selectedLabel = selectedActivity ? composeLabel(selectedActivity) : ''

  function chooseExisting(label: string) {
    const match = (activities ?? []).find((a) => composeLabel(a) === label)
    setActivityId(match ? match.id : null)
  }

  async function handleSubmit() {
    setError(null)
    try {
      let targetActivityId = activityId
      if (mode === 'new') {
        if (!newName.trim()) {
          setError('Name is required.')
          return
        }
        const created = await createActivity.mutateAsync({
          name: newName.trim(),
          notes: newNotes.trim(),
          resolve_issue_id: resolveIssueId,
        })
        targetActivityId = created.id
      }
      if (targetActivityId == null) {
        setError('Choose an activity.')
        return
      }
      await attach.mutateAsync({ activityId: targetActivityId, sessionId: session.id, role, note: note.trim() })
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not link this session.'))
    }
  }

  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 440 }}>
        <div className="modal-hdr">
          <h2>Link "{session.name}" to an activity</h2>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className={mode === 'existing' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
              onClick={() => setMode('existing')}
            >
              Existing activity
            </button>
            <button
              type="button"
              className={mode === 'new' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
              onClick={() => setMode('new')}
            >
              + New activity
            </button>
          </div>

          {/* .edit-grid label>input/select — the same "label wraps its
              field, styled by .edit-grid label" pattern AddSiteModal.tsx
              and AdvancedSiteSearchModal.tsx already use for every modal
              form field in this app; a single-column grid here since this
              form is one field per row, not a multi-column layout. */}
          <div className="edit-grid" style={{ gridTemplateColumns: '1fr' }}>
            {mode === 'existing' ? (
              <label>
                Activity
                <SearchableSelect
                  value={selectedLabel}
                  onChange={chooseExisting}
                  options={activityOptions}
                  placeholder="Choose an activity…"
                  searchPlaceholder="Search activities…"
                  ariaLabel="Optimization activity"
                />
                {!activities?.length && <span className="muted">No activities yet — create one instead.</span>}
              </label>
            ) : (
              <>
                <label>
                  Name
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Chitwan RSRP complaint — antenna tilt, Aug 2026"
                    autoFocus
                  />
                </label>
                <label>
                  Notes (optional)
                  <textarea
                    rows={2}
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="What changed and why…"
                  />
                </label>
                <label>
                  Resolves issue (optional)
                  <select
                    value={resolveIssueId ?? ''}
                    onChange={(e) => setResolveIssueId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">None</option>
                    {(openIssues ?? []).map((issue) => (
                      <option key={issue.id} value={issue.id}>
                        {issue.title} ({issue.site_name ?? issue.site})
                      </option>
                    ))}
                  </select>
                  {!openIssues?.length && <span className="muted">No open issues to link.</span>}
                </label>
              </>
            )}

            <label>
              This session's role
              <select value={role} onChange={(e) => setRole(e.target.value as OptimizationActivityRole)}>
                {(Object.entries(ACTIVITY_ROLE_LABELS) as [OptimizationActivityRole, string][]).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>

            <label>
              Note for this link (optional)
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. tilt changed 2° down on this run"
              />
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary btn-small" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-small" onClick={handleSubmit} disabled={pending}>
            {pending ? 'Linking…' : 'Link Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
