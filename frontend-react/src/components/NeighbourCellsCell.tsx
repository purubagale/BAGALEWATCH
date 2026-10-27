import type { NeighbourCell } from '../api/types'

// The other cells a phone heard with one reading (2026-10-27): a count that
// opens to the list, strongest of the serving technology first, as the phone
// sent them.

export function neighbourText(c: NeighbourCell): string {
  const id = c.net === 'LTE' ? `PCI ${c.pci}` : c.net === 'UMTS' ? `PSC ${c.psc}` : `BCCH ${c.bcch}${c.bsic != null ? `/${c.bsic}` : ''}`
  const level = c.net === 'LTE' ? c.rsrp : c.net === 'UMTS' ? c.rscp : c.rssi
  const quality = c.net === 'LTE' && c.rsrq != null ? ` ${c.rsrq} dB` : c.net === 'UMTS' && c.ecio != null ? ` Ec/Io ${c.ecio}` : ''
  const tech = c.net === 'LTE' ? '4G' : c.net === 'UMTS' ? '3G' : '2G'
  const site = c.site ? ` · ${c.site}${c.sector ? ` ${c.sector}` : ''}${c.km != null ? ` (${c.km} km)` : ''}` : ''
  return `${tech} ${id} · ${level ?? '—'} dBm${quality}${site}`
}

export default function NeighbourCellsCell({ cells }: { cells?: NeighbourCell[] | null }) {
  if (!cells || cells.length === 0) return <>—</>
  return (
    <details className="neighbour-cells">
      <summary title={cells.map(neighbourText).join('\n')}>{cells.length}</summary>
      <ul style={{ margin: '4px 0 0', paddingLeft: 16, whiteSpace: 'nowrap', fontSize: '0.92em' }}>
        {cells.map((c, i) => <li key={i}>{neighbourText(c)}</li>)}
      </ul>
    </details>
  )
}
