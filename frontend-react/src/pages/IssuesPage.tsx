import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useCreateIssue, useDeleteIssue, useIssues, useSites, useUpdateIssue, useUsers } from '../api/queries'
import type { Issue, IssueSeverity, IssueStatus } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import SearchableSelect from '../components/SearchableSelect'
import { ISSUE_SEVERITY_LABELS, ISSUE_SEVERITY_ORDER, ISSUE_STATUS_LABELS, ISSUE_STATUS_ORDER } from '../lib/issueLabels'

// Global Issues list (2026-09-14) -- the Site/Sector Issue tracker's own
// top-level page, alongside the per-site "Site Issues" section on
// SiteDetailPage.tsx. Modeled after UsersPage.tsx's plain
// admin-page/admin-table pattern (a straightforward filterable list),
// NOT DtSessionHistoryPage.tsx's clustering/split-panel/compare
// complexity -- this page doesn't need any of that, it's a flat table
// with a create form and a couple of dropdown filters, same shape as
// Users/DT Bands/API Keys.
export default function IssuesPage() {
  const { user } = useAuth()
  const canManage = user?.role === 'superadmin' || user?.role === 'admin'

  const [statusFilter, setStatusFilter] = useState<IssueStatus | ''>('')
  const [assigneeFilter, setAssigneeFilter] = useState<number | ''>('')

  const { data: issues, isLoading, error } = useIssues({
    status: statusFilter || undefined,
    assignee: assigneeFilter || undefined,
  })
  const { data: sites } = useSites()
  // Only admins/superadmins can list users (UserViewSet.get_permissions
  // in core/views.py) -- a plain viewer can still see everyone's
  // assignee_name text in the table below, just not the assignee FILTER
  // dropdown or the per-row assignee picker, both of which need the
  // user list itself.
  const { data: users } = useUsers()

  const updateIssue = useUpdateIssue()
  const deleteIssue = useDeleteIssue()
  const createIssue = useCreateIssue()

  const [showAdd, setShowAdd] = useState(false)
  const [newSiteId, setNewSiteId] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newSeverity, setNewSeverity] = useState<IssueSeverity>('medium')
  const [addError, setAddError] = useState<string | null>(null)

  const siteOptions = useMemo(() => (sites ?? []).map((s) => `${s.name || s.id} (${s.id})`), [sites])
  const selectedSite = (sites ?? []).find((s) => s.id === newSiteId)
  const selectedSiteLabel = selectedSite ? `${selectedSite.name || selectedSite.id} (${selectedSite.id})` : ''

  function chooseSite(label: string) {
    const match = (sites ?? []).find((s) => `${s.name || s.id} (${s.id})` === label)
    setNewSiteId(match ? match.id : null)
  }

  async function handleCreate() {
    setAddError(null)
    if (!newSiteId) {
      setAddError('Choose a site.')
      return
    }
    if (!newTitle.trim()) {
      setAddError('Title is required.')
      return
    }
    try {
      await createIssue.mutateAsync({
        site: newSiteId,
        title: newTitle.trim(),
        description: newDescription.trim(),
        severity: newSeverity,
      })
      setNewSiteId(null)
      setNewTitle('')
      setNewDescription('')
      setNewSeverity('medium')
      setShowAdd(false)
    } catch (err) {
      setAddError(apiErrorMessage(err, 'Could not create issue.'))
    }
  }

  function handleStatusChange(issue: Issue, status: IssueStatus) {
    updateIssue.mutate({ id: issue.id, issue: { status } })
  }

  function handleAssigneeChange(issue: Issue, assigneeId: string) {
    updateIssue.mutate({ id: issue.id, issue: { assignee: assigneeId ? Number(assigneeId) : null } })
  }

  async function handleDelete(issue: Issue) {
    if (!window.confirm(`Delete issue "${issue.title}"? This cannot be undone.`)) return
    await deleteIssue.mutateAsync(issue.id)
  }

  if (isLoading) return <div className="page-status">Loading issues…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load issues.')}</div>

  return (
    <div className="admin-page">
      <h1>Issues</h1>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label>
          Status{' '}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IssueStatus | '')}>
            <option value="">All</option>
            {ISSUE_STATUS_ORDER.map((value) => (
              <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>
            ))}
          </select>
        </label>
        {canManage && (
          <label>
            Assignee{' '}
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Anyone</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.username}</option>
              ))}
            </select>
          </label>
        )}
        {canManage && !showAdd && (
          <button type="button" className="btn-primary btn-small" onClick={() => setShowAdd(true)}>
            + New Issue
          </button>
        )}
      </div>

      {showAdd && (
        <section>
          <h2>Add issue</h2>
          {addError && <div className="form-error">{addError}</div>}
          <div className="edit-grid">
            <label>
              Site
              <SearchableSelect
                value={selectedSiteLabel}
                onChange={chooseSite}
                options={siteOptions}
                placeholder="Choose a site…"
                searchPlaceholder="Search sites…"
                ariaLabel="Site"
              />
            </label>
            <label>
              Title
              <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </label>
            <label>
              Description (optional)
              <textarea rows={2} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
            </label>
            <label>
              Severity
              <select value={newSeverity} onChange={(e) => setNewSeverity(e.target.value as IssueSeverity)}>
                {ISSUE_SEVERITY_ORDER.map((value) => (
                  <option key={value} value={value}>{ISSUE_SEVERITY_LABELS[value]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="admin-page-actions">
            <button className="btn-secondary" onClick={() => { setShowAdd(false); setAddError(null) }} disabled={createIssue.isPending}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleCreate} disabled={createIssue.isPending}>
              {createIssue.isPending ? 'Creating…' : 'Create issue'}
            </button>
          </div>
        </section>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Title</th>
            <th>Severity</th>
            <th>Status</th>
            <th>Assignee</th>
            <th>Resolved By</th>
            <th>Created</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {(issues ?? []).map((issue) => (
            <tr key={issue.id}>
              <td>{issue.site_name ?? issue.site}</td>
              <td>
                {issue.title}
                {issue.description && <div className="muted">{issue.description}</div>}
              </td>
              <td>
                <span className={`issue-badge issue-${issue.severity}`}>{ISSUE_SEVERITY_LABELS[issue.severity]}</span>
              </td>
              <td>
                {canManage ? (
                  <select value={issue.status} onChange={(e) => handleStatusChange(issue, e.target.value as IssueStatus)}>
                    {ISSUE_STATUS_ORDER.map((value) => (
                      <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>
                    ))}
                  </select>
                ) : (
                  <span className={`issue-badge issue-${issue.status}`}>{ISSUE_STATUS_LABELS[issue.status]}</span>
                )}
              </td>
              <td>
                {canManage ? (
                  <select value={issue.assignee ?? ''} onChange={(e) => handleAssigneeChange(issue, e.target.value)}>
                    <option value="">Unassigned</option>
                    {(users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.username}</option>
                    ))}
                  </select>
                ) : (
                  issue.assignee_name ?? '—'
                )}
              </td>
              <td>{issue.resolved_by_activity_name?.name ?? '—'}</td>
              <td>{new Date(issue.created_at).toLocaleDateString()}</td>
              {canManage && (
                <td className="admin-table-actions">
                  <button className="btn-danger btn-small" onClick={() => handleDelete(issue)} disabled={deleteIssue.isPending}>
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
          {!issues?.length && (
            <tr>
              <td colSpan={canManage ? 8 : 7} className="page-status">No issues match these filters.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
