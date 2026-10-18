import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useSubscriberProvisioning } from '../api/queries'
import type { SubscriberAnalytics } from '../api/types'
import { netColor } from '../lib/netColors'
import { ColumnChart, ShareBar } from './ProfileCharts'

// What NTC's other systems hold for the number (2026-10-16), as two cards
// since 2026-10-19, after the user's UTS screenshots:
//   BI system   - usage per day, the network split and the cells the
//                 customer used (location history: emergency only).
//   OSS & Core  - HSS/SPR provisioning (4G, VoLTE, SIM, plan) and the
//                 device with its bands, set against what the phone measured.
// Both come from one source, asked only when a window is opened. On the
// profile they sit at the end, after this system's own details.

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const yesNo = (v: boolean | null | undefined, yes: string, no: string) => (v == null ? 'Not known' : v ? yes : no)
// A band label as the readings name it ("B3 (1800)") reduced to "B3".
const seenToken = (label: string) => label.split(' ')[0]
const titleCase = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

type Kind = 'bi' | 'core'
type Tab = 'usage' | 'location' | 'subscription' | 'device'

const KINDS: Record<Kind, { id: string; icon: string; title: string; window: string; button: string; tabs: [Tab, string][] }> = {
  bi: {
    id: 'sp-bi', icon: '📊', title: 'Subscriber usage & location history', window: 'BI system: usage & location history',
    button: 'Open BI usage', tabs: [['usage', 'Usage'], ['location', 'Location history']],
  },
  core: {
    id: 'sp-oss', icon: '🛰️', title: 'Core network diagnostics (MME / MSC / PGW / HSS / SPR)', window: 'OSS & Core',
    button: 'Run core network diagnostics', tabs: [['subscription', 'Subscription & provisioning'], ['device', 'Device & bands']],
  },
}

