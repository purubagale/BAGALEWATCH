import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useSites, useTree, useUpdateTree } from '../api/queries'
import { isAllowed } from '../api/types'
import type { TreeFolder, TreeState } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import RowLimitSelect, { DEFAULT_ROW_LIMIT } from '../components/RowLimitSelect'

// This is a standalone admin page rather than an inline edit-mode on the
// existing read-only SidebarTree (components/SidebarTree.tsx, driven by
// store/treeStore.ts) — that component renders the *default* Province/
// District/Site auto-tree via virtual scroll across all ~4,700 sites, a
// different view from the custom folder tree being edited here. Wiring
// "edit mode" directly into that virtualized component, with live
// drag-and-drop reassignment across 4,700 rows, is a larger follow-up;
// this page gets the same end result (create/edit/delete folders at any
// depth, assign/unassign sites, toggle which tree is active) via a
// simpler form-based UI, matching /api/v2/tree/'s full-replace contract.
//
// Folders nest to arbitrary depth (redesigned 2026-07-27, user-confirmed,
// beyond v1 parity — v1's own tree is a fixed 2-level folder/subfolder
// split). The tree-shaped helpers below (findFolder/updateFolderTree/
// removeFolderFromTree/addChildToFolder/collectFolderIds/flattenFolders)
// replace what used to be flat folder+subfolder array operations.
function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function findFolder(folders: TreeFolder[], id: string): TreeFolder | undefined {
  for (const f of folders) {
    if (f.id === id) return f
    const found = findFolder(f.children, id)
    if (found) return found
  }
  return undefined
}

function updateFolderTree(folders: TreeFolder[], targetId: string, update: (f: TreeFolder) => TreeFolder): TreeFolder[] {
  return folders.map((f) => (f.id === targetId ? update(f) : { ...f, children: updateFolderTree(f.children, targetId, update) }))
}

function removeFolderFromTree(folders: TreeFolder[], targetId: string): TreeFolder[] {
  return folders.filter((f) => f.id !== targetId).map((f) => ({ ...f, children: removeFolderFromTree(f.children, targetId) }))
}

function addChildToFolder(folders: TreeFolder[], parentId: string, child: TreeFolder): TreeFolder[] {
  return folders.map((f) =>
    f.id === parentId ? { ...f, children: [...f.children, child] } : { ...f, children: addChildToFolder(f.children, parentId, child) },
  )
}

function collectFolderIds(folder: TreeFolder): string[] {
  return [folder.id, ...folder.children.flatMap(collectFolderIds)]
}

function flattenFolders(folders: TreeFolder[], depth = 0): { id: string; label: string }[] {
  return folders.flatMap((f) => [{ id: f.id, label: `${'—  '.repeat(depth)}${f.name}` }, ...flattenFolders(f.children, depth + 1)])
}

