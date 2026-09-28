import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useAttachSessionToActivity,
  useCreateOptimizationActivity,
  useIssues,
  useLinkActivityReport,
  useOptimizationActivities,
  useRfReports,
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
  // Vendor report linking (2026-09-23, "need to relate and manage vendor
  // provided RNO report") -- only offered in 'existing' mode with an
  // activity actually picked, since link_report() needs a real activity
  // id to POST to; a brand-new activity can be linked to a report the
  // next time this modal is reopened on it in 'existing' mode.
  const { data: reports } = useRfReports()
  const linkReport = useLinkActivityReport()
  const [reportId, setReportId] = useState<number | null>(null)
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<number>>(new Set())
  const [reportLinkError, setReportLinkError] = useState<string | null>(null)
  const [reportLinkedMsg, setReportLinkedMsg] = useState<string | null>(null)
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
  const selectedReport = (reports ?? []).find((r) => r.id === reportId)

  function chooseExisting(label: string) {
    const match = (activities ?? []).find((a) => composeLabel(a) === label)
    setActivityId(match ? match.id : null)
  }

  function toggleChange(id: number) {
    setSelectedChangeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleLinkReport() {
    if (!selectedActivity || reportId == null) return
    setReportLinkError(null)
    setReportLinkedMsg(null)
    try {
      await linkReport.mutateAsync({
        activityId: selectedActivity.id,
        reportId,
        antennaChangeIds: [...selectedChangeIds],
      })
      setReportLinkedMsg('Report linked.')
      setSelectedChangeIds(new Set())
    } catch (err) {
      setReportLinkError(apiErrorMessage(err, 'Could not link this report.'))
    }
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
            ) : null}

            {/* Vendor report link (2026-09-23, "need to relate and manage
                vendor provided RNO report") -- only offered once an
                EXISTING activity is picked (link_report() needs a real
                activity id); a brand-new activity created below gets its
                report linked the next time this modal is reopened on it. */}
            {mode === 'existing' && selectedActivity && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 2 }}>
                <label style={{ marginBottom: 4 }}>
                  Link vendor report (optional)
                  <select value={reportId ?? ''} onChange={(e) => setReportId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Choose a report…</option>
                    {(reports ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{r.lot_name}{r.network ? ` (${r.network})` : ''}</option>
                    ))}
                  </select>
                  {!reports?.length && <span className="muted">No RF reports imported yet.</span>}
                </label>
                {selectedActivity.source_report && (
                  <p className="muted" style={{ fontSize: 11 }}>
                    Currently linked to <strong>{selectedActivity.source_report.lot_name}</strong>
                    {selectedActivity.antenna_changes.length > 0 ? ` (${selectedActivity.antenna_changes.length} antenna change(s))` : ''}.
                  </p>
                )}
                {selectedReport && selectedReport.antenna_changes_detail.length > 0 && (
                  <div style={{ maxHeight: 120, overflowY: 'auto', margin: '6px 0' }}>
                    {selectedReport.antenna_changes_detail.map((c) => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, fontSize: 11 }}>
                        <input type="checkbox" checked={selectedChangeIds.has(c.id)} onChange={() => toggleChange(c.id)} />
                        {c.cell_name}: {c.before_change} → {c.after_change}
                      </label>
                    ))}
                  </div>
                )}
                {reportLinkError && <div className="form-error">{reportLinkError}</div>}
                {reportLinkedMsg && <p className="muted" style={{ fontSize: 11 }}>{reportLinkedMsg}</p>}
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  disabled={reportId == null || linkReport.isPending}
                  onClick={handleLinkReport}
                >
                  {linkReport.isPending ? 'Linking…' : 'Link Report'}
                </button>
              </div>
            )}

            {mode === 'new' && (
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
