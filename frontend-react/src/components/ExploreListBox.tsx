import { useEffect, useState, type ReactNode } from 'react'

// One list of the Explore page (2026-10-28, "manage listing in table inside
// box with option to display, default no. of display is 10"): a boxed
// table with its own rows-per-page choice. Explore keeps 10 as its default
// rather than the app-wide choice, so three lists fit under the map.

const SIZES = [10, 20, 50, 100] as const

export interface ExploreColumn<T> {
  label: ReactNode
  title?: string
  cell: (row: T) => ReactNode
  className?: string
}

export default function ExploreListBox<T>({
  title, count, rows, rowKey, columns, empty, head, foot, selectedOf, onToggle, onToggleAll, rowClass, onRowClick,
}: {
  title: string
  count: number
  rows: T[]
  rowKey: (row: T) => string | number
  columns: ExploreColumn<T>[]
  empty: ReactNode
  head?: ReactNode
  foot?: ReactNode
  // Tick boxes: given, each row gets one and the header ticks all of them.
  selectedOf?: (row: T) => boolean
  onToggle?: (row: T) => void
  onToggleAll?: (on: boolean) => void
  rowClass?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
}) {
  const [size, setSize] = useState<number>(10)
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1)
  }, [page, pages])
  const shown = rows.slice(page * size, page * size + size)
  const ticks = !!selectedOf && !!onToggle
  const ticked = ticks ? rows.filter((r) => selectedOf!(r)).length : 0

  return (
    <section className="dt-explore-box">
      <div className="dt-explore-box-head">
        <b>{title}</b>
        <span className="muted">
          {ticks ? `${ticked} of ${count} shown on the map` : count}
        </span>
        {head}
      </div>
      {rows.length === 0 ? (
        <div className="muted dt-explore-box-empty">{empty}</div>
      ) : (
        <>
          <div className="dt-explore-box-scroll">
            <table className="dt-explore-box-table" data-pager="off">
              <thead>
                <tr>
                  {ticks && (
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label="Show all on the map"
                        title="Show all on the map, or none"
                        checked={ticked === rows.length}
                        ref={(el) => { if (el) el.indeterminate = ticked > 0 && ticked < rows.length }}
                        onChange={(e) => onToggleAll?.(e.target.checked)}
                      />
                    </th>
                  )}
                  {columns.map((c, i) => <th key={i} title={c.title} className={c.className}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={rowKey(r)}
                    className={[rowClass?.(r), ticks && !selectedOf!(r) ? 'off' : '', onRowClick ? 'clickable' : '']
                      .filter(Boolean).join(' ') || undefined}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                  >
                    {ticks && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label="Show on the map"
                          checked={selectedOf!(r)}
                          onChange={() => onToggle!(r)}
                        />
                      </td>
                    )}
                    {columns.map((c, i) => <td key={i} className={c.className}>{c.cell(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dt-explore-box-pager">
            <label>
              Show
              <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0) }}>
                {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="muted">
              {page * size + 1}–{Math.min(rows.length, page * size + size)} of {rows.length}
            </span>
            <button type="button" className="btn-secondary btn-small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
            <button type="button" className="btn-secondary btn-small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
          </div>
        </>
      )}
      {foot && <div className="muted dt-explore-box-foot">{foot}</div>}
    </section>
  )
}
