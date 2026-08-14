import { Fragment, useEffect, useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useAuditHistory, useDeleteAuditReport, useRfAuditData, useSaveAuditReport, useSite, useSites } from '../api/queries'
import { isAllowed } from '../api/types'
import type { RfAuditFinding } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { renderMarkdown } from '../lib/markdown'

// Ports v1's RF Site Audit tool (bts_monitor.html's openAuditModal() and
// friends, ~line 11655-12167) as a full page instead of a modal, same
// "modal -> page" move KPI Trend made. One deliberate, documented
// departure from a literal port: the Sector Analysis pane. See
// core/rf_audit.py's module docstring for the full "why" — short version,
// v1 invents RSRP/RSRQ/SINR per sector (data this system doesn't actually
// have anywhere) and adds Math.random() jitter on top; this page shows
// each sector's real kpi_json values where they exist, falling back to
// the site's own real aggregate (clearly labeled) where they don't.
//
// Everything else here — the 48-item checklist, measurement RAG
// thresholds, VSWR/PIM evaluators, antenna/feeder config fields, and the
// report generator — is fixed reference data or pure arithmetic over
// real user-entered measurements, so it stays client-side exactly like
// v1, with no server round trip needed.

type ChkStatus = 'pass' | 'fail' | 'na' | ''
type ChkState = Record<string, { status: ChkStatus; note: string }>

