import type { DtSessionEvent } from '../api/types'

// Shared by DtUploadPage.tsx's .trp review screen and
// DtSessionHistoryPage.tsx's saved-session detail view (2026-08-14,
// "detect and store separately but relating to session as particular
// events for which the log is taken like fallback events from fallback
// log, download success event from DL log etc") — one small table
// component rather than duplicating this JSX in both places, since both
// read the exact same DtSessionMeta.events shape (see api/types.ts's
// DtSessionEvent and lib/trpAnalysis.ts's module comment on how these
// get decoded from a real .trp file's Call.*/Data.*/Location.*
// namespaces). Renders nothing when there are no events — callers don't
// need to guard the render themselves.
//
// Deliberately a flat "field=value, field=value" text column rather than
// one column per field: different event types (Call.CallEndEvent vs.
// Data.Ftp.Download.EndEvent vs. Location.PositionLostEvent) carry
// entirely different field sets, so a fixed column layout would be
// mostly empty cells for any given row. A per-type field breakdown can
// be added later if a specific event type turns out to need one; nothing
// here forecloses that.
function fieldPathShort(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1]
}

function formatFields(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${fieldPathShort(k)}=${v}`)
    .join(', ')
}

export default function DtEventsTable({ events }: { events: DtSessionEvent[] | undefined }) {
  if (!events || !events.length) return null
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts))
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
        {sorted.length} named event{sorted.length === 1 ? '' : 's'} detected via TEMS's own explicit markers in this
        session's source file(s) — not inferred from signal thresholds.
      </div>
      <div className="report-table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Details</th>
              <th>Source File</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => (
              <tr key={`${e.ts}-${e.type}-${i}`}>
                <td>{e.ts.replace('T', ' ').replace('Z', '')}</td>
                <td>{e.type}</td>
                <td style={{ fontSize: 11 }}>{formatFields(e.fields)}</td>
                <td className="muted" style={{ fontSize: 11 }}>{e.sourceFile}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
