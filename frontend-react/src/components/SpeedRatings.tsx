// How good a speed test is for four everyday uses (2026-10-29, like Ookla's
// dots; worked out on the server by core/speed_quality.py).

export type SpeedRatingLevel = 'poor' | 'fair' | 'good' | 'very_good'
export type SpeedRatingMap = Partial<Record<'browsing' | 'video' | 'gaming' | 'video_call', SpeedRatingLevel>>

const USES: [keyof SpeedRatingMap, string, string][] = [
  ['browsing', 'Browsing', '🌐'], ['video', 'Video streaming', '▶'], ['gaming', 'Gaming', '🎮'], ['video_call', 'Video calls', '📹'],
]
const LEVEL: Record<SpeedRatingLevel, { label: string; dots: number; color: string }> = {
  poor: { label: 'Poor', dots: 1, color: '#dc2626' },
  fair: { label: 'Fair', dots: 2, color: '#f97316' },
  good: { label: 'Good', dots: 3, color: '#16a34a' },
  very_good: { label: 'Very good', dots: 4, color: '#15803d' },
}

/** Four small "use: dots" badges; nothing when there is no rating. */
export default function SpeedRatings({ ratings, compact = false }: { ratings?: SpeedRatingMap | null; compact?: boolean }) {
  if (!ratings || !Object.keys(ratings).length) return compact ? <span className="muted">—</span> : null
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: compact ? 6 : 10 }}>
      {USES.map(([key, label, icon]) => {
        const level = ratings[key]
        if (!level) return null
        const l = LEVEL[level]
        return (
          <span key={key} title={`${label}: ${l.label}`} style={{ whiteSpace: 'nowrap', fontSize: compact ? 11 : 12 }}>
            {icon}{!compact && ` ${label}`}{' '}
            <span style={{ color: l.color, letterSpacing: 1 }}>{'●'.repeat(l.dots)}</span>
            <span style={{ color: '#cbd5e1', letterSpacing: 1 }}>{'●'.repeat(4 - l.dots)}</span>
            {!compact && <span className="muted"> {l.label}</span>}
          </span>
        )
      })}
    </span>
  )
}

/** "180 / 349 ms" for the ping during download / upload. */
export function loadedLabel(down?: number | null, up?: number | null) {
  if (down == null && up == null) return '—'
  const f = (v?: number | null) => (v == null ? '—' : String(Math.round(v)))
  return `${f(down)} / ${f(up)} ms`
}