const AUDIT_CHECKLIST: { cat: string; icon: string; items: { id: string; text: string; hint: string }[] }[] = [
  { cat: 'Site & Civil', icon: '🏗', items: [
    { id: 'c01', text: 'Site access road condition acceptable', hint: 'Verify no flooding, erosion, or blockages' },
    { id: 'c02', text: 'Perimeter fence/security intact', hint: 'Gates locked, no gaps or damage' },
    { id: 'c03', text: 'Tower/mast structural integrity', hint: 'No visible corrosion, bending, or loose bolts' },
    { id: 'c04', text: 'Tower lighting functional', hint: 'Aviation warning lights active if required' },
    { id: 'c05', text: 'Earthing/grounding system intact', hint: 'Check earth rod, bonding straps, and earth bar' },
    { id: 'c06', text: 'Lightning protection system present', hint: 'Air terminal, down conductor, and earth pit' },
    { id: 'c07', text: 'Equipment shelter/cabinet condition', hint: 'No water ingress, adequate ventilation/cooling' },
    { id: 'c08', text: 'Generator/power backup operational', hint: 'Test run if possible, check fuel level' },
  ] },
  { cat: 'RF Equipment', icon: '📡', items: [
    { id: 'r01', text: 'RRU/RRH units physically secured', hint: 'Mounting bolts tight, no physical damage' },
    { id: 'r02', text: 'BBU/baseband equipment status normal', hint: 'No active hardware alarms on EMS' },
    { id: 'r03', text: 'RRU alarm LEDs — no critical alarms', hint: 'Check RRU indicator lights for fault status' },
    { id: 'r04', text: 'Optical fibre links between BBU-RRU intact', hint: 'Check SFP modules and fibre bend radius' },
    { id: 'r05', text: 'CPRI/eCPRI link quality acceptable', hint: 'Verify optical receive power in acceptable range' },
    { id: 'r06', text: 'Power supply to RRU within spec', hint: 'Check voltage: typically 48V DC ±6V' },
    { id: 'r07', text: 'Fan units / heat sink clean and functional', hint: 'No dust blockage, fans spinning correctly' },
    { id: 'r08', text: 'Cabinet grounding connections secure', hint: 'All bonding straps tight, no oxidisation' },
  ] },
  { cat: 'Antenna System', icon: '📶', items: [
    { id: 'a01', text: 'Antenna mounting bracket secure', hint: 'No play or movement, lock nuts tight' },
    { id: 'a02', text: 'Antenna azimuth within ±2° of planned', hint: 'Use compass or surveying tool to verify' },
    { id: 'a03', text: 'Mechanical tilt matches planned value', hint: 'Check tilt scale on antenna mount' },
    { id: 'a04', text: 'Electrical tilt (RCU) set correctly', hint: 'Verify via RET/AISG controller or EMS' },
    { id: 'a05', text: 'No physical antenna damage or deformation', hint: 'Inspect radome for cracks, dents, or discolouration' },
    { id: 'a06', text: 'Antenna jumpers properly weather-proofed', hint: 'Self-amalgamating tape applied, no exposed connector' },
    { id: 'a07', text: 'Antenna separation from obstruction ≥2m', hint: 'Check clearance from steelwork, walls, other antennas' },
    { id: 'a08', text: 'AISG/RET controller connected and responding', hint: 'Verify tilt control via NMS or local AISG tool' },
  ] },
  { cat: 'Feeder & Cabling', icon: '🔌', items: [
    { id: 'f01', text: 'Feeder cable secured along tower/wall', hint: 'No excessive sag, strain relief at every 2m' },
    { id: 'f02', text: 'No visible feeder damage or kinking', hint: 'Minimum bend radius maintained throughout' },
    { id: 'f03', text: 'All N-type connectors torqued to spec', hint: 'Typical: 20-25 Nm for 7/8" N-type' },
    { id: 'f04', text: 'Weatherproofing applied to all outdoor joints', hint: 'Self-amalgamating tape + UV-resistant outer wrap' },
    { id: 'f05', text: 'Cable entry points sealed (rodent/water)', hint: 'Use fire-rated foam sealant at all cable penetrations' },
    { id: 'f06', text: 'VSWR within acceptable range (<1.5)', hint: 'Measure with VNA/PIM analyser at each port' },
    { id: 'f07', text: 'No PIM sources identified', hint: 'PIM above -107 dBc requires investigation' },
    { id: 'f08', text: 'Feeder loss measured and within design', hint: 'Compare against link budget calculation' },
  ] },
  { cat: 'Power & Environmental', icon: '⚡', items: [
    { id: 'p01', text: 'Mains power supply stable', hint: 'Check voltage, frequency, and phase balance' },
    { id: 'p02', text: 'Rectifier/PSU output voltage correct', hint: '48V DC: acceptable range 44-57V' },
    { id: 'p03', text: 'Battery bank health acceptable', hint: 'Check float voltage, impedance, and age' },
    { id: 'p04', text: 'UPS/battery runtime ≥ 4 hours', hint: 'Test or verify from battery management system' },
    { id: 'p05', text: 'Air conditioning/HVAC operational', hint: 'Set point 20-25°C, no refrigerant leak' },
    { id: 'p06', text: 'Temperature alarms not active', hint: 'Check NMS for high/low temperature events' },
    { id: 'p07', text: 'Fire detection/suppression functional', hint: 'Visual inspection of smoke detectors' },
    { id: 'p08', text: 'Fuel level adequate (if diesel generator)', hint: 'Minimum 75% recommended for autonomy' },
  ] },
  { cat: 'Transmission & Backhaul', icon: '🌐', items: [
    { id: 't01', text: 'Microwave dish alignment verified', hint: 'RSL within ±2 dB of planned fade margin' },
    { id: 't02', text: 'Fiber backhaul connectivity stable', hint: 'Check BER and errored seconds in NMS' },
    { id: 't03', text: 'Backhaul latency within SLA', hint: 'Typically <10 ms for LTE backhaul' },
    { id: 't04', text: 'Transmission alarms cleared', hint: 'No active LOF, LOS, or AIS alarms' },
    { id: 't05', text: 'IP routing/VLAN configuration correct', hint: 'Verify S1/X2 interface reachability' },
    { id: 't06', text: 'Sync/timing source active (GPS/IEEE1588)', hint: 'Check PTP/SyncE lock status in EMS' },
  ] },
  { cat: 'Software & Configuration', icon: '💻', items: [
    { id: 'sw01', text: 'Software version up to date', hint: 'Compare with latest vendor-approved release' },
    { id: 'sw02', text: 'No active critical/major software alarms', hint: 'Review alarm list in EMS for SW-related faults' },
    { id: 'sw03', text: 'RF parameters within optimised values', hint: 'Verify against standard parameter template' },
    { id: 'sw04', text: 'Neighbour cell list complete and correct', hint: 'Check for missing neighbours in SON/ANR log' },
    { id: 'sw05', text: 'Load balancing / ANR enabled', hint: 'Confirm SON features active in NMS' },
    { id: 'sw06', text: 'Handover parameters within baseline', hint: 'A3 offset, TTT, hysteresis within ±10% of nominal' },
  ] },
]

