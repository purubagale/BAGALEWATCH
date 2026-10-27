import type { ReactNode } from 'react'

// Readable measure tiles and card headers (2026-10-26), shared by the
// Problem Dashboard and its related data. One measure per tile: a rounded
// value, its unit and a plain verdict, with the same limits as the server's
// check (WEAK_DBM / GOOD_DBM in core/problem_report.py). The look follows
// NTC's ticketing system: a coloured icon chip, a small label, a strong value.

export type Verdict = { text: string; tone: 'good' | 'fair' | 'bad' } | null

export function round(v: number | null | undefined, digits = 1) {
  if (v == null) return null
  const f = 10 ** digits
  return Math.round(v * f) / f
}

const LEVEL_LIMITS: Record<string, [number, number]> = { '4G': [-110, -100], '3G': [-105, -95], '2G': [-100, -85] }

export function techOfNet(net: string | null | undefined) {
  return net === 'LTE' || net === 'NR' ? '4G' : net === 'UMTS' ? '3G' : net === 'GSM' ? '2G' : null
}

/** Level verdict by technology; `tech` may be a network name (LTE) or 4G/3G/2G. */
export function rateLevel(tech: string | null | undefined, v: number | null | undefined): Verdict {
  const key = tech && LEVEL_LIMITS[tech] ? tech : techOfNet(tech) ?? '4G'
  const lim = LEVEL_LIMITS[key]
  if (v == null) return null
  return v < lim[0] ? { text: 'Weak', tone: 'bad' } : v >= lim[1] ? { text: 'Good', tone: 'good' } : { text: 'Fair', tone: 'fair' }
}

export function rate(v: number | null | undefined, good: number, bad: number, higherIsBetter = true,
  words = ['Good', 'Fair', 'Poor']): Verdict {
  if (v == null) return null
  const isGood = higherIsBetter ? v >= good : v <= good
  const isBad = higherIsBetter ? v < bad : v > bad
  return isGood ? { text: words[0], tone: 'good' } : isBad ? { text: words[2], tone: 'bad' } : { text: words[1], tone: 'fair' }
}

export type Hue = 'blue' | 'cyan' | 'green' | 'amber' | 'red' | 'violet' | 'slate'

export function Tile({ label, value, unit, verdict, hint, icon, hue }: {
  label: string; value: ReactNode; unit?: string; verdict?: Verdict; hint?: string; icon?: string; hue?: Hue
}) {
  const empty = value == null || value === ''
  const tone = verdict?.tone
  return (
    <div className={`pd-tile${tone ? ` pd-tile-${tone}` : ''}`}>
      <div className="pd-tile-top">
        <span className="pd-tile-label">{label}</span>
        {icon && <span className={`pd-ic pd-ic-${hue ?? (tone === 'bad' ? 'red' : tone === 'fair' ? 'amber' : tone === 'good' ? 'green' : 'blue')}`}>{icon}</span>}
      </div>
      <div className={`pd-tile-value${tone ? ` pd-val-${tone}` : ''}`}>{empty ? '—' : value}{!empty && unit ? <small> {unit}</small> : null}</div>
      {(verdict || hint) && (
        <div className="pd-tile-foot">
          {verdict && <span className={`pd-verdict pd-verdict-${verdict.tone}`}>{verdict.text}</span>}
          {hint && <span className="muted">{verdict ? ' · ' : ''}{hint}</span>}
        </div>
      )}
    </div>
  )
}

/** A card header: icon chip, title and a short subtitle on one line, optional actions on the right. */
export function CardHead({ icon, title, sub, hue = 'blue', right }: {
  icon: string; title: ReactNode; sub?: ReactNode; hue?: Hue; right?: ReactNode
}) {
  return (
    <div className="pd-cardhead">
      <span className={`pd-ic pd-ic-${hue}`}>{icon}</span>
      <div className="pd-cardhead-text">
        <span className="pd-cardhead-title">{title}</span>
        {sub && <span className="pd-cardhead-sub">{sub}</span>}
      </div>
      {right && <div className="pd-cardhead-right">{right}</div>}
    </div>
  )
}

/** A soft blue band that heads a group inside a card. */
export function Band({ icon, children, right }: { icon?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="pd-band">
      <span>{icon ? `${icon} ` : ''}{children}</span>
      {right && <span className="pd-band-right">{right}</span>}
    </div>
  )
}
