import { useState } from 'react'
import { useCallContext, useVolteQualitySamples } from '../api/queries'
import type { CallOutcome } from '../api/types'

// Calls from phones (2026-10-14, core/call_context.py): what an ordinary
// app can see of a call -- the voice network it used, not its quality.
const OUTCOME_LABEL: Record<CallOutcome, string> = {
  volte: 'Stayed on VoLTE / VoNR',
  vowifi: 'Wi-Fi calling',
  fallback: 'Fell back to 2G/3G',
  legacy: 'On 2G/3G, no 4G before the call',
  unknown: 'Unknown',
}
const OUTCOME_ORDER: CallOutcome[] = ['volte', 'fallback', 'legacy', 'vowifi', 'unknown']

function CallsSection() {
  const [days, setDays] = useState(7)
  const { data, isLoading, error } = useCallContext(days)
  const total = data?.total ?? 0
  const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : '-')

  return (
    <section style={{ marginTop: 32 }}>
      <h2>Calls from phones</h2>
      <p className="muted">
        Phones that share with NTC report each call: the voice network it used, the network just before, how long
        it lasted, and the cell and signal at its start and end. There are no quality figures here and no phone
        numbers. A call that falls back to 2G/3G where the phone was on 4G points at VoLTE coverage or core issues
        around that cell.
      </p>
      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
        <label>
          Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Last day</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      {isLoading && <div className="page-status">Loading calls...</div>}
      {error && <div className="page-status page-status-error">Could not load calls.</div>}
      {data && total === 0 && (
        <div className="page-status">No calls reported in this period yet.</div>
      )}
      {data && total > 0 && (
        <>
          <table className="admin-table" style={{ maxWidth: 520 }}>
            <thead>
              <tr><th>Call</th><th>Calls</th><th>Share</th></tr>
            </thead>
            <tbody>
              {OUTCOME_ORDER.map((o) => (
                <tr key={o}>
                  <td>{OUTCOME_LABEL[o]}</td>
                  <td>{data.by_outcome[o].toLocaleString()}</td>
                  <td>{pct(data.by_outcome[o])}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Cells where calls most often fell back</h3>
          {data.top_fallback_cells.length === 0 ? (
            <div className="page-status">No call fell back to 2G/3G in this period.</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr><th>Cell at call start</th><th>PCI</th><th>Network</th><th>Calls</th><th>Fell back</th></tr>
              </thead>
              <tbody>
                {data.top_fallback_cells.map((c) => (
                  <tr key={`${c.cell_id}-${c.network_type}`}>
                    <td>{c.site_id ? `${c.site_id}${c.cell_name ? ` · ${c.cell_name}` : ''}` : c.cell_id}</td>
                    <td>{c.pci ?? '-'}</td>
                    <td>{c.network_type || '-'}</td>
                    <td>{c.calls}</td>
                    <td>{c.fallback} ({Math.round((100 * c.fallback) / c.calls)}%)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={{ marginTop: 20 }}>Latest calls</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Phone</th><th>Started</th><th>Duration</th><th>Call</th><th>Voice network</th>
                <th>Before the call</th><th>Cell at start</th><th>Signal at start</th><th>Signal at end</th>
              </tr>
            </thead>
            <tbody>
              {data.calls.map((c, i) => (
                <tr key={i}>
                  <td>{c.device}</td>
                  <td>{new Date(c.started_at).toLocaleString()}</td>
                  <td>{c.duration_s != null ? `${c.duration_s}s` : '-'}</td>
                  <td>{OUTCOME_LABEL[c.outcome]}</td>
                  <td>{c.voice_networks.replace(/,/g, ' → ') || '-'}</td>
                  <td>{c.data_network_before || '-'}</td>
                  <td>{c.cell_id != null ? `${c.network_type} ${c.cell_id}${c.pci != null ? ` / PCI ${c.pci}` : ''}` : '-'}</td>
                  <td>{c.level_dbm != null ? `${c.level_dbm} dBm` : '-'}</td>
                  <td>{c.end_level_dbm != null ? `${c.end_level_dbm} dBm${c.end_network_type ? ` (${c.end_network_type})` : ''}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {total.toLocaleString()} call(s) in the last {days} day(s); the latest {data.calls.length} are listed.
            Signal is RSRP on 4G/5G, RSCP on 3G and RSSI on 2G.
          </p>
        </>
      )}
    </section>
  )
}

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
        Individual VoLTE/VoNR call-quality samples, for checking call-quality uploads once the mobile app has
        carrier-privileged status. "Estimated MOS" is calculated from network metrics with the ITU-T G.107 E-model;
        it is not a measured listening score. A plain number is a verified estimate (AMR-WB, G.711, G.729). An amber
        number with "~" is provisional (EVS, AMR-NB). "Unavailable" means the codec is not supported yet, or packet
        loss was reported for a codec with no published loss figures.
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
      <CallsSection />
    </div>
  )
}