const MEAS_FIELDS = [
  { id: 'm-rsrp', label: 'RSRP', unit: 'dBm', placeholder: '-80', ok: -90, warn: -100, hi: true, good: '>-90' },
  { id: 'm-rsrq', label: 'RSRQ', unit: 'dB', placeholder: '-10', ok: -10, warn: -15, hi: true, good: '>-10' },
  { id: 'm-sinr', label: 'SINR', unit: 'dB', placeholder: '15', ok: 13, warn: 7, hi: true, good: '>13' },
  { id: 'm-vswr', label: 'VSWR (best)', unit: '', placeholder: '1.15', ok: 1.5, warn: 1.8, hi: false, good: '<1.5' },
  { id: 'm-dl', label: 'DL Throughput', unit: 'Mbps', placeholder: '35', ok: 20, warn: 10, hi: true, good: '>20' },
  { id: 'm-ul', label: 'UL Throughput', unit: 'Mbps', placeholder: '15', ok: 10, warn: 5, hi: true, good: '>10' },
  { id: 'm-ping', label: 'Ping Latency', unit: 'ms', placeholder: '18', ok: 30, warn: 60, hi: false, good: '<30' },
  { id: 'm-cov', label: 'Coverage Radius', unit: 'km', placeholder: '2.5', ok: 1, warn: 0.5, hi: true, good: '>1km' },
]

const TABS = [
  { key: 'checklist', label: 'Checklist' },
  { key: 'measurements', label: 'Measurements' },
  { key: 'antenna', label: 'Antenna & Feeder' },
  { key: 'sectors', label: 'Sector Analysis' },
  { key: 'findings', label: 'Findings' },
  { key: 'report', label: 'Report' },
] as const
type Tab = (typeof TABS)[number]['key']

const SEV_ORDER: Record<RfAuditFinding['sev'], number> = { CRITICAL: 0, MAJOR: 1 }
const SEV_COLOR: Record<RfAuditFinding['sev'], string> = { CRITICAL: '#ef4444', MAJOR: '#f97316' }

