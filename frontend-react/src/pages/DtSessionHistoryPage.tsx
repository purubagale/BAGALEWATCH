import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { apiErrorMessage, apiJson } from '../api/client'
import { useDeleteDtSession, useDtSession, useDtSessions, useSites } from '../api/queries'
import type { DtSessionDetail, DtSessionListItem } from '../api/types'
import { isAllowed } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import DtCompareMap, { MAX_COMPARE } from '../components/DtCompareMap'
import DtCoverageMap from '../components/DtCoverageMap'

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
  const [historySearch, setHistorySearch] = useState('')
  // Drag-to-resize + collapsible right panel for the session-list/detail
  // split (2026-07-30 request, follow-up to the overlap fix — the fixed
  // 360px/1fr grid worked but the user wanted manual control over the
  // split, plus a way to fully hide the detail panel so the session list
  // can use that space when it's not needed).
  const [historyLeftWidth, setHistoryLeftWidth] = useState(360)
  const [historyRightCollapsed, setHistoryRightCollapsed] = useState(false)
  const historyDragRef = useRef<{ startX: number; startWidth: number } | null>(null)

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

  function nearbySiteLabels(s: DtSessionListItem): string[] {
    return (s.meta?.nearby_site_ids ?? []).map((id) => siteNameById.get(id) ?? id)
  }

  // Client-side filter — session lists are small (tens to low hundreds),
  // so no backend query param needed. Matches session name OR any tagged
  // nearby site's id/name, per the user's explicit ask that the ~1km tag
  // make "future search" easier.
  const visibleSessions = useMemo(() => {
    const q = historySearch.trim().toLowerCase()
    if (!q || !sessions) return sessions
    return sessions.filter((s) => {
      if (s.name.toLowerCase().includes(q)) return true
      const ids = s.meta?.nearby_site_ids ?? []
      return ids.some((id) => id.toLowerCase().includes(q) || (siteNameById.get(id) ?? '').toLowerCase().includes(q))
    })
  }, [sessions, historySearch, siteNameById])
  const { data: sessionDetail, isLoading: detailLoading } = useDtSession(selectedSessionId ?? undefined)
  const deleteSession = useDeleteDtSession()

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
          {compareIds.size >= 2 && (
            <div style={{ marginBottom: 8 }}>
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
                  <th>Pts</th>
                  <th>Nearby Sites</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {!visibleSessions?.length && (
                  <tr>
                    <td colSpan={7} className="page-status">No sessions match “{historySearch}”.</td>
                  </tr>
                )}
                {visibleSessions?.map((s) => (
                  <tr key={s.id} className={s.id === selectedSessionId ? 'row-selected' : ''}>
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
                        {s.name}
                      </button>
                    </td>
                    <td>{s.tech}</td>
                    <td>{s.date ?? '—'}</td>
                    <td>{s.sample_count}</td>
                    <td className="dt-nearby-sites-cell">
                      {(() => {
                        const labels = nearbySiteLabels(s)
                        if (s.meta?.nearby_site_ids === undefined) return <span title="Saved before this feature — run the backfill_nearby_sites command to tag it.">—</span>
                        if (!labels.length) return <span>none</span>
                        const shown = labels.slice(0, 2).join(', ')
                        const extra = labels.length > 2 ? ` +${labels.length - 2}` : ''
                        return <span title={labels.join(', ')}>{shown}{extra}</span>
                      })()}
                    </td>
                    <td className="admin-table-actions">
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
                ))}
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
                  {compareLoading && <div className="page-status">Loading sessions…</div>}
                  {!compareLoading && compareSessions.length >= 2 && <DtCompareMap sessions={compareSessions} />}
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
                        <DtCoverageMap samples={sessionDetail.samples} tech={sessionDetail.tech} />
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
    </div>
  )
}
