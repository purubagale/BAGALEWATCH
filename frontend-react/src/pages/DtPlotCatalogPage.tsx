import { Link } from 'react-router-dom'
import { DT_EXPLORE_PATH, DT_SESSION_HISTORY_PATH } from '../constants/opaqueRoutes'
import { DT_PLOT_CATALOG, type DtPlotCatalogEntry } from '../lib/dtPlotCatalog'

// DT Plot Catalog (2026-09-23, plan Step 7) — a living reference for the
// user's own 2.4.1-2.4.38 drive-test report checklist: which rows this
// app can already produce a plot for, which view produces it, and for
// the rest, exactly what real sample file is still needed. See
// dtPlotCatalog.ts's own module docstring for the full design and the
// process that flips a row from 'needs-sample' to 'available'.
//
// Read-only for every role — this is reference material, not something
// anyone edits through the UI (editing it means editing dtPlotCatalog.ts
// directly once a row's real status changes, same "code is the source of
// truth" convention as dtBands.ts's ALL_METRICS).

function statusBadge(status: DtPlotCatalogEntry['status']) {
  return status === 'available' ? (
    <span className="issue-badge" style={{ background: '#16a34a22', color: '#16a34a' }}>Available</span>
  ) : (
    <span className="issue-badge" style={{ background: '#eab30822', color: '#b45309' }}>Needs sample</span>
  )
}

function viewLink(entry: DtPlotCatalogEntry) {
  if (entry.view === 'explore') {
    return <Link to={DT_EXPLORE_PATH}>Open in DT Explore →</Link>
  }
  if (entry.view === 'compare') {
    return <Link to={DT_SESSION_HISTORY_PATH}>Compare in DT Session History →</Link>
  }
  return <span className="muted">{entry.note}</span>
}

export default function DtPlotCatalogPage() {
  const available = DT_PLOT_CATALOG.filter((e) => e.status === 'available').length

  return (
    <div className="admin-page">
      <h1>DT Plot Catalog</h1>
      <p className="muted">
        Every row of the drive-test report checklist (PCI/Band/RSRP/RSRQ/SINR/CQI/throughput/HOSR/VoLTE MOS/ViLTE
        codec, each Pre DT and Post DT) — {available} of {DT_PLOT_CATALOG.length} already produce a real plot in
        this app today; the rest name exactly what real sample file is still needed to build them.
      </p>

      <div className="report-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Plot</th>
              <th>Phase</th>
              <th>Status</th>
              <th>Where / What's Needed</th>
            </tr>
          </thead>
          <tbody>
            {DT_PLOT_CATALOG.map((entry) => (
              <tr key={entry.id}>
                <td className="muted">{entry.id}</td>
                <td>{entry.title}</td>
                <td>{entry.phase === 'pre' ? 'Pre DT' : 'Post DT'}</td>
                <td>{statusBadge(entry.status)}</td>
                <td>{viewLink(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