function FolderNode({
  folder,
  depth,
  canUpdate,
  canWrite,
  canDelete,
  onRename,
  onAddSubfolder,
  onDelete,
}: {
  folder: TreeFolder
  depth: number
  canUpdate: boolean
  canWrite: boolean
  canDelete: boolean
  onRename: (id: string) => void
  onAddSubfolder: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="tree-folder-card" style={{ marginLeft: depth * 20 }}>
      <div className="tree-folder-card-header">
        <strong>{folder.name}</strong>
        {canUpdate && (
          <button className="btn-secondary btn-small" onClick={() => onRename(folder.id)}>
            Rename
          </button>
        )}
        {canWrite && (
          <button className="btn-secondary btn-small" onClick={() => onAddSubfolder(folder.id)}>
            + Subfolder
          </button>
        )}
        {canDelete && (
          <button className="btn-danger btn-small" onClick={() => onDelete(folder.id)}>
            Delete
          </button>
        )}
      </div>
      {folder.children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          depth={depth + 1}
          canUpdate={canUpdate}
          canWrite={canWrite}
          canDelete={canDelete}
          onRename={onRename}
          onAddSubfolder={onAddSubfolder}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

export default function TreeAdminPage() {
  const { user } = useAuth()
  const { data: tree, isLoading, error } = useTree()
  const { data: sites } = useSites()
  const updateTree = useUpdateTree()

  const [draft, setDraft] = useState<TreeState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [siteQuery, setSiteQuery] = useState('')
  const [assignFolderId, setAssignFolderId] = useState('')
  // 2026-08-07 memory-audit finding, fixed: "Assigned sites" below has no
  // inherent cap — nothing stops it from covering all 4,700+ sites if a
  // custom tree is fully adopted. Same shared RowLimitSelect pattern as
  // every other capped table in this app.
  const [assignedRowLimit, setAssignedRowLimit] = useState(DEFAULT_ROW_LIMIT)

  const working = draft ?? tree ?? null

  const siteMatches = useMemo(() => {
    if (!sites || siteQuery.trim().length < 2) return []
    const q = siteQuery.trim().toLowerCase()
    return sites.filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 20)
  }, [sites, siteQuery])

  const sitesById = useMemo(() => new Map((sites ?? []).map((s) => [s.id, s])), [sites])

  if (isLoading) return <div className="page-status">Loading tree structure…</div>
  if (error) return <div className="page-status page-status-error">Could not load the tree structure.</div>
  if (!user || !working) return null

  const canUpdate = isAllowed(user.role, user.permissions.tree, 'update')
  const canWrite = isAllowed(user.role, user.permissions.tree, 'write')
  const canDelete = isAllowed(user.role, user.permissions.tree, 'delete')

  function ensureDraft(): TreeState {
    if (draft) return draft
    const d = working!
    setDraft(d)
    setSaved(false)
    return d
  }

  function addFolder() {
    const d = ensureDraft()
    const name = window.prompt('New folder name?')
    if (!name) return
    const folder: TreeFolder = { id: makeId('folder'), name, icon: '', lat: null, lng: null, children: [] }
    setDraft({ ...d, folders: [...d.folders, folder] })
  }

  function addSubfolder(parentId: string) {
    const d = ensureDraft()
    const name = window.prompt('New subfolder name?')
    if (!name) return
    const child: TreeFolder = { id: makeId('sub'), name, icon: '', lat: null, lng: null, children: [] }
    setDraft({ ...d, folders: addChildToFolder(d.folders, parentId, child) })
  }

  function renameFolder(folderId: string) {
    const d = ensureDraft()
    const folder = findFolder(d.folders, folderId)
    const name = window.prompt('Rename folder', folder?.name)
    if (!name) return
    setDraft({ ...d, folders: updateFolderTree(d.folders, folderId, (f) => ({ ...f, name })) })
  }

  function deleteFolder(folderId: string) {
    const d = ensureDraft()
    const folder = findFolder(d.folders, folderId)
    if (!folder) return
    if (!window.confirm('Delete this folder and everything inside it? Sites assigned to it (or any nested subfolder) will become unassigned.')) return
    const removedIds = new Set(collectFolderIds(folder))
    setDraft({
      ...d,
      folders: removeFolderFromTree(d.folders, folderId),
      assignments: Object.fromEntries(Object.entries(d.assignments).filter(([, fid]) => !(fid && removedIds.has(fid)))),
    })
    if (assignFolderId && removedIds.has(assignFolderId)) setAssignFolderId('')
  }

  function assignSite(siteId: string) {
    if (!assignFolderId) return
    const d = ensureDraft()
    setDraft({ ...d, assignments: { ...d.assignments, [siteId]: assignFolderId } })
    setSiteQuery('')
  }

  function unassignSite(siteId: string) {
    const d = ensureDraft()
    const { [siteId]: _removed, ...rest } = d.assignments
    setDraft({ ...d, assignments: rest })
  }

  function toggleActive(active: boolean) {
    const d = ensureDraft()
    setDraft({ ...d, active })
  }

  async function handleSave() {
    if (!draft) return
    setSaveError(null)
    setSaved(false)
    try {
      await updateTree.mutateAsync(draft)
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the tree structure.'))
    }
  }

  function discard() {
    setDraft(null)
    setSaveError(null)
    setSaved(false)
  }

  const assignedEntries = Object.entries(working.assignments).filter((entry): entry is [string, string] => !!entry[1])
  const flatFolders = flattenFolders(working.folders)
  const folderLabelById = new Map(flatFolders.map((f) => [f.id, f.label.trim()]))

  return (
    <div className="admin-page">
      <h1>Tree Structure</h1>
      <p className="muted">
        Custom folders/subfolders (any depth) for organizing sites outside the default Region/District auto-tree.
      </p>
      {saveError && <div className="form-error">{saveError}</div>}
      {saved && <div className="form-success">Saved.</div>}

      <label className="tree-active-toggle">
        <input type="checkbox" checked={working.active} disabled={!canUpdate} onChange={(e) => toggleActive(e.target.checked)} />
        Use this custom tree instead of the default Region/District auto-tree
      </label>

      <section>
        <h2>
          Folders
          {canWrite && (
            <button className="btn-secondary btn-small" onClick={addFolder} style={{ marginLeft: 12 }}>
              + Add folder
            </button>
          )}
        </h2>
        {working.folders.length === 0 && <div className="muted">No custom folders yet.</div>}
        {working.folders.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            depth={0}
            canUpdate={canUpdate}
            canWrite={canWrite}
            canDelete={canDelete}
            onRename={renameFolder}
            onAddSubfolder={addSubfolder}
            onDelete={deleteFolder}
          />
        ))}
      </section>

      {canUpdate && flatFolders.length > 0 && (
        <section>
          <h2>Assign a site</h2>
          <div className="tree-assign-row">
            <select value={assignFolderId} onChange={(e) => setAssignFolderId(e.target.value)}>
              <option value="">Folder…</option>
              {flatFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              placeholder="Search site ID or name…"
              value={siteQuery}
              onChange={(e) => setSiteQuery(e.target.value)}
              disabled={!assignFolderId}
            />
          </div>
          {siteMatches.length > 0 && (
            <ul className="tree-site-matches">
              {siteMatches.map((s) => (
                <li key={s.id}>
                  <span>
                    {s.id} — {s.name}
                  </span>
                  <button className="btn-secondary btn-small" onClick={() => assignSite(s.id)}>
                    Assign
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2>
          Assigned sites ({assignedEntries.length})
          {assignedEntries.length > 0 && (
            <span style={{ marginLeft: 12 }}>
              <RowLimitSelect value={assignedRowLimit} onChange={setAssignedRowLimit} unit="sites" />
            </span>
          )}
        </h2>
        {assignedEntries.length === 0 ? (
          <div className="muted">No sites assigned to custom folders yet.</div>
        ) : (
          <>
          {assignedEntries.length > assignedRowLimit && (
            <div className="muted" style={{ marginBottom: 6 }}>
              Showing the first {assignedRowLimit} of {assignedEntries.length} assigned sites — choose a higher row
              limit above to see more.
            </div>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Folder</th>
                {canUpdate && <th />}
              </tr>
            </thead>
            <tbody>
              {assignedEntries.slice(0, assignedRowLimit).map(([siteId, folderId]) => (
                <tr key={siteId}>
                  <td>
                    {siteId} {sitesById.get(siteId)?.name ? `— ${sitesById.get(siteId)!.name}` : ''}
                  </td>
                  <td>{folderLabelById.get(folderId) ?? '—'}</td>
                  {canUpdate && (
                    <td>
                      <button className="btn-secondary btn-small" onClick={() => unassignSite(siteId)}>
                        Unassign
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </section>

      {draft && (
        <div className="admin-page-actions">
          <button className="btn-secondary" onClick={discard} disabled={updateTree.isPending}>
            Discard changes
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={updateTree.isPending}>
            {updateTree.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  )
}