export default function RfAuditPage() {
  const { user } = useAuth()
  const { data: sites } = useSites()
  const [siteId, setSiteId] = useState('')
  const [tab, setTab] = useState<Tab>('checklist')
  const [chk, setChk] = useState<ChkState>({})
  const [meas, setMeas] = useState<Record<string, string>>({})
  const [ant, setAnt] = useState<Record<string, string>>({})
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null)

  useEffect(() => {
    if (!siteId && sites && sites.length) setSiteId(sites[0].id)
  }, [sites, siteId])

  const { data: site } = useSite(siteId || undefined)
  const { data: auditData, isLoading: auditLoading, error: auditError } = useRfAuditData(siteId || undefined)
  const canManageAudit = !!user && isAllowed(user.role, user.permissions.rfaudit, 'read')
  const { data: history } = useAuditHistory(canManageAudit ? siteId || undefined : undefined)
  const saveReport = useSaveAuditReport()
  const deleteReport = useDeleteAuditReport()

  function setChkStatus(id: string, status: ChkStatus) {
    setChk((s) => ({ ...s, [id]: { status: (s[id]?.status ?? '') === status ? '' : status, note: s[id]?.note ?? '' } }))
  }
  function setChkNote(id: string, note: string) {
    setChk((s) => ({ ...s, [id]: { status: s[id]?.status ?? '', note } }))
  }
  function checkAll(status: ChkStatus) {
    const next: ChkState = {}
    AUDIT_CHECKLIST.forEach((sec) => sec.items.forEach((i) => { next[i.id] = { status, note: chk[i.id]?.note ?? '' } }))
    setChk(next)
  }
  function resetChecklist() {
    if (!confirm('Reset all checklist responses?')) return
    setChk({})
  }

  const allItems = useMemo(() => AUDIT_CHECKLIST.flatMap((s) => s.items), [])
  const passItems = allItems.filter((i) => chk[i.id]?.status === 'pass')
  const failItems = allItems.filter((i) => chk[i.id]?.status === 'fail')
  const naItems = allItems.filter((i) => chk[i.id]?.status === 'na')
  const answered = passItems.length + failItems.length + naItems.length

  const vswrVals = ['vswr1', 'vswr2', 'vswr3'].map((k) => parseFloat(ant[k])).filter((v) => !Number.isNaN(v))
  const vswrMax = vswrVals.length ? Math.max(...vswrVals) : null
  const pimVals = ['pim1', 'pim2', 'pim3'].map((k) => parseFloat(ant[k])).filter((v) => !Number.isNaN(v))
  const pimThresh = parseFloat(ant.pimThresh || '-107') || -107
  const pimWorst = pimVals.length ? Math.max(...pimVals) : null

  // ── Findings: checklist fails + real server KPI findings + VSWR/PIM
  // from real entered measurements — nothing fabricated at any layer.
  const findings: RfAuditFinding[] = useMemo(() => {
    const out: RfAuditFinding[] = []
    AUDIT_CHECKLIST.forEach((section) => section.items.forEach((item) => {
      if (chk[item.id]?.status === 'fail') {
        out.push({
          sev: 'MAJOR', cat: section.cat, title: `Checklist FAIL — ${item.text}`,
          detail: `${item.hint}. Manually marked as failed during site inspection.`,
          action: `Rectify immediately. Re-check: ${item.text}.`,
          note: chk[item.id]?.note ?? '',
        })
      }
    }))
    if (auditData) out.push(...auditData.kpi_findings)
    if (vswrMax !== null && vswrMax > 1.5) {
      out.push({
        sev: vswrMax > 1.8 ? 'CRITICAL' : 'MAJOR', cat: 'Antenna/Feeder', title: 'VSWR Exceeds Acceptable Limit',
        detail: `Measured VSWR: ${vswrMax.toFixed(2)}. High VSWR indicates antenna port mismatch, feeder damage, or connector fault.`,
        action: 'Inspect all N-type connectors. Check feeder for water ingress. Re-torque connections. Test with VNA to isolate fault location.',
        note: '',
      })
    }
    if (pimWorst !== null && pimWorst > pimThresh) {
      out.push({
        sev: 'CRITICAL', cat: 'Antenna/Feeder', title: 'PIM Failure Detected',
        detail: `PIM level ${pimWorst} dBc exceeds threshold ${pimThresh} dBc. PIM degrades uplink receiver sensitivity and causes interference.`,
        action: 'Inspect all passive components: connectors, jumpers, diplexers, and filters. Replace damaged components. Re-test after each replacement to isolate source.',
        note: '',
      })
    }
    return out.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev])
  }, [chk, auditData, vswrMax, pimWorst, pimThresh])

  const checkScore = answered > 0 ? Math.round((passItems.length / Math.max(passItems.length + failItems.length, 1)) * 100) : null
  const kpiScore = auditData?.kpi_score ?? 0
  const overall = checkScore !== null ? Math.round((checkScore + kpiScore) / 2) : kpiScore
  const grade = overall >= 90 ? 'A — Excellent' : overall >= 75 ? 'B — Good' : overall >= 60 ? 'C — Fair' : overall >= 45 ? 'D — Poor' : 'F — Critical — Immediate Action Required'

  function buildReportMarkdown(): string {
    if (!site) return ''
    const date = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    const L: string[] = []
    L.push('# RF SITE AUDIT REPORT')
    L.push(`**Site:** ${site.name || site.id}  |  **Region:** ${site.region}  |  **Type:** ${site.type}  |  **Tech:** ${site.tech}`)
    L.push(`**Date:** ${date}  |  **Status at Audit:** ${(site.status || '').toUpperCase()}`)
    if (site.lat !== null && site.lng !== null) L.push(`**Coordinates:** ${site.lat.toFixed(4)}°N, ${site.lng.toFixed(4)}°E`)
    L.push('')
    L.push('## Executive Summary')
    L.push(`**Overall Audit Score: ${overall}/100 — Grade ${grade}**`)
    L.push(`- Checklist: ${answered}/${allItems.length} items completed | ${passItems.length} Pass | ${failItems.length} Fail | ${naItems.length} N/A`)
    const critN = auditData?.kpi_problems.filter((p) => p.sev === 'CRIT').length ?? 0
    const warnN = auditData?.kpi_problems.filter((p) => p.sev === 'WARN').length ?? 0
    L.push(`- KPI Score: ${kpiScore}/100 — ${critN} critical, ${warnN} warning`)
    if (failItems.length) L.push(`- **${failItems.length} checklist item(s) failed — requires follow-up action**`)
    L.push('')

    L.push('## Section Scores')
    AUDIT_CHECKLIST.forEach((section) => {
      const pass = section.items.filter((i) => chk[i.id]?.status === 'pass').length
      const fail = section.items.filter((i) => chk[i.id]?.status === 'fail').length
      const done = section.items.filter((i) => chk[i.id]?.status).length
      const icon = fail > 0 ? '✗' : done === section.items.length ? '✓' : '○'
      L.push(`${icon} **${section.cat}**: ${pass}/${section.items.length} Pass${fail > 0 ? ` — ${fail} FAILED` : ''}`)
    })
    L.push('')

    L.push('## Live KPI Status')
    L.push('| KPI | Value | Status |')
    L.push('|-----|-------|--------|')
    ;[
      { key: 'rrc', l: 'RRC Setup SR', v: site.rrc, u: '%' }, { key: 'erab', l: 'E-RAB SR', v: site.erab, u: '%' },
      { key: 'call_drop', l: 'Call Drop Rate', v: site.call_drop, u: '%' }, { key: null, l: 'Call Setup SR', v: site.call_setup, u: '%' },
      { key: 'intra_ho', l: 'Intra HO SR', v: site.intra_ho, u: '%' }, { key: 'ip_thru', l: 'IP Throughput', v: site.ip_thru, u: 'Mbps' },
      { key: 'ip_lat', l: 'IP Latency', v: site.ip_lat, u: 'ms' }, { key: 'prb', l: 'PRB Util', v: site.prb, u: '%' },
      { key: 'cell_avail', l: 'Cell Avail', v: site.cell_avail, u: '%' },
    ].forEach((k) => {
      if (k.v === null || k.v === undefined) return
      // Matched by KPI_CHECKS key, not by this table's own display label —
      // the labels here are a shorter v1-matching set (e.g. "RRC Setup SR"
      // vs the findings engine's "RRC Setup SR" — coincidentally identical
      // for some rows but not others, e.g. "PRB Util" vs "PRB Utilisation"
      // server-side), so matching by string would silently under-flag
      // real findings for any row whose display label happens to differ.
      const prob = k.key ? auditData?.kpi_problems.find((p) => p.key === k.key) : undefined
      const st = prob ? (prob.sev === 'CRIT' ? '🔴 CRITICAL' : '🟡 WARNING') : '🟢 OK'
      L.push(`| ${k.l} | ${k.v.toFixed(1)} ${k.u} | ${st} |`)
    })
    L.push('')

    if (ant.az1 || ant.mechTilt || ant.height) {
      L.push('## Antenna Configuration')
      if (ant.az1) L.push(`- Azimuths: α=${ant.az1}° | β=${ant.az2 || '—'}° | γ=${ant.az3 || '—'}°`)
      if (ant.mechTilt) L.push(`- Mechanical Tilt: ${ant.mechTilt}° | Electrical Tilt: ${ant.elecTilt || '—'}°`)
      if (ant.height) L.push(`- Height: ${ant.height}m | Gain: ${ant.gain || '—'} dBi`)
      if (vswrVals.length) L.push(`- VSWR: α=${ant.vswr1 || '—'} | β=${ant.vswr2 || '—'} | γ=${ant.vswr3 || '—'} | Max: **${vswrMax?.toFixed(2)}** ${vswrMax !== null && vswrMax > 1.5 ? '⚠ EXCEEDS LIMIT' : ' ✓'}`)
      if (pimVals.length) L.push(`- PIM: Max ${pimWorst} dBc | Threshold: ${pimThresh} dBc | ${pimWorst !== null && pimWorst > pimThresh ? '✗ FAIL' : '✓ PASS'}`)
      L.push('')
    }

    if (failItems.length) {
      L.push('## Checklist Failures')
      failItems.forEach((item, i) => {
        L.push(`${i + 1}. **[FAIL]** ${item.text}`)
        L.push(`   Guidance: ${item.hint}`)
        const note = chk[item.id]?.note
        if (note) L.push(`   Note: ${note}`)
      })
      L.push('')
    }

    L.push('## Priority Actions')
    const p1: string[] = [], p2: string[] = [], p3: string[] = []
    failItems.forEach((i) => p1.push(`Rectify checklist failure: ${i.text}`))
    ;(auditData?.kpi_problems ?? []).filter((p) => p.sev === 'CRIT').forEach((p) => p1.push(`Investigate critical KPI: ${p.label} = ${p.value.toFixed(1)}`))
    ;(auditData?.kpi_problems ?? []).filter((p) => p.sev === 'WARN').forEach((p) => p2.push(`Monitor & optimise: ${p.label} = ${p.value.toFixed(1)}`))
    if (!p1.length && !p2.length) {
      p3.push('Schedule next routine RF audit in 6 months')
      p3.push('Perform drive test to validate coverage footprint')
      p3.push('Review neighbour cell list for completeness')
    } else {
      p3.push('Update site record in NMS with audit findings')
      p3.push('Schedule follow-up audit within 30 days of remediation')
    }
    if (p1.length) { L.push('**P1 — Immediate (within 24 hours):**'); p1.forEach((a) => L.push(`- ${a}`)) }
    if (p2.length) { L.push('**P2 — Short-term (within 1 week):**'); p2.forEach((a) => L.push(`- ${a}`)) }
    L.push('**P3 — Planned:**'); p3.forEach((a) => L.push(`- ${a}`))
    L.push('')
    L.push('---')
    L.push(`*RF Site Audit Report — BAGALEWATCH BTS · ${date}*`)
    L.push(`*Score: ${overall}/100 | Grade: ${grade.split('—')[0].trim()}*`)
    return L.join('\n')
  }

  const reportMarkdown = tab === 'report' || savedMsg ? buildReportMarkdown() : ''

  function downloadReport() {
    const md = buildReportMarkdown()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/plain' }))
    a.download = `RF_Audit_${site?.name || site?.id || 'Site'}_${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function copyReport() {
    navigator.clipboard.writeText(buildReportMarkdown()).catch(() => {})
  }
  async function handleSave() {
    setSaveErr(null)
    setSavedMsg(null)
    try {
      await saveReport.mutateAsync({ site: siteId, content: buildReportMarkdown(), score: overall })
      setSavedMsg('Audit report saved.')
    } catch (e) {
      setSaveErr(apiErrorMessage(e, 'Could not save the audit report.'))
    }
  }

  if (!user) return null

  return (
    <div className="admin-page" style={{ maxWidth: 1300 }}>
      <h1>RF Site Audit</h1>
      <p className="muted">
        Checklist, measurements, and findings for a single site. KPI findings/score and sector KPI comparison use
        real live data — nothing here is simulated.
      </p>

      <div className="report-toolbar">
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
        </select>
        <span className="muted">{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      </div>

      <div className="feat-tabs" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <div key={t.key} className={t.key === tab ? 'feat-tab active' : 'feat-tab'} onClick={() => setTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>

      {auditError && <div className="page-status page-status-error">{apiErrorMessage(auditError, 'Could not load RF audit data for this site.')}</div>}

      {tab === 'checklist' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="report-badge" style={{ background: '#1e2330', color: '#e6e9ef' }}>
              Completed: {allItems.length ? Math.round((answered / allItems.length) * 100) : 0}% | Pass: {passItems.length} | Fail: {failItems.length} | Remaining: {allItems.length - answered}
            </span>
            <button className="btn-secondary btn-small" style={{ marginLeft: 'auto' }} onClick={() => checkAll('pass')} type="button">✓ All Pass</button>
            <button className="btn-secondary btn-small" onClick={resetChecklist} type="button">↺ Reset</button>
          </div>
          {AUDIT_CHECKLIST.map((section) => {
            const pass = section.items.filter((i) => chk[i.id]?.status === 'pass').length
            const done = section.items.filter((i) => chk[i.id]?.status).length
            return (
              <div key={section.cat} className="audit-section">
                <div className="audit-section-hdr">
                  <span>{section.icon}</span>
                  <span className="audit-section-title">{section.cat}</span>
                  <span className="muted" style={{ marginLeft: 'auto' }}>{done > 0 ? `${pass}/${section.items.length} Pass` : 'Not started'}</span>
                </div>
                {section.items.map((item) => {
                  const st = chk[item.id]?.status ?? ''
                  return (
                    <div key={item.id} className="audit-chk-row">
                      <div className="audit-chk-label">
                        {item.text}
                        <small>{item.hint}</small>
                      </div>
                      <div className="audit-chk-status">
                        <button type="button" className={st === 'pass' ? 'chk-btn chk-pass on' : 'chk-btn chk-pass'} onClick={() => setChkStatus(item.id, 'pass')}>✓</button>
                        <button type="button" className={st === 'fail' ? 'chk-btn chk-fail on' : 'chk-btn chk-fail'} onClick={() => setChkStatus(item.id, 'fail')}>✗</button>
                        <button type="button" className={st === 'na' ? 'chk-btn chk-na on' : 'chk-btn chk-na'} onClick={() => setChkStatus(item.id, 'na')}>N/A</button>
                      </div>
                      <input className="audit-chk-note" placeholder="Note…" value={chk[item.id]?.note ?? ''} onChange={(e) => setChkNote(item.id, e.target.value)} />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'measurements' && (
        <div>
          <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            {MEAS_FIELDS.map((f) => {
              const raw = meas[f.id] ?? ''
              const v = parseFloat(raw)
              const has = raw !== '' && !Number.isNaN(v)
              const st = !has ? null : f.hi ? (v >= f.ok ? 'ok' : v >= f.warn ? 'warn' : 'fail') : (v <= f.ok ? 'ok' : v <= f.warn ? 'warn' : 'fail')
              const color = st === 'ok' ? '#4ade80' : st === 'warn' ? '#fbbf24' : st === 'fail' ? '#f87171' : '#6b7280'
              return (
                <div key={f.id} className="report-card" style={{ textAlign: 'left' }}>
                  <div className="report-card-label">{f.label}</div>
                  <input
                    className="audit-meas-input"
                    placeholder={f.placeholder}
                    type="number"
                    step="0.1"
                    value={raw}
                    onChange={(e) => setMeas((m) => ({ ...m, [f.id]: e.target.value }))}
                  />
                  <div style={{ fontSize: 10, color: '#9aa4b8', marginTop: 2 }}>{f.unit} <span style={{ color: '#6b7280' }}>{f.good}</span></div>
                  <div style={{ fontSize: 10, color, marginTop: 4, fontWeight: 700 }}>{st ? (st === 'ok' ? '✓ OK' : st === 'warn' ? '⚠ Warning' : '✗ Fail') : '—'}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'antenna' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <h2>Antenna Configuration</h2>
            <div className="edit-grid">
              <label>Mechanical Tilt (°)<input type="number" step="0.5" placeholder="3" value={ant.mechTilt ?? ''} onChange={(e) => setAnt((a) => ({ ...a, mechTilt: e.target.value }))} /></label>
              <label>Electrical Tilt (°)<input type="number" step="0.5" placeholder="2" value={ant.elecTilt ?? ''} onChange={(e) => setAnt((a) => ({ ...a, elecTilt: e.target.value }))} /></label>
              <label>Height (m)<input type="number" step="1" placeholder="30" value={ant.height ?? ''} onChange={(e) => setAnt((a) => ({ ...a, height: e.target.value }))} /></label>
              <label>Azimuth α (°)<input type="number" placeholder="0" value={ant.az1 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, az1: e.target.value }))} /></label>
              <label>Azimuth β (°)<input type="number" placeholder="120" value={ant.az2 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, az2: e.target.value }))} /></label>
              <label>Azimuth γ (°)<input type="number" placeholder="240" value={ant.az3 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, az3: e.target.value }))} /></label>
              <label>Antenna Gain (dBi)<input type="number" step="0.5" placeholder="18" value={ant.gain ?? ''} onChange={(e) => setAnt((a) => ({ ...a, gain: e.target.value }))} /></label>
            </div>
          </div>
          <div>
            <h2>Feeder & Cable System</h2>
            <div className="edit-grid">
              <label>Cable Length (m)<input type="number" placeholder="40" value={ant.cableLen ?? ''} onChange={(e) => setAnt((a) => ({ ...a, cableLen: e.target.value }))} /></label>
              <label>VSWR Sector α<input type="number" step="0.01" placeholder="1.15" value={ant.vswr1 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, vswr1: e.target.value }))} /></label>
              <label>VSWR Sector β<input type="number" step="0.01" placeholder="1.20" value={ant.vswr2 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, vswr2: e.target.value }))} /></label>
              <label>VSWR Sector γ<input type="number" step="0.01" placeholder="1.18" value={ant.vswr3 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, vswr3: e.target.value }))} /></label>
            </div>
            {vswrVals.length > 0 && (
              <div className="audit-eval-result" style={{ color: vswrMax! <= 1.5 ? '#4ade80' : vswrMax! <= 1.8 ? '#fbbf24' : '#f87171' }}>
                {vswrMax! <= 1.5 ? '✓ PASS — all ports within 1.5' : vswrMax! <= 1.8 ? '⚠ WARNING — one or more ports marginal (1.5–1.8)' : '✗ FAIL — VSWR > 1.8 indicates feeder or antenna fault'}
                <br /><small className="muted">Max: {vswrMax!.toFixed(2)} | Acceptable limit: ≤1.5 (ideal ≤1.3)</small>
              </div>
            )}
            <h2>PIM & Passive Intermodulation</h2>
            <div className="edit-grid">
              <label>PIM Level α (dBc)<input type="number" step="0.1" placeholder="-105" value={ant.pim1 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, pim1: e.target.value }))} /></label>
              <label>PIM Level β (dBc)<input type="number" step="0.1" placeholder="-108" value={ant.pim2 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, pim2: e.target.value }))} /></label>
              <label>PIM Level γ (dBc)<input type="number" step="0.1" placeholder="-103" value={ant.pim3 ?? ''} onChange={(e) => setAnt((a) => ({ ...a, pim3: e.target.value }))} /></label>
              <label>PIM Threshold (dBc)<input type="number" step="1" placeholder="-107" value={ant.pimThresh ?? ''} onChange={(e) => setAnt((a) => ({ ...a, pimThresh: e.target.value }))} /></label>
            </div>
            {pimVals.length > 0 && (
              <div className="audit-eval-result" style={{ color: pimWorst! <= pimThresh ? '#4ade80' : '#f87171' }}>
                {pimWorst! <= pimThresh ? '✓ PASS — PIM within acceptable limit' : '✗ FAIL — PIM exceeds threshold, investigate connector and feeder system'}
                <br /><small className="muted">Worst: {pimWorst} dBc | Threshold: {pimThresh} dBc</small>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'sectors' && (
        <div>
          {auditLoading && <div className="page-status">Loading sector data…</div>}
          {auditData && auditData.sectors.length === 0 && <div className="page-status">This site has no sector records.</div>}
          {auditData && auditData.sectors.length > 0 && (
            <div className="report-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th>PCI</th>
                    <th>Azimuth</th>
                    {auditData.sector_fields.map((f) => (
                      <th key={f}>{auditData.kpi_fields.find((k) => k.key === f)?.label ?? f}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {auditData.sectors.map((sec) => (
                    <tr key={sec.id}>
                      <td>{sec.cell_name || sec.sector}</td>
                      <td>{sec.pci ?? '—'}</td>
                      <td>{sec.azimuth ?? '—'}°</td>
                      {auditData.sector_fields.map((f) => {
                        const cell = sec.values[f]
                        return (
                          <td key={f} title={cell.source === 'site' ? 'No per-sector measurement — showing site aggregate' : cell.source === 'sector' ? 'Real per-sector measurement' : ''}>
                            {cell.value === null ? '—' : cell.value.toFixed(1)}
                            {cell.source === 'site' && <span className="muted" style={{ marginLeft: 4 }}>(site)</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ marginTop: 8 }}>
                "(site)" means this sector has no measurement of its own for that KPI — the site-wide aggregate is
                shown instead, never an invented value.
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'findings' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span className="muted">Auto-generated from checklist + measurements + live KPIs</span>
          </div>
          {findings.length === 0 && (
            <div className="form-success">✓ No findings — site passes all checked criteria</div>
          )}
          {findings.length > 0 && (
            <>
              <p className="muted">
                {findings.length} finding(s) — {findings.filter((f) => f.sev === 'CRITICAL').length} critical, {findings.filter((f) => f.sev === 'MAJOR').length} major
              </p>
              {findings.map((f, i) => (
                <div key={i} className="audit-finding">
                  <div className="audit-finding-bar" style={{ background: SEV_COLOR[f.sev] }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                      <span className="report-badge" style={{ background: `${SEV_COLOR[f.sev]}20`, color: SEV_COLOR[f.sev] }}>{f.sev}</span>
                      <span className="muted" style={{ fontSize: 10 }}>{f.cat}</span>
                      {f.note && <span className="muted" style={{ fontSize: 10, marginLeft: 'auto' }}>{f.note}</span>}
                    </div>
                    <div style={{ fontWeight: 700 }}>{i + 1}. {f.title}</div>
                    <div style={{ fontSize: 12, color: '#b6bcc8', margin: '2px 0' }}>{f.detail}</div>
                    <div style={{ fontSize: 12, color: '#7f77dd' }}>→ {f.action}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'report' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: overall >= 75 ? '#4ade80' : overall >= 50 ? '#fbbf24' : '#f87171' }}>{overall}/100</span>
            <span className="muted">{grade}</span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button className="btn-secondary btn-small" onClick={downloadReport} type="button">⬇ Download .txt</button>
              <button className="btn-secondary btn-small" onClick={copyReport} type="button">⎘ Copy</button>
              {canManageAudit && (
                <button className="btn-primary btn-small" onClick={handleSave} disabled={saveReport.isPending} type="button">
                  {saveReport.isPending ? 'Saving…' : '🗂 Save'}
                </button>
              )}
            </div>
          </div>
          {savedMsg && <div className="form-success">{savedMsg}</div>}
          {saveErr && <div className="form-error">{saveErr}</div>}
          <div className="md-report" dangerouslySetInnerHTML={{ __html: renderMarkdown(reportMarkdown) }} />

          {canManageAudit && (
            <div style={{ marginTop: 20 }}>
              <h2>Saved Audit History — {site?.name || siteId}</h2>
              {!history?.length && <p className="muted">No saved audits for this site yet.</p>}
              {!!history?.length && (
                <table className="admin-table">
                  <thead><tr><th>Date</th><th>Score</th><th>By</th><th></th></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <Fragment key={h.id}>
                        <tr>
                          <td>{new Date(h.created_at).toLocaleString('en-GB')}</td>
                          <td>{h.score ?? '—'}/100</td>
                          <td>{h.created_by_name ?? '—'}</td>
                          <td className="admin-table-actions">
                            <button className="btn-secondary btn-small" type="button" onClick={() => setExpandedHistoryId(expandedHistoryId === h.id ? null : h.id)}>
                              {expandedHistoryId === h.id ? 'Hide' : 'View'}
                            </button>
                            <button className="btn-danger btn-small" type="button" onClick={() => deleteReport.mutate(h.id)}>Delete</button>
                          </td>
                        </tr>
                        {expandedHistoryId === h.id && (
                          <tr>
                            <td colSpan={4}>
                              <div className="md-report" dangerouslySetInnerHTML={{ __html: renderMarkdown(h.content) }} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
