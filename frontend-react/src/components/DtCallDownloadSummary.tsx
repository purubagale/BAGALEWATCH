import type { DtCallSummary, DtDownloadSummary } from '../api/types'

// Replaces the raw per-event table (DtEventsTable.tsx, kept as a
// component in case a future raw/diagnostic view wants it) as of a
// 2026-08-15 follow-up request: "i need to store only the data like
// total no. of call attempted, total call success, total call drop,
// total call rejected, percentage... for 4g dl, total download
// attempted/succeed/fail... for 4g fallback, total call attempted, total
// no. of fallback, success, fail". Renders whichever of callSummary/
// downloadSummary is present on a session's meta (see api/types.ts's
// DtCallSummary/DtDownloadSummary and lib/trpAnalysis.ts's
// trpaSummarizeCallEvents/trpaSummarizeDownloadEvents for exactly how
// each count is derived — real TEMS event structure, not a guessed
// numeric-code interpretation) — a voice/fallback-type session shows the
// call cards, a DL session shows the download cards, and a mixed capture
// could in principle show both (nothing here assumes exactly one).
function Card({ val, label, sub }: { val: string | number; label: string; sub?: string }) {
  return (
    <div className="report-card">
      <div className="report-card-val">{val}</div>
      <div className="report-card-label">{label}</div>
      {sub && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function pctText(v: number | null): string {
  return v === null ? '—' : `${v}%`
}

export default function DtCallDownloadSummary({
  callSummary,
  downloadSummary,
}: {
  callSummary: DtCallSummary | undefined
  downloadSummary: DtDownloadSummary | undefined
}) {
  if (!callSummary && !downloadSummary) return null
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {callSummary && (
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Call outcomes (from TEMS's own call-lifecycle event markers — see each card's note for how it's derived)
          </div>
          <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', margin: 0 }}>
            <Card val={callSummary.attempted} label="Calls Attempted" />
            <Card
              val={callSummary.setupSuccess}
              label="Setup Success"
              sub={`${pctText(callSummary.setupSuccessRatePct)} of attempted`}
            />
            <Card
              val={callSummary.rejected}
              label="Rejected"
              sub={`${pctText(callSummary.rejectRatePct)} of attempted — no setup reached`}
            />
            <Card val={callSummary.completed} label="Completed Normally" />
            <Card
              val={callSummary.dropped}
              label="Dropped"
              sub={`${pctText(callSummary.dropRatePct)} of connected — setup ok, no clean end`}
            />
            <Card
              val={callSummary.fallbackDetected}
              label="Fallback (SRVCC) Detected"
              sub="TEMS's own SrvccHandoverOccurredDuringCall marker"
            />
          </div>
        </div>
      )}
      {downloadSummary && (
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Download outcomes (from TEMS's own FTP Begin/End event markers)
          </div>
          <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', margin: 0 }}>
            <Card val={downloadSummary.attempted} label="Downloads Attempted" />
            <Card
              val={downloadSummary.succeeded}
              label="Succeeded"
              sub={`${pctText(downloadSummary.successRatePct)} of attempted`}
            />
            <Card val={downloadSummary.failed} label="Failed / Incomplete" />
          </div>
        </div>
      )}
    </div>
  )
}
