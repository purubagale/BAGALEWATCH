import { useState } from 'react'
import { useVolteQualitySamples } from '../api/queries'

// VoLTE Quality (dev/pilot-testing tool) -- raw, ungrouped VoLTE/VoNR
// call-quality samples from core/volte_quality.py's VolteQualityListView
// (/api/v2/telemetry/volte-samples/). Superadmin-only, no production
// aggregation/map view (unlike the RF Coverage page) -- see that view's
// own docstring for why, and core/volte_quality.py's module docstring for
// the full pipeline this surfaces (including why it will show nothing
// real until the app has carrier-privileged status).
//
// Three distinct MOS states per row, never collapsed into one visual
// treatment (2026-10-02, "rather than null, currently lets use it, if
// found will update later"): a VERIFIED estimate (AMR-WB/G.711/G.729)
// renders as a plain number; a PROVISIONAL one (EVS/AMR-NB -- a real
// codec's constants run through an approximated formula or proxied via a
// different codec, see core/volte_quality.py) renders with a "~" prefix
// and an amber tone; "unavailable" (no entry at all, or loss reported
// with no published robustness factor) renders as muted text. Mixing
// provisional and verified values with the same styling would misrepresent
// how confident each number actually is.
function MosCell({ mos, isProvisional }: { mos: number | null; isProvisional: boolean }) {
  if (mos == null) {
    return (
      <span className="muted" title="No codec entry, or packet loss reported with no published robustness factor">
        unavailable
      </span>
    )
  }
  if (isProvisional) {
    return (
      <span style={{ color: 'var(--status-warning)' }} title="Provisional estimate -- approximated codec entry, not yet verified against a cited ITU-T source for this exact codec/scale">
        ~{mos.toFixed(2)}
      </span>
    )
  }
  return <span>{mos.toFixed(2)}</span>
}

export default function VolteQualityPage() {
  const [minutes, setMinutes] = useState(60)
  const { data, isLoading, error } = useVolteQualitySamples(minutes)
  const samples = data?.samples ?? []

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>VoLTE Quality</h1>
      <p className="muted">
        Raw, ungrouped VoLTE/VoNR call-quality samples -- a dev/pilot tool for verifying real call-quality uploads
        once the app has carrier-privileged status. "Estimated MOS" is a server-computed ITU-T G.107 E-model
        approximation from network metrics, never a true perceptually-measured score. A plain number is a verified
        estimate (AMR-WB/G.711/G.729); a "~"-prefixed amber number is provisional (EVS/AMR-NB -- real constants run
        through an approximated formula or a proxy codec, pending verification); "unavailable" means no codec entry
        exists yet, or packet loss was reported with no published robustness factor to account for it. See
        core/volte_quality.py for the full picture.
      </p>
      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
        <label>
          Window
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={15}>Last 15 minutes</option>
            <option value={60}>Last hour</option>
            <option value={360}>Last 6 hours</option>
            <option value={1440}>Last 24 hours</option>
          </select>
        </label>
      </div>
      {isLoading && <div className="page-status">Loading VoLTE samples...</div>}
      {error && <div className="page-status page-status-error">Could not load VoLTE samples.</div>}
      {!isLoading && !error && (
        <>
          {samples.length === 0 ? (
            <div className="page-status">
              No VoLTE call-quality samples in this window yet -- expected until a carrier-privileged test device
              uploads real data.
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Call time (ts)</th>
                  <th>Network</th>
                  <th>Codec</th>
                  <th>Duration</th>
                  <th>Packet loss</th>
                  <th>Jitter</th>
                  <th>RTT</th>
                  <th>Quality (network)</th>
                  <th>Estimated MOS</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s, i) => (
                  <tr key={i}>
                    <td>{s.device_id.slice(0, 12)}...</td>
                    <td>{new Date(s.ts).toLocaleString()}</td>
                    <td>{s.network_type}</td>
                    <td>{s.codec || '-'}</td>
                    <td>{s.call_duration_s != null ? `${s.call_duration_s}s` : '-'}</td>
                    <td>{s.packet_loss_pct != null ? `${s.packet_loss_pct}%` : '-'}</td>
                    <td>{s.jitter_ms != null ? `${s.jitter_ms} ms` : '-'}</td>
                    <td>{s.rtt_ms != null ? `${s.rtt_ms} ms` : '-'}</td>
                    <td>{s.quality_level || '-'}</td>
                    <td>
                      <MosCell mos={s.mos_estimate} isProvisional={s.mos_is_provisional} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {samples.length.toLocaleString()} sample(s) in the last {minutes} minute(s) -- auto-refreshes every 10s.
            A "~" prefix means an estimate for an unverified codec (approximated, not yet confirmed against a cited
            ITU-T source for that exact codec/scale) -- treat it as directional, not exact.
          </p>
        </>
      )}
    </div>
  )
}
