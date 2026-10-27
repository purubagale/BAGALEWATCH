import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { NeighbourSummary } from '../api/types'

// The other cells the phones heard during a session (2026-10-27, server:
// core/neighbour_cells.py session_summary). One row per cell: how often it
// was heard, its level, and how often it was clearly stronger than the
// serving cell of the same technology, which points at a missing neighbour
// relation or handover settings worth a look.

const STRONG_SHARE = 30   // % of readings before a cell is called out
const STRONG_MIN = 10     // readings of the same technology before that

export default function NeighbourBreakdown({ data, siteLink, limitRows = 15 }: {
  data: NeighbourSummary | null | undefined
  siteLink?: (siteId: string) => string
  limitRows?: number
}) {
  const [all, setAll] = useState(false)
  if (!data) return null
  const rows = data.cells
  const shown = all ? rows : rows.slice(0, limitRows)
  const flagged = rows.filter((r) => r.same_tech >= STRONG_MIN && (r.stronger_pct ?? 0) >= STRONG_SHARE)
  // Per reading, against the serving cell of the same technology (2026-10-27).
  const shares = data.same_tech_readings ? [
    data.avg_cells_heard != null ? `${data.avg_cells_heard} cells heard per reading` : '',
    `a stronger cell in ${data.stronger_readings_pct ?? 0}% of readings`,
    `no dominant cell in ${data.crowded_readings_pct ?? 0}%`,
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="secb" style={{ marginTop: 12 }}>
      <div className="secb-head">
        <b>Neighbour cells heard</b>
        <span className="secb-muted">
          {data.with_neighbours.toLocaleString()} of {data.readings.toLocaleString()} readings carry neighbours
          {data.capped_readings ? ' (newest shown)' : ''} · {(data.cells_count ?? rows.length)} cell{(data.cells_count ?? rows.length) === 1 ? '' : 's'}{data.capped_rows ? ' (most heard shown)' : ''}
        </span>
      </div>
      {shares && (
        <div className="secb-muted secb-small" title={`Stronger: ${data.stronger_db} dB or more above the serving cell. No dominant cell: ${data.crowd_cells ?? 3} or more other cells within ${data.crowd_db ?? 5} dB of it.`}>
          {shares}
        </div>
      )}
      {data.names_hidden ? (
        <div className="secb-muted">
          Which cells and sites were heard is location history: it is shown while an emergency is declared.
        </div>
      ) : rows.length === 0 ? (
        <div className="secb-muted">
          No neighbour cells were recorded. Phones send them from app version 1.2.3; earlier readings have none.
        </div>
      ) : (
        <>
          {flagged.slice(0, 3).map((r) => (
            <div className="secb-note" key={`${r.network_type}|${r.cell}|${r.site_id}|${r.sector}|${r.arfcn}`}>
              <b>{r.tech} {r.cell}{r.site_id ? ` (${r.site_id}${r.sector ? ` ${r.sector}` : ''})` : ''}</b> was {data.stronger_db} dB or more
              above the serving cell in {r.stronger_pct}% of {r.same_tech} readings{r.mostly_beside ? `, mostly while ${r.mostly_beside} served` : ''}.
              Worth checking the neighbour relation and handover settings between them.
            </div>
          ))}
          <div className="secb-scroll">
            <table className="secb-table" data-pager="off">
              <thead>
                <tr>
                  <th>Cell</th><th>Site</th><th>Sector</th><th>Network</th>
                  <th>Heard</th><th>Average</th><th>Best</th>
                  <th title={`Readings where this cell was ${data.stronger_db} dB or more above the serving cell of the same technology`}>Stronger than serving</th>
                  <th>Distance</th><th>Mostly heard beside</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.network_type}|${r.cell}|${r.site_id}|${r.sector}|${r.arfcn}`}>
                    <td><b>{r.cell}</b>{r.arfcn != null && <div className="secb-muted secb-small">channel {r.arfcn}</div>}</td>
                    <td title={r.site_name ?? undefined}>
                      {r.site_id ? (siteLink ? <Link to={siteLink(r.site_id)}>{r.site_id}</Link> : r.site_id) : <span className="secb-muted">not placed</span>}
                      {r.site_name && r.site_name !== r.site_id && <div className="secb-muted secb-small">{r.site_name}</div>}
                    </td>
                    <td>{r.sector ?? '—'}</td>
                    <td>{r.tech}</td>
                    <td className="secb-num">{r.heard.toLocaleString()}</td>
                    <td className="secb-num">{r.level_avg} dBm</td>
                    <td className="secb-num">{r.level_best} dBm</td>
                    <td className="secb-num">
                      {r.same_tech ? <>{r.stronger_pct != null && r.stronger_pct >= STRONG_SHARE && r.same_tech >= STRONG_MIN ? <b>{r.stronger_pct}%</b> : `${r.stronger_pct}%`} <span className="secb-muted">({r.stronger})</span></> : '—'}
                    </td>
                    <td className="secb-num">{r.dist_km_avg != null ? `${r.dist_km_avg} km` : '—'}</td>
                    <td className="secb-small">{r.mostly_beside ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limitRows && (
            <button type="button" className="secb-more" onClick={() => setAll(!all)}>
              {all ? `Show the ${limitRows} most heard` : `Show all ${rows.length} cells`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