export default function ProfileProvisioning({ kind, msisdn, reason, analytics, callsByOutcome, emergency }: {
  kind: Kind; msisdn: string; reason: string; analytics: SubscriberAnalytics | null | undefined
  callsByOutcome: Record<string, number>; emergency: boolean
}) {
  const k = KINDS[kind]
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>(k.tabs[0][0])
  const { data, isLoading, error, refetch, isFetching } = useSubscriberProvisioning(msisdn, reason, open, emergency)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const blurb = kind === 'bi'
    ? `Daily data, voice and SMS, the 2G/3G/4G split and the cell sites used by ${msisdn}${emergency ? '' : ' (cell sites only in an emergency)'}.`
    : 'HSS profile, 4G and VoLTE provisioning, SIM, SPR package and quota, and the device with its bands, set against what the phone measured.'

  return (
    <>
      <section className="sp-card spo-card" id={k.id}>
        <span className="spo-card-icon" aria-hidden>{k.icon}</span>
        <div className="spo-card-title">{k.title}</div>
        <p className="sp-muted">{blurb}</p>
        <button type="button" className="sp-btn" onClick={() => setOpen(true)}>{k.button}</button>
      </section>

      {open && (
        <div className="spo-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div className="spo-modal sp-page" role="dialog" aria-modal="true" aria-label={k.window}>
            <div className="spo-head">
              <span className="sp-card-icon" aria-hidden>{k.icon}</span>
              <div>
                <div className="spo-title">{k.window}</div>
                <span className="sp-chip info sp-mono">{msisdn}</span>
                {data?.data?.subscriber_name && <span className="sp-chip plain" style={{ marginLeft: 6 }}>{data.data.subscriber_name}</span>}
                {data?.data?.source === 'demo' && <span className="sp-chip warn" style={{ marginLeft: 6 }}>Demo data: not linked yet</span>}
              </div>
              <div className="spo-head-actions">
                <button type="button" className="sp-btn sp-btn-ghost" onClick={() => refetch()} disabled={isFetching}>{isFetching ? 'Asking…' : '↻ Refresh'}</button>
                <button type="button" className="sp-btn sp-btn-ghost" onClick={() => setOpen(false)}>Close</button>
              </div>
            </div>
            <div className="spo-tabs" role="tablist">
              {k.tabs.map(([t, label]) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {label}{t === 'location' && !emergency ? ' 🔒' : ''}
                </button>
              ))}
            </div>
            <div className="spo-body">
              {isLoading && <div className="sp-muted">Asking…</div>}
              {error && <div className="sp-alert err">{apiErrorMessage(error)}</div>}
              {data && !data.enabled && (
                <div className="sp-alert">This system is not linked yet. Once its team shares an API, it is set up in the server's configuration and this window fills in.</div>
              )}
              {data?.enabled && !data.data && <div className="sp-alert err">{data.error ?? 'No answer.'}</div>}
              {data?.data && (
                tab === 'usage' ? <Usage d={data.data} analytics={analytics} />
                  : tab === 'location' ? <Location rows={data.data.location_history} shown={!!data.location_shown} />
                    : tab === 'subscription' ? <Subscription d={data.data} analytics={analytics} callsByOutcome={callsByOutcome} />
                      : <Device d={data.data} analytics={analytics} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

type Data = NonNullable<NonNullable<ReturnType<typeof useSubscriberProvisioning>['data']>['data']>

function measured(analytics: SubscriberAnalytics | null | undefined, callsByOutcome: Record<string, number>) {
  const nets = analytics?.networks ?? []
  const total = nets.reduce((s, n) => s + n.readings, 0)
  const on4g = nets.filter((n) => n.network_type === 'LTE' || n.network_type === 'NR').reduce((s, n) => s + n.readings, 0)
  const calls = Object.values(callsByOutcome).reduce((a, b) => a + b, 0)
  return { total, on4g, calls, volteShare: pct(callsByOutcome.volte ?? 0, calls) }
}

function Subscription({ d, analytics, callsByOutcome }: {
  d: Data; analytics: SubscriberAnalytics | null | undefined; callsByOutcome: Record<string, number>
}) {
  const { total, on4g, calls, volteShare } = measured(analytics, callsByOutcome)
  const verdicts: { level: 'bad' | 'warn' | 'ok'; text: string }[] = []
  if (d.lte_provisioned === false && total) {
    verdicts.push({ level: 'bad', text: `4G is not provisioned for this number: the phone was on 4G for only ${pct(on4g, total)}% of its readings. Provisioning 4G, not coverage, is the fix.` })
  }
  if (d.usim === false) {
    verdicts.push({ level: 'bad', text: `The SIM is not a 4G SIM (${d.sim_type ?? 'standard SIM'}): the customer needs a 4G USIM to use 4G.` })
  }
  if (d.volte_provisioned === false && calls) {
    verdicts.push({ level: 'warn', text: `VoLTE is not provisioned: calls fall back to 2G/3G (${100 - volteShare}% of ${calls} recorded calls did).` })
  }
  const missing = d.ntc_bands.filter((b) => b.supported === false)
  if (missing.length) {
    verdicts.push({ level: missing.some((b) => b.token === 'B20' || b.token === 'B3') ? 'bad' : 'warn',
      text: `The phone does not support ${missing.map((b) => b.label).join(', ')}.${missing.some((b) => b.token === 'B20') ? ' Without Band 20 it loses 4G in rural and deep-indoor areas.' : ''}` })
  }
  if (d.lte_provisioned && d.usim !== false && total && pct(on4g, total) < 50) {
    verdicts.push({ level: 'warn', text: `4G is provisioned and the SIM supports it, yet the phone was on 4G for only ${pct(on4g, total)}% of readings: check coverage where the customer is, and the phone's network-mode setting.` })
  }
  if (!verdicts.length) verdicts.push({ level: 'ok', text: "Nothing in the provisioning explains a problem: 4G, the SIM and the phone's bands are in order." })
  const used = d.data_used_gb, totalGb = d.data_total_gb
  return (
    <>
      <div className="spc-tiles">
        <div className="spc-tile"><span>Customer</span><b className="spc-small">{d.subscriber_name ?? '—'}</b><small>{[d.billing_type, d.status].filter(Boolean).join(' · ')}</small></div>
        <div className="spc-tile"><span>4G service</span><b className="spc-small">{yesNo(d.lte_provisioned, 'Provisioned', 'Not provisioned')}</b>
          <small>measured: {pct(on4g, total)}% of readings on 4G/5G</small>
          <div className="spc-meter"><i style={{ width: `${pct(on4g, total)}%`, background: 'var(--sp-net-4g)' }} /></div></div>
        <div className="spc-tile"><span>SIM</span><b className="spc-small">{d.sim_type ?? yesNo(d.usim, '4G USIM', 'Standard SIM')}</b></div>
        <div className="spc-tile"><span>VoLTE</span><b className="spc-small">{yesNo(d.volte_provisioned, 'Provisioned', 'Not provisioned')}</b>
          <small>{calls ? `measured: ${volteShare}% of ${calls} calls on VoLTE` : 'no calls recorded'}</small>
          {calls ? <div className="spc-meter"><i style={{ width: `${volteShare}%`, background: 'var(--sp-green)' }} /></div> : null}</div>
        <div className="spc-tile"><span>Roaming</span><b className="spc-small">{yesNo(d.roaming, 'Enabled', 'Not active')}</b></div>
        <div className="spc-tile"><span>Plan</span><b className="spc-small">{d.plan_name ?? '—'}</b>
          {used != null && totalGb ? (
            <>
              <small>{used} of {totalGb} GB used ({pct(used, totalGb)}%)</small>
              <div className="spc-meter"><i style={{ width: `${Math.min(100, pct(used, totalGb))}%`, background: 'var(--sp-cyan)' }} /></div>
            </>
          ) : null}</div>
      </div>
      <div className="spc-verdicts">
        {verdicts.map((v, i) => (
          <div key={i} className={`spc-verdict ${v.level}`}>
            <span aria-hidden>{v.level === 'bad' ? '⛔' : v.level === 'warn' ? '⚠️' : '✅'}</span>
            <span className="sr-only">{v.level === 'bad' ? 'Problem: ' : v.level === 'warn' ? 'Check: ' : 'OK: '}</span>
            {v.text}
          </div>
        ))}
      </div>
    </>
  )
}

function Device({ d, analytics }: { d: Data; analytics: SubscriberAnalytics | null | undefined }) {
  const seen = new Map<string, number>()
  for (const b of analytics?.bands ?? []) seen.set(seenToken(b.band_label), (seen.get(seenToken(b.band_label)) ?? 0) + b.readings)
  const bandSeenTotal = [...seen.values()].reduce((a, b) => a + b, 0)
  const supported = d.ntc_bands.filter((b) => b.supported).length
  return (
    <>
      <div className="spc-tiles">
        <div className="spc-tile"><span>Brand</span><b className="spc-small">{d.device_brand ?? '—'}</b></div>
        <div className="spc-tile"><span>Model</span><b className="spc-small">{d.device_model ?? '—'}</b></div>
        <div className="spc-tile"><span>IMEI</span><b className="spc-small sp-mono">{d.imei ?? '—'}</b></div>
        <div className="spc-tile"><span>NTC bands supported</span><b>{d.supported_bands.length ? `${supported} / ${d.ntc_bands.length}` : '—'}</b></div>
      </div>
      <div className="spc-mini-title">NTC's bands <span className="sp-muted">· supported by the phone, and how often it was seen on each</span></div>
      <div className="spc-bands">
        {d.ntc_bands.map((b) => {
          const n = seen.get(b.token) ?? 0
          return (
            <div key={b.token} className={`spc-band ${b.supported === false ? 'no' : b.supported ? 'yes' : ''}`}>
              <div className="spc-band-top">
                <b>{b.label}</b>
                <em>{b.supported == null ? 'Not known' : b.supported ? '✓ Supported' : '✗ Not supported'}</em>
              </div>
              <small>{b.tech} · {b.use}</small>
              {(b.tech === '4G' || b.tech === '5G') && (
                <>
                  <div className="spc-meter" title={`${n} readings`}>
                    <i style={{ width: `${pct(n, bandSeenTotal)}%`, background: b.tech === '5G' ? 'var(--sp-net-5g)' : 'var(--sp-net-4g)' }} />
                  </div>
                  <small>{bandSeenTotal ? `${pct(n, bandSeenTotal)}% of 4G/5G readings` : 'No band in the readings'}</small>
                </>
              )}
            </div>
          )
        })}
      </div>
      {d.supported_bands.length > 0 && (
        <>
          <div className="spc-mini-title" style={{ marginTop: 10 }}>All {d.supported_bands.length} bands the phone supports</div>
          <div className="spc-chips">{d.supported_bands.map((b) => <em key={b}>{b}</em>)}</div>
        </>
      )}
    </>
  )
}

const SPLIT_NET: Record<string, string> = { '5G': 'NR', '4G': 'LTE', '3G': 'UMTS', '2G': 'GSM' }

function Usage({ d, analytics }: { d: Data; analytics: SubscriberAnalytics | null | undefined }) {
  const days = d.usage_daily ?? []
  const split = d.network_split ?? {}
  const nets = analytics?.networks ?? []
  const measuredTotal = nets.reduce((a, n) => a + n.readings, 0)
  const measuredBy = (net: string) => nets.filter((n) => n.network_type === net).reduce((a, n) => a + n.readings, 0)
  const sum = (key: 'data_mb' | 'voice_min' | 'sms') => days.reduce((a, r) => a + (r[key] ?? 0), 0)
  const used = d.data_used_gb, totalGb = d.data_total_gb
  return (
    <>
      <div className="spc-tiles">
        <div className="spc-tile"><span>Plan</span><b className="spc-small">{d.plan_name ?? '—'}</b>
          {used != null && totalGb ? (
            <>
              <small>{used} of {totalGb} GB used ({pct(used, totalGb)}%)</small>
              <div className="spc-meter"><i style={{ width: `${Math.min(100, pct(used, totalGb))}%`, background: 'var(--sp-cyan)' }} /></div>
            </>
          ) : null}</div>
        <div className="spc-tile"><span>Data, {days.length} days</span><b>{(sum('data_mb') / 1024).toFixed(2)}<small> GB</small></b></div>
        <div className="spc-tile"><span>Voice</span><b>{Math.round(sum('voice_min'))}<small> min</small></b></div>
        <div className="spc-tile"><span>SMS</span><b>{Math.round(sum('sms'))}</b></div>
      </div>
      {days.length > 0 && (
        <>
          <div className="spc-mini-title">Data per day <span className="sp-muted">· MB</span></div>
          <ColumnChart height={120} unit=" MB" every={Math.max(1, Math.ceil(days.length / 10))} ariaLabel="Data used per day"
            columns={days.map((r) => ({
              key: r.day, label: r.day.slice(5),
              segments: [{ key: 'data', value: r.data_mb ?? 0, color: 'var(--sp-cyan)', label: 'Data' }],
              tip: [r.day, `Data ${r.data_mb ?? 0} MB`, `Voice ${r.voice_min ?? 0} min`, `SMS ${r.sms ?? 0}`],
            }))} />
        </>
      )}
      {Object.keys(split).length > 0 && (
        <>
          <div className="spc-mini-title" style={{ marginTop: 10 }}>Network split</div>
          <div className="sp-muted" style={{ fontSize: 12, margin: '2px 0' }}>BI system (network's count)</div>
          <ShareBar parts={Object.entries(split).map(([net, v]) => ({ key: net, label: net, value: v, color: netColor(SPLIT_NET[net] ?? net) }))} />
          {measuredTotal > 0 && (
            <>
              <div className="sp-muted" style={{ fontSize: 12, margin: '8px 0 2px' }}>Measured by the phone (this system)</div>
              <ShareBar parts={Object.entries(SPLIT_NET).map(([label, net]) => ({ key: net, label, value: measuredBy(net), color: netColor(net) }))} />
            </>
          )}
        </>
      )}
      {!days.length && !Object.keys(split).length && <div className="sp-muted">The BI system returned no usage.</div>}
    </>
  )
}

function Location({ rows, shown }: { rows: Data['location_history']; shown: boolean }) {
  if (!shown) {
    return <div className="sp-alert">🔒 The network's location history (cells the customer used) is shown only while an emergency is declared.</div>
  }
  if (!rows || rows.length === 0) return <div className="sp-muted">The ticketing system returned no location history.</div>
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
  return (
    <>
      <div className="spc-mini-title">Cells visited · {rows.length}</div>
      <div className="sp-scroll">
        <table className="sp-table" data-pager="off">
          <thead><tr>{keys.map((k) => <th key={k}>{titleCase(k)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{keys.map((k) => <td key={k} className={typeof r[k] === 'number' ? 'mono' : ''}>{r[k] == null ? '—' : String(r[k])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
