import { useMemo } from 'react'
import { apiErrorMessage } from '../api/client'
import { useDtSessionCompare } from '../api/queries'
import type { DtCompareCell, DtSessionListItem } from '../api/types'
import { metricsForTech } from '../lib/dtBands'
import { deadbandFor, deltaStatus, directionFor } from '../lib/dtDelta'

const WORST_CELL_LIMIT = 15

// Signed classification badge for a summary-table row — pairs a color
// with a ✓/✗/– SYMBOL (not color alone), per the report's own
// requirement that it stay legible printed in greyscale, not just on a
// lit screen.
function StatusBadge({ status }: { status: ReturnType<typeof deltaStatus> }) {
  const map: Record<string, { symbol: string; color: string; label: string }> = {
    improved: { symbol: '✓', color: '#16a34a', label: 'Improved' },
    degraded: { symbol: '✗', color: '#dc2626', label: 'Degraded' },
    unchanged: { symbol: '–', color: '#6b7280', label: 'Unchanged' },
    'no-data': { symbol: '?', color: '#9ca3af', label: 'No data' },
  }
  const entry = map[status]
  return (
    <span style={{ color: entry.color, fontWeight: 700 }} title={entry.label}>
      {entry.symbol} {entry.label}
    </span>
  )
}

function formatSigned(value: number | null | undefined, unit: string): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value}${unit}`
}

/** Print-friendly before/after Delta report (2026-09-12) — the "hand a
 * summary to management / attach to a closed complaint ticket" use case
 * DtCompareDeltaMap's interactive map doesn't serve on its own (a live
 * Leaflet map is nothing to print, and the map alone doesn't answer
 * "where does coverage still need work" as a static list). Deliberately
 * NOT a PDF export — there is no PDF library anywhere in this stack
 * (checked backend requirements.txt + frontend package.json) and adding
 * one for a first version was overkill next to just giving the browser's
 * own Print > Save as PDF something clean to work with (see the
 * `.dt-report-print-area` rules in App.css).
 *
 * Takes the same `before`/`after` DtSessionListItem pair
 * DtCompareDeltaMap.tsx takes and re-runs useDtSessionCompare() itself
 * rather than requiring the parent to lift the query result up — the
 * query key (['dt-session-compare', a, b]) is identical to the one
 * DtCompareDeltaMap already fetched for the same pair, so react-query
 * serves this from cache instantly with no second network round trip
 * as long as the map is (or very recently was) mounted for the same
 * pair, which is the only time this report is ever opened from. */
export default function DtCompareReportView({
  before,
  after,
  onClose,
}: {
  before: DtSessionListItem
  after: DtSessionListItem
  onClose: () => void
}) {
  const { data, isLoading, error } = useDtSessionCompare(before.id, after.id)

  const metrics = useMemo(() => {
    if (!data) return []
    const all = metricsForTech(before.tech)
    return all.filter((m) => data.metrics.includes(m.key))
  }, [data, before.tech])

  // "Primary metric" for the worst-cells ranking = the tech's first
  // metric per compare()'s own `metrics` ordering (RSRP/RxLevel/RSCP in
  // every tech), matching the task's explicit definition of "worst"
  // rather than inventing a separate notion of severity.
  const primaryMetric = metrics[0]

  const worstCells = useMemo(() => {
    if (!data || !primaryMetric) return []
    const deadband = deadbandFor(primaryMetric.key)
    const direction = directionFor(primaryMetric.key)
    const degraded = data.cells.filter(
      (c) => deltaStatus(c.delta[primaryMetric.key], deadband, direction) === 'degraded',
    )
    // Worst first = most negative SIGNED delta (direction-adjusted), so
    // this sorts correctly for both "higher is better" metrics and
    // rx_qual's "lower is better" scale, same signed convention
    // deltaStatus/compare()'s own summary percentages already use.
    degraded.sort((x, y) => {
      const sx = (x.delta[primaryMetric.key] ?? 0) * direction
      const sy = (y.delta[primaryMetric.key] ?? 0) * direction
      return sx - sy
    })
    return degraded.slice(0, WORST_CELL_LIMIT)
  }, [data, primaryMetric])

  // Shared Optimization Activity, if both sessions were linked to the
  // same one — a session usually carries 0-1 activities (see
  // DtSessionActivityTag's own comment in api/types.ts), so this is just
  // an intersection-by-id over two short arrays, not a real join.
  const sharedActivity = useMemo(() => {
    const afterIds = new Set(after.activities.map((a) => a.id))
    return before.activities.find((a) => afterIds.has(a.id)) ?? null
  }, [before.activities, after.activities])

  return (
    <div className="modal-overlay show">
      <div className="modal-box dt-report-modal-box" style={{ maxWidth: 900 }}>
        <div className="modal-hdr dt-report-no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Drive Test Comparison Report</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-primary btn-small" onClick={() => window.print()} disabled={!data}>
              🖨 Print / Save as PDF
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="modal-body">
          {isLoading && <div className="page-status">Loading comparison…</div>}
          {error && <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load this comparison.')}</div>}

          {data && (
            // dt-report-print-area is the ONLY thing App.css's @media
            // print rules reveal — everything else on the page
            // (sidebar, topbar, this modal's own backdrop/buttons, the
            // Delta map underneath) is hidden for print. See that CSS
            // for exactly why this wrapper (rather than a DOM-position
            // selector) is what those rules key off of.
            <div className="dt-report-print-area">
              <h1 style={{ marginTop: 0 }}>Drive Test Comparison Report</h1>
              {sharedActivity && (
                <p className="muted" style={{ marginTop: -6 }}>
                  Optimization Activity: <strong>{sharedActivity.name}</strong>
                </p>
              )}
              <table className="admin-table" style={{ marginBottom: 18 }}>
                <tbody>
                  <tr>
                    <th style={{ width: 90 }}>Before</th>
                    <td>{before.name}</td>
                    <td>{before.date ?? '—'}</td>
                    <td>{before.tech}</td>
                  </tr>
                  <tr>
                    <th>After</th>
                    <td>{after.name}</td>
                    <td>{after.date ?? '—'}</td>
                    <td>{after.tech}</td>
                  </tr>
                </tbody>
              </table>

              <h2>Summary</h2>
              <p className="muted" style={{ fontSize: 12 }}>
                {data.summary.matched_cells} matched grid cells compared
                {data.summary.unmatched_cells_a || data.summary.unmatched_cells_b
                  ? ` (${data.summary.unmatched_cells_a} before-only / ${data.summary.unmatched_cells_b} after-only cells had no counterpart and are excluded)`
                  : ''}
                .
              </p>
              <table className="admin-table" style={{ marginBottom: 18 }}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Avg Δ</th>
                    <th>Improved %</th>
                    <th>Degraded %</th>
                    <th>Unchanged %</th>
                    <th>Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => {
                    const deadband = deadbandFor(m.key)
                    const direction = directionFor(m.key)
                    const avg = data.summary.avg_delta[m.key] ?? null
                    const status = deltaStatus(avg, deadband, direction)
                    return (
                      <tr key={m.key}>
                        <td>{m.label}</td>
                        <td>{formatSigned(avg, m.unit)}</td>
                        <td>{data.summary.improved_pct[m.key] ?? '—'}%</td>
                        <td>{data.summary.degraded_pct[m.key] ?? '—'}%</td>
                        <td>{data.summary.unchanged_pct[m.key] ?? '—'}%</td>
                        <td>
                          <StatusBadge status={status} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              <h2>Worst Remaining Spots</h2>
              {primaryMetric ? (
                <>
                  <p className="muted" style={{ fontSize: 12 }}>
                    Cells classified as degraded on {primaryMetric.label} (before→after change beyond the{' '}
                    {deadbandFor(primaryMetric.key)}
                    {primaryMetric.unit} deadband), worst delta first — this is the biggest CHANGE for the worse
                    between the two sessions, not simply the weakest absolute {primaryMetric.label} reading, so a
                    spot that was already poor before and stayed poor will not appear here.
                  </p>
                  {!worstCells.length ? (
                    <p className="muted">No degraded cells for {primaryMetric.label} — nothing to flag here.</p>
                  ) : (
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Lat</th>
                          <th>Lng</th>
                          <th>Before</th>
                          <th>After</th>
                          <th>Δ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {worstCells.map((cell: DtCompareCell, i) => (
                          <tr key={i}>
                            <td>{cell.lat.toFixed(5)}</td>
                            <td>{cell.lng.toFixed(5)}</td>
                            <td>
                              {cell.a[primaryMetric.key] ?? '—'}
                              {primaryMetric.unit}
                            </td>
                            <td>
                              {cell.b[primaryMetric.key] ?? '—'}
                              {primaryMetric.unit}
                            </td>
                            <td style={{ color: '#dc2626', fontWeight: 700 }}>
                              {formatSigned(cell.delta[primaryMetric.key], primaryMetric.unit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <p className="muted">No comparable metric found for this tech.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
