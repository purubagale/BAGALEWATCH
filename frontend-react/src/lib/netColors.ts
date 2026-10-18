// Colours of the networks a phone was on (2026-10-16), the same in every
// Subscriber Profile chart. The values live in App.css (--sp-net-*), one set
// per theme, checked with the palette validator; the earlier 3G indigo and
// 5G violet could not be told apart. Colour follows the network, never its
// rank, so a filter that drops one network does not repaint the others.

const VAR: Record<string, string> = {
  LTE: '--sp-net-4g', NR: '--sp-net-5g', UMTS: '--sp-net-3g', GSM: '--sp-net-2g',
}

export const NET_LABEL: Record<string, string> = { LTE: '4G', NR: '5G', UMTS: '3G', GSM: '2G' }

/** For CSS and SVG style props: `style={{ fill: netColor(n) }}`. */
export function netColor(networkType: string): string {
  return `var(${VAR[networkType] ?? '--sp-net-none'})`
}

/** A plain hex, for places that cannot read CSS variables (map markers). */
export function netHex(networkType: string): string {
  const light = document.documentElement.dataset.theme === 'light'
  const dark: Record<string, string> = { LTE: '#0aa0bd', NR: '#df5b9c', UMTS: '#7f7cec', GSM: '#c4860f' }
  const lite: Record<string, string> = { LTE: '#0891b2', NR: '#db2777', UMTS: '#4f46e5', GSM: '#d97706' }
  return (light ? lite : dark)[networkType] ?? (light ? '#94a3b8' : '#64748b')
}

/** Order networks are listed in, newest technology first. */
export const NET_ORDER = ['NR', 'LTE', 'UMTS', 'GSM']
