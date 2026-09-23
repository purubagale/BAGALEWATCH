import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { apiErrorMessage, apiJson } from '../api/client'
import {
  DT_SESSION_GC_TIME,
  useDeleteDtSession,
  useDeleteDtSessionAttachment,
  useDtServingCells,
  useDtSession,
  useDtSessions,
  useSites,
  useUpdateDtSessionRemarks,
  useUploadDtSessionAttachments,
} from '../api/queries'
import type { DtSessionDetail, DtSessionListItem } from '../api/types'
import { isAllowed } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import AttachActivityModal, { ACTIVITY_ROLE_LABELS } from '../components/AttachActivityModal'
import DtCompareMap, { MAX_COMPARE } from '../components/DtCompareMap'
import DtCompareDeltaMap from '../components/DtCompareDeltaMap'
import DtCompareReportView from '../components/DtCompareReportView'
import DtCallDownloadSummary from '../components/DtCallDownloadSummary'
import DtCoverageMap from '../components/DtCoverageMap'
import { assignDtCompareOrder } from '../lib/dtCompareAssignment'
import { clusterDtSessionsByArea, type DtSessionCluster } from '../lib/dtSessionClustering'

// Split out of the former single-page DtDataManagerPage.tsx (2026-08-09
// request: "manage upload, manage session and explore in different sub
// menu item... not in different tab on same page") — this page is just
// the old 'history' tab's content, now its own route. See
// DtUploadPage.tsx/DtExplorePage.tsx for the other two former tabs.

export default function DtSessionHistoryPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const [compareIds, setCompareIds] = useState<Set<number>>(new Set())
  const [comparing, setComparing] = useState(false)
  // Delta (before/after) compare mode (2026-09-12) -- ADDITIVE to the
  // existing Overlay mode (DtCompareMap), only ever selectable with
  // EXACTLY 2 sessions checked and the same tech; see the compareMode
  // effect + deltaAvailable/deltaTechMismatch below for how that's
  // enforced. deltaSwapped lets the user flip the auto before/after
  // guess (lib/dtCompareAssignment.ts) for the currently-selected pair.
  const [compareMode, setCompareMode] = useState<'overlay' | 'delta'>('overlay')
  const [deltaSwapped, setDeltaSwapped] = useState(false)
  // Export Report modal (2026-09-12) -- a print-friendly summary of the
  // current Delta comparison, for handing to management or attaching to
  // a closed complaint ticket. Only ever opened while Delta mode is
  // active with data loaded (see the 'Export Report' button below), so
  // it can reuse the exact same before/after pair Delta mode is showing.
  const [reportOpen, setReportOpen] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  // "Latest per area" clustering (2026-09-12 request: RF engineers
  // re-drive the same area repeatedly over weeks/months and the list
  // gets buried under old re-tests of the same spot). Defaults ON since
  // that's the common case; every old session stays one click away via
  // the per-cluster "+N earlier here" expander below, nothing is hidden
  // permanently. See lib/dtSessionClustering.ts for the grouping logic.
  const [latestOnly, setLatestOnly] = useState(true)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  // Drag-to-resize + collapsible right panel for the session-list/detail
  // split (2026-07-30 request, follow-up to the overlap fix — the fixed
  // 360px/1fr grid worked but the user wanted manual control over the
  // split, plus a way to fully hide the detail panel so the session list
  // can use that space when it's not needed).
  const [historyLeftWidth, setHistoryLeftWidth] = useState(360)
  const [historyRightCollapsed, setHistoryRightCollapsed] = useState(false)
  const historyDragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Optimization Activities (2026-09-12) -- linking a session to a named
  // before/after-change effort. `linkingSession` drives the per-row
  // "Link" action's modal; the upload-time suggestion banner below opens
  // the same modal pre-filled instead, via `suggestionOpen`.
  const [linkingSession, setLinkingSession] = useState<DtSessionListItem | null>(null)
  const [suggestionOpen, setSuggestionOpen] = useState(false)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)

  const { data: sites } = useSites()
  const { data: sessions, isLoading: sessionsLoading, error: sessionsError } = useDtSessions()

  // DtUploadPage lands here with `?session=<id>` right after a save (see
  // its doSave()) — this used to just be `setSelectedSessionId(created.id)`
  // in shared page state, now it's a query param since Upload and History
  // are separate routes. Only acts once per navigation (doesn't fight a
  // user who deliberately clicks a different row afterward), and doesn't
  // strip the param — same convention SiteDetailPage.tsx uses for its own
  // one-shot `?edit=1`/`?addSector=1` params, except stripping isn't
  // needed here since re-selecting the same session on refresh is harmless.
  useEffect(() => {
    const raw = searchParams.get('session')
    if (!raw) return
    const id = Number(raw)
    if (Number.isFinite(id)) {
      setSelectedSessionId(id)
      setComparing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // ~1km nearby-site tagging (2026-07-30) — id -> name lookup so the
  // History table/search can show/match real site names instead of raw
  // ids. Resolved client-side from the already-loaded site list (not
  // trusted from any name snapshotted into a session's meta at upload
  // time), so renamed/re-imported sites always show their current name.
  const siteNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const site of sites ?? []) map.set(site.id, site.name || site.id)
    return map
  }, [sites])

  // Client-side filter — session lists are small (tens to low hundreds),
  // so no backend query param needed. Matches session name OR any tagged
  // nearby site's id/name, per the user's explicit ask that the ~1km tag
  // make "future search" easier.
  const searchFilteredSessions = useMemo(() => {
    const q = historySearch.trim().toLowerCase()
    if (!q || !sessions) return sessions
    return sessions.filter((s) => {
      if (s.name.toLowerCase().includes(q)) return true
      const ids = s.meta?.nearby_site_ids ?? []
      return ids.some((id) => id.toLowerCase().includes(q) || (siteNameById.get(id) ?? '').toLowerCase().includes(q))
    })
  }, [sessions, historySearch, siteNameById])

  // "Latest per area" clustering is computed over the SEARCH-FILTERED
  // list, not the full session list — chosen over the alternative
  // (cluster the whole list, then filter the clustered result by search)
  // because it keeps every visible row relevant to what was typed: if a
  // search matches 3 sessions from one area and there's a 4th sibling
  // session elsewhere that doesn't match, showing that unrelated 4th
  // session's date just because it shares a cluster with matches would
  // be surprising. The tradeoff is that "latest" here means latest AMONG
  // MATCHES, not latest overall for that area — acceptable since a
  // search is already the user narrowing to a specific thing they want.
  const clusters = useMemo(() => clusterDtSessionsByArea(searchFilteredSessions ?? []), [searchFilteredSessions])
  const clusterBySessionId = useMemo(() => {
    const map = new Map<number, DtSessionCluster>()
    for (const c of clusters) for (const s of c.sessions) map.set(s.id, c)
    return map
  }, [clusters])

  // Upload-time link-suggestion banner (2026-09-12): DtUploadPage lands
  // here with `?session=<id>` right after a save (see the effect above).
  // If that just-saved session has no activities yet AND shares an area
  // cluster with at least one OTHER existing session, offer to link it
  // as a follow-up rather than requiring the engineer to remember to do
  // that from the row action. Deliberately clustered over the FULL
  // (unfiltered by search) session list -- unlike `clusters` above, this
  // banner's relevance shouldn't depend on whatever's currently typed in
  // the search box.
  const justSavedSessionId = useMemo(() => {
    const raw = searchParams.get('session')
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  }, [searchParams])
  const allAreaClusters = useMemo(() => clusterDtSessionsByArea(sessions ?? []), [sessions])
  const linkSuggestion = useMemo(() => {
    if (justSavedSessionId == null || !sessions) return null
    const session = sessions.find((s) => s.id === justSavedSessionId)
    if (!session || session.activities.length > 0) return null
    const cluster = allAreaClusters.find((c) => c.sessions.some((s) => s.id === justSavedSessionId))
    if (!cluster || cluster.sessions.length < 2) return null
    const siblings = cluster.sessions.filter((s) => s.id !== justSavedSessionId)
    // Prefer pre-selecting an activity a cluster-sibling already belongs
    // to (most likely to be "the same effort") over defaulting to
    // create-new; fall back to a suggested name derived from the first
    // nearby site's name when no sibling has one yet.
    const siblingWithActivity = siblings.find((s) => s.activities.length > 0)
    const suggestedActivityId = siblingWithActivity ? siblingWithActivity.activities[0].id : null
    const siteId = session.meta?.nearby_site_ids?.[0]
    const suggestedName = suggestedActivityId == null && siteId ? (siteNameById.get(siteId) ?? '') : ''
    return { session, siblingCount: siblings.length, suggestedActivityId, suggestedName }
  }, [justSavedSessionId, sessions, allAreaClusters, siteNameById])

  // Final row list the table renders. With latestOnly off, or with no
  // search-filtered sessions, this is just searchFilteredSessions
  // unchanged (today's behavior, byte-for-byte). With latestOnly on,
  // walk the search-filtered list in its existing order and, the first
  // time a cluster is encountered, emit only its latest session — plus
  // the rest of that cluster right after, but only if the user has
  // expanded it via the "+N earlier here" chip (see the table body).
  const visibleSessions = useMemo(() => {
    if (!searchFilteredSessions || !latestOnly) return searchFilteredSessions
    const emitted = new Set<string>()
    const result: typeof searchFilteredSessions = []
    for (const s of searchFilteredSessions) {
      const cluster = clusterBySessionId.get(s.id)
      if (!cluster) {
        result.push(s)
        continue
      }
      if (emitted.has(cluster.key)) continue
      emitted.add(cluster.key)
      result.push(cluster.sessions[0])
      if (cluster.sessions.length > 1 && expandedClusters.has(cluster.key)) {
        result.push(...cluster.sessions.slice(1))
      }
    }
    return result
  }, [searchFilteredSessions, latestOnly, clusterBySessionId, expandedClusters])
  const { data: sessionDetail, isLoading: detailLoading } = useDtSession(selectedSessionId ?? undefined)
  const { data: servingCells } = useDtServingCells(selectedSessionId ?? undefined)
  const deleteSession = useDeleteDtSession()

  // Remarks + attachments (2026-09-07: "add a provision of attaching
  // multiple files related to the saved session in dt session history
  // and also add provision to provide remarks/comments on the session
  // if needed"). Same admin/superadmin write tier as delete (both are
  // IsAdminOrSuperadmin on the backend) — canDelete is reused below
  // rather than adding a second identical permission check.
  const [remarksDraft, setRemarksDraft] = useState('')
  const [editingRemarks, setEditingRemarks] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const updateRemarks = useUpdateDtSessionRemarks(selectedSessionId ?? undefined)
  const uploadAttachments = useUploadDtSessionAttachments(selectedSessionId ?? undefined)
  const deleteAttachment = useDeleteDtSessionAttachment(selectedSessionId ?? undefined)

  // Reset the draft/edit state whenever the selected session changes (or
  // its remarks are refetched) rather than leaving a stale draft from a
  // previously-viewed session sitting in the textarea.
  useEffect(() => {
    setRemarksDraft(sessionDetail?.remarks ?? '')
    setEditingRemarks(false)
    setAttachmentError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, sessionDetail?.remarks])

  // Session comparison (Phase 4d), ported from bts_monitor.html's
  // rsrpOpenCompare() — checkbox 2+ sessions, fetch each one's full
  // detail (reuses the same GET /dt-sessions/{id}/ the single-session
  // view already uses, just fired in parallel for each checked row via
  // react-query's useQueries instead of v1's IndexedDB transactions),
  // then hand them to DtCompareMap for the overlaid rendering + stats.
  const compareQueries = useQueries({
    queries: [...compareIds].map((id) => ({
      queryKey: ['dt-session', id],
      queryFn: () => apiJson<DtSessionDetail>(`/api/v2/dt-sessions/${id}/`),
      enabled: comparing,
      // Same shortened gcTime as useDtSession (2026-08-15 memory audit) —
      // Compare Sessions is the worst case for this: up to MAX_COMPARE=4
      // full large sample arrays fetched and cached at once.
      gcTime: DT_SESSION_GC_TIME,
    })),
  })
  const compareSessions = compareQueries.map((q) => q.data).filter((s): s is DtSessionDetail => !!s)
  const compareLoading = comparing && compareQueries.some((q) => q.isLoading)

  function toggleCompare(id: number) {
    setCompareIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < MAX_COMPARE) {
        next.add(id)
      }
      return next
    })
  }

  // Delta mode eligibility (2026-09-12) -- computed straight off the
  // already-loaded session LIST items (tech/date/activities are all
  // list-serializer fields), not the full-detail compareSessions fetch
  // above, so the mode toggle can show/enable itself immediately as soon
  // as exactly 2 rows are checked, without waiting on a samples fetch
  // Delta mode doesn't even need (see useDtSessionCompare's own comment
  // in queries.ts for why Delta is cheap regardless of session size).
  const selectedCompareSessions = useMemo(
    () => (sessions ?? []).filter((s) => compareIds.has(s.id)),
    [sessions, compareIds],
  )
  const exactlyTwoSelected = selectedCompareSessions.length === 2
  const deltaTechMismatch = exactlyTwoSelected && selectedCompareSessions[0].tech !== selectedCompareSessions[1].tech
  const deltaAvailable = exactlyTwoSelected && !deltaTechMismatch
  const deltaOrder = useMemo(
    () => (exactlyTwoSelected ? assignDtCompareOrder(selectedCompareSessions[0], selectedCompareSessions[1]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exactlyTwoSelected, selectedCompareSessions[0]?.id, selectedCompareSessions[1]?.id],
  )

  // Falls back to Overlay whenever the selection stops being exactly 2
  // (or becomes tech-mismatched) so Delta's UI never lingers showing for
  // a selection it no longer applies to. Also clears a stale swap when
  // the selected PAIR itself changes, so flipping session A for a
  // different one doesn't carry over the previous pair's swap.
  useEffect(() => {
    if (!deltaAvailable) setCompareMode('overlay')
  }, [deltaAvailable])
  useEffect(() => {
    setDeltaSwapped(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompareSessions[0]?.id, selectedCompareSessions[1]?.id])

  // Expand/collapse one area cluster's older sessions (see the
  // "+N earlier here" chip in the table body below).
  function toggleClusterExpanded(key: string) {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Drag-to-resize for the left/right split. Plain window mousemove/
  // mouseup listeners (no library) — addEventListener and
  // removeEventListener below both close over the SAME function
  // references from this render, so cleanup is self-consistent even
  // though these aren't wrapped in useCallback/useRef.
  function onHistoryResizeMouseDown(e: ReactMouseEvent) {
    historyDragRef.current = { startX: e.clientX, startWidth: historyLeftWidth }
    window.addEventListener('mousemove', onHistoryResizeMouseMove)
    window.addEventListener('mouseup', onHistoryResizeMouseUp)
  }
  function onHistoryResizeMouseMove(e: MouseEvent) {
    if (!historyDragRef.current) return
    const delta = e.clientX - historyDragRef.current.startX
    setHistoryLeftWidth(Math.min(720, Math.max(220, historyDragRef.current.startWidth + delta)))
  }
  function onHistoryResizeMouseUp() {
    historyDragRef.current = null
    window.removeEventListener('mousemove', onHistoryResizeMouseMove)
    window.removeEventListener('mouseup', onHistoryResizeMouseUp)
  }

  const canDelete = !!user && isAllowed(user.role, user.permissions.rsrpmgr, 'delete')

  if (!user) return null

  return (
    // No max-width cap on this page (unlike most .admin-page pages, which
    // keep the 1100px default for narrow forms/tables) — 2026-07-30: user
    // circled a large dead black area to the right of the map on a wide
    // monitor. Real cause was this page's own 1300px cap on the outer
    // wrapper, capping the whole flex row (table + resize handle + detail
    // panel) well short of the actual browser width; the detail panel's
    // `flex: 1` was already set up to fill any space it's given, it just
    // was never given the room. Removing the cap here lets it actually do
    // that — no separate "expand" toggle needed for this, since flex
    // already grows into whatever width the outer container allows.
    <div className="admin-page" style={{ maxWidth: 'none' }}>
      <h1>DT Session History</h1>
      <p className="muted">Browse and compare saved drive-test sessions on the coverage map.</p>

      {/* Upload-time link-suggestion banner (2026-09-12) -- see the
          linkSuggestion memo above for exactly what triggers this.
          Dismissing just hides it for this page visit (suggestionDismissed
          is plain component state, nothing persisted). */}
      {linkSuggestion && !suggestionDismissed && (
        <div className="dt-activity-suggestion-banner">
          <span>
            Found {linkSuggestion.siblingCount} earlier session{linkSuggestion.siblingCount === 1 ? '' : 's'} near this route — link as a follow-up?
          </span>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button type="button" className="btn-primary btn-small" onClick={() => setSuggestionOpen(true)}>
              Link…
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={() => setSuggestionDismissed(true)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Flex, not grid — needed a draggable divider plus a fully-
          collapsible right panel, neither of which mixes well with a
          fixed grid-template-columns string. showRight is true whenever
          there's something to show on the right at all; historyRightCollapsed
          is a separate, user-controlled "hide it anyway" state layered on
          top, distinct from the drag-resize width. */}
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {/* minWidth: 0 is load-bearing here, not decorative — a flex
            item's automatic minimum width defaults to its content's
            min-content size, which for a <table> means "wide enough to
            never wrap." Adding the Nearby Sites column made the table
            wider than its old 360px column, and without this override it
            grew past that and visually bled into the right-hand detail
            panel — reported as "overlapping." report-table-wrap (below)
            is the scroll container that actually catches the overflow
            once the item is correctly capped at its assigned width. */}
        <div
          style={{
            width: (selectedSessionId || comparing) && !historyRightCollapsed ? historyLeftWidth : '100%',
            minWidth: 0,
            flexShrink: 0,
          }}
        >
          {sessionsLoading && <div className="page-status">Loading sessions…</div>}
          {sessionsError && <div className="page-status page-status-error">{apiErrorMessage(sessionsError, 'Could not load sessions.')}</div>}
          {!sessionsLoading && !sessions?.length && <div className="page-status">No saved DT sessions yet.</div>}
          {!!sessions?.length && (
            <input
              type="text"
              className="dt-history-search-input"
              placeholder="Search by session or nearby site (id/name)…"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          )}
          {!!sessions?.length && (
            // "Latest only" toggle (2026-09-12) — reuses .sites-active-toggle,
            // the same pill-switch look SitesPage.tsx's map filter panel
            // uses for "Only active"/"Show name", for a consistent look
            // rather than inventing a new toggle style for this page.
            <label className="sites-active-toggle" style={{ marginBottom: 8 }} title="Show only the latest session for each drive-test area; older re-tests stay one click away">
              <input
                type="checkbox"
                checked={latestOnly}
                onChange={(e) => setLatestOnly(e.target.checked)}
              />
              <span className="sites-active-toggle-track"><span className="sites-active-toggle-thumb" /></span>
              Latest only
            </label>
          )}
          {compareIds.size >= 2 && (
            <div style={{ marginBottom: 8 }}>
              {/* Delta mode toggle (2026-09-12) -- only ever shown with
                  EXACTLY 2 sessions checked (Delta has no meaning for 1,
                  3 or 4). Same tech required too; shown disabled with an
                  explanatory tooltip rather than hidden outright when 2
                  are checked but techs differ, so it's clear WHY it's
                  unavailable rather than looking like it's missing. */}
              {exactlyTwoSelected && (
                <div className="feat-tabs" style={{ borderBottom: 'none', marginBottom: 6 }}>
                  <div className={compareMode === 'overlay' ? 'feat-tab active' : 'feat-tab'} onClick={() => setCompareMode('overlay')}>
                    Overlay
                  </div>
                  <div
                    className={compareMode === 'delta' ? 'feat-tab active' : 'feat-tab'}
                    style={deltaTechMismatch ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    title={
                      deltaTechMismatch
                        ? `Sessions must be the same technology to compare (got ${selectedCompareSessions[0]?.tech} and ${selectedCompareSessions[1]?.tech}).`
                        : 'Numeric before/after diff, binned into a shared grid'
                    }
                    onClick={() => {
                      if (!deltaTechMismatch) setCompareMode('delta')
                    }}
                  >
                    Delta (before/after)
                  </div>
                </div>
              )}
              {!exactlyTwoSelected && (compareIds.size === 1 || compareIds.size > 2) && (
                <p className="muted" style={{ fontSize: 10, margin: '0 0 6px' }} title="Select exactly 2 sessions to compare before/after">
                  Select exactly 2 sessions for Delta (before/after) comparison.
                </p>
              )}
              <button
                type="button"
                className="btn-primary btn-small"
                onClick={() => {
                  setComparing(true)
                  setSelectedSessionId(null)
                }}
              >
                ⚖ Compare {compareIds.size} Sessions
              </button>
            </div>
          )}
          {!!sessions?.length && (
            // report-table-wrap is the existing overflow-x:auto scroll
            // container this codebase already uses for wide admin-tables
            // (Phase 3 reporting suite) — the Nearby Sites column made
            // this particular table wider than its 360px grid track, and
            // without this wrapper the overflow wasn't clipped/scrolled,
            // it just bled into the panel next to it.
            <div className="report-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Tech</th>
                  <th>Date</th>
                  <th>Remarks</th>
                  <th>Attachments</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {!visibleSessions?.length && (
                  <tr>
                    <td colSpan={7} className="page-status">No sessions match “{historySearch}”.</td>
                  </tr>
                )}
                {visibleSessions?.map((s) => {
                  // Cluster info only matters (and is only computed here)
                  // while "Latest only" is on — with it off this is all
                  // undefined and every row renders exactly as before.
                  const cluster = latestOnly ? clusterBySessionId.get(s.id) : undefined
                  const isClusterHead = !!cluster && cluster.sessions[0].id === s.id
                  const isClusterSibling = !!cluster && !isClusterHead
                  return (
                  <tr
                    key={s.id}
                    className={[s.id === selectedSessionId ? 'row-selected' : '', isClusterSibling ? 'dt-cluster-child-row' : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={compareIds.has(s.id)}
                        disabled={!compareIds.has(s.id) && compareIds.size >= MAX_COMPARE}
                        onChange={() => toggleCompare(s.id)}
                        title={compareIds.size >= MAX_COMPARE && !compareIds.has(s.id) ? `Compare up to ${MAX_COMPARE} sessions at once` : 'Select for comparison'}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="dt-session-link"
                        onClick={() => {
                          setSelectedSessionId(s.id)
                          setComparing(false)
                        }}
                      >
                        {isClusterSibling ? '↳ ' : ''}
                        {s.name}
                      </button>
                      {cluster && isClusterHead && cluster.sessions.length > 1 && (
                        <button
                          type="button"
                          className="dt-cluster-chip"
                          onClick={() => toggleClusterExpanded(cluster.key)}
                          title="Older sessions saved for this same area"
                        >
                          {expandedClusters.has(cluster.key)
                            ? 'Hide earlier sessions'
                            : `+${cluster.sessions.length - 1} earlier here`}
                        </button>
                      )}
                      {/* Optimization Activity badges (2026-09-12) -- a
                          session usually belongs to 0 or 1 activity;
                          rendered as a small pill row rather than a table
                          column so it doesn't widen every row when empty. */}
                      {s.activities.length > 0 && (
                        <div className="dt-activity-badges">
                          {s.activities.map((a) => (
                            <span
                              key={`${a.id}-${a.role}`}
                              className="dt-activity-badge"
                              title={`${a.name} · ${ACTIVITY_ROLE_LABELS[a.role]}`}
                            >
                              {a.name} · {ACTIVITY_ROLE_LABELS[a.role]}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{s.tech}</td>
                    <td>{s.date ?? '—'}</td>
                    <td className="dt-remarks-cell" title={s.remarks || undefined}>
                      {s.remarks ? (s.remarks.length > 40 ? `${s.remarks.slice(0, 40)}…` : s.remarks) : <span className="muted">—</span>}
                    </td>
                    <td>{s.attachment_count > 0 ? `📎 ${s.attachment_count}` : <span className="muted">—</span>}</td>
                    <td className="admin-table-actions">
                      {canDelete && (
                        <button
                          className="btn-secondary btn-small"
                          type="button"
                          style={{ marginRight: 6 }}
                          title="Link to an optimization activity"
                          onClick={() => setLinkingSession(s)}
                        >
                          🔗 Link
                        </button>
                      )}
                      {canDelete && (
                        <button
                          className="btn-danger btn-small"
                          type="button"
                          onClick={() => {
                            if (confirm(`Delete session "${s.name}"? This cannot be undone.`)) {
                              deleteSession.mutate(s.id)
                              if (selectedSessionId === s.id) setSelectedSessionId(null)
                              setCompareIds((prev) => {
                                const next = new Set(prev)
                                next.delete(s.id)
                                return next
                              })
                            }
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {(selectedSessionId || comparing) && !historyRightCollapsed && (
          <>
            <div
              className="dt-history-resize-handle"
              onMouseDown={onHistoryResizeMouseDown}
              title="Drag to resize"
            />
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => setHistoryRightCollapsed(true)}
                  title="Hide this panel and let the session list use the space"
                >
                  Hide panel ▸
                </button>
              </div>
              {comparing ? (
                <div>
                  {compareMode === 'delta' && deltaAvailable && deltaOrder ? (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                        {/* Export Report (2026-09-12) -- opens DtCompareReportView.tsx,
                            a print-friendly (Print > Save as PDF) summary of this same
                            before/after pair, for handing to management or attaching to
                            a closed complaint ticket. There's no PDF library anywhere in
                            this stack, so this deliberately leans on the browser's own
                            print-to-PDF rather than adding one for a first version. */}
                        <button type="button" className="btn-secondary btn-small" onClick={() => setReportOpen(true)}>
                          📄 Export Report
                        </button>
                      </div>
                      <DtCompareDeltaMap
                        before={deltaSwapped ? deltaOrder.after : deltaOrder.before}
                        after={deltaSwapped ? deltaOrder.before : deltaOrder.after}
                        reason={deltaOrder.reason}
                        onSwap={() => setDeltaSwapped((v) => !v)}
                      />
                      {reportOpen && (
                        <DtCompareReportView
                          before={deltaSwapped ? deltaOrder.after : deltaOrder.before}
                          after={deltaSwapped ? deltaOrder.before : deltaOrder.after}
                          onClose={() => setReportOpen(false)}
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      {compareLoading && <div className="page-status">Loading sessions…</div>}
                      {!compareLoading && compareSessions.length >= 2 && <DtCompareMap sessions={compareSessions} />}
                    </>
                  )}
                </div>
              ) : (
                selectedSessionId && (
                  <div>
                    {detailLoading && <div className="page-status">Loading session…</div>}
                    {sessionDetail && (
                      // flex column + explicit gap here (not just relying on the
                      // cards' own margin-bottom / the map wrap's margin-top)
                      // so the gap between the summary cards and the metric-tab
                      // row can never collapse/shrink to the point the tab
                      // pills visually crowd the cards above — reported
                      // 2026-07-30 as the tabs "overlapping" the cards.
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', margin: 0 }}>
                          <div className="report-card">
                            <div className="report-card-val">{sessionDetail.sample_count}</div>
                            <div className="report-card-label">GPS Points</div>
                          </div>
                          <div className="report-card">
                            <div className="report-card-val">{sessionDetail.meta?.routeKm ?? '—'} km</div>
                            <div className="report-card-label">Route Distance</div>
                          </div>
                          <div className="report-card">
                            <div className="report-card-val">{sessionDetail.meta?.avgRsrp ?? '—'}</div>
                            <div className="report-card-label">Avg Signal (dBm)</div>
                          </div>
                          <div className="report-card">
                            <div className="report-card-val">{sessionDetail.uploaded_by_name ?? '—'}</div>
                            <div className="report-card-label">Uploaded By</div>
                          </div>
                        </div>
                        <DtCoverageMap samples={sessionDetail.samples} tech={sessionDetail.tech} servingCells={servingCells} />
                        <DtCallDownloadSummary
                          callSummary={sessionDetail.meta?.callSummary}
                          downloadSummary={sessionDetail.meta?.downloadSummary}
                        />

                        {/* Remarks (2026-09-07) — a single free-text field,
                            not a comment thread ("if needed" in the
                            request), editable in place. Read-only text for
                            anyone without write access, matching how the
                            rest of this page gates destructive/edit
                            actions on canDelete. */}
                        <div className="dt-session-remarks">
                          <div className="dt-session-remarks-header">
                            <h3>Remarks</h3>
                            {canDelete && !editingRemarks && (
                              <button type="button" className="btn-secondary btn-small" onClick={() => setEditingRemarks(true)}>
                                {sessionDetail.remarks ? 'Edit' : 'Add remarks'}
                              </button>
                            )}
                          </div>
                          {editingRemarks ? (
                            <div>
                              <textarea
                                className="dt-session-remarks-textarea"
                                value={remarksDraft}
                                onChange={(e) => setRemarksDraft(e.target.value)}
                                rows={3}
                                placeholder="Notes about this session…"
                              />
                              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                <button
                                  type="button"
                                  className="btn-primary btn-small"
                                  disabled={updateRemarks.isPending}
                                  onClick={() => updateRemarks.mutate(remarksDraft, { onSuccess: () => setEditingRemarks(false) })}
                                >
                                  {updateRemarks.isPending ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary btn-small"
                                  onClick={() => {
                                    setRemarksDraft(sessionDetail.remarks ?? '')
                                    setEditingRemarks(false)
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                              {updateRemarks.isError && (
                                <div className="page-status page-status-error">{apiErrorMessage(updateRemarks.error, 'Could not save remarks.')}</div>
                              )}
                            </div>
                          ) : (
                            <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                              {sessionDetail.remarks || 'No remarks yet.'}
                            </p>
                          )}
                        </div>

                        {/* Attachments (2026-09-07) — arbitrary supporting
                            files, NOT the original .trp/.gpx (those are
                            parsed client-side and never uploaded at all).
                            Upload accepts multiple files at once via the
                            native file picker's `multiple` attribute. */}
                        <div className="dt-session-attachments">
                          <div className="dt-session-remarks-header">
                            <h3>Attachments</h3>
                            {canDelete && (
                              <>
                                <button
                                  type="button"
                                  className="btn-secondary btn-small"
                                  disabled={uploadAttachments.isPending}
                                  onClick={() => attachmentInputRef.current?.click()}
                                >
                                  {uploadAttachments.isPending ? 'Uploading…' : '+ Add files'}
                                </button>
                                <input
                                  ref={attachmentInputRef}
                                  type="file"
                                  multiple
                                  style={{ display: 'none' }}
                                  onChange={(e) => {
                                    const files = e.target.files ? Array.from(e.target.files) : []
                                    e.target.value = '' // allow re-selecting the same file(s) later
                                    if (!files.length) return
                                    setAttachmentError(null)
                                    uploadAttachments.mutate(files, {
                                      onError: (err) => setAttachmentError(apiErrorMessage(err, 'Could not upload file(s).')),
                                    })
                                  }}
                                />
                              </>
                            )}
                          </div>
                          {attachmentError && <div className="page-status page-status-error">{attachmentError}</div>}
                          {!sessionDetail.attachments.length ? (
                            <p className="muted">No files attached.</p>
                          ) : (
                            <ul className="dt-session-attachments-list">
                              {sessionDetail.attachments.map((a) => (
                                <li key={a.id}>
                                  {a.url ? (
                                    <a href={a.url} target="_blank" rel="noreferrer">{a.original_filename || `Attachment ${a.id}`}</a>
                                  ) : (
                                    <span>{a.original_filename || `Attachment ${a.id}`}</span>
                                  )}
                                  {a.size_bytes != null && <span className="muted"> ({(a.size_bytes / 1024).toFixed(0)} KB)</span>}
                                  {a.uploaded_by_name && <span className="muted"> — uploaded by {a.uploaded_by_name}</span>}
                                  {canDelete && (
                                    <button
                                      type="button"
                                      className="btn-danger btn-small"
                                      style={{ marginLeft: 8 }}
                                      onClick={() => {
                                        if (confirm(`Remove "${a.original_filename}"? This cannot be undone.`)) {
                                          deleteAttachment.mutate(a.id)
                                        }
                                      }}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          </>
        )}

        {(selectedSessionId || comparing) && historyRightCollapsed && (
          <button
            type="button"
            className="dt-history-expand-tab"
            onClick={() => setHistoryRightCollapsed(false)}
            title="Show detail panel"
          >
            ◂
          </button>
        )}
      </div>

      {linkingSession && (
        <AttachActivityModal session={linkingSession} onClose={() => setLinkingSession(null)} />
      )}
      {suggestionOpen && linkSuggestion && (
        <AttachActivityModal
          session={linkSuggestion.session}
          initialActivityId={linkSuggestion.suggestedActivityId}
          initialNewName={linkSuggestion.suggestedName}
          onClose={() => setSuggestionOpen(false)}
        />
      )}
    </div>
  )
}
