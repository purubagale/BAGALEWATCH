// Page every table in the app (2026-10-15). Rather than add a pager to
// each of some forty pages, this watches the page and, for any table with
// more rows than one page holds, hides the rows outside the current page
// and puts a bar under the table: rows per page, previous, next and
// "21–40 of 135". Rows are only hidden, never removed, so the page's own
// sorting, filters and exports are untouched.
//
// A row whose only cell spans several columns (an opened detail row, a
// note) stays with the row above it. A table marked data-pager="off" is
// left alone: it pages on the server or has its own pager.
import { DEFAULT_ROWS_PER_PAGE, ROWS_PER_PAGE_OPTIONS, getRowsPerPage, onRowsPerPageChange, setRowsPerPage } from './rowsPerPage'

const MIN_ROWS = ROWS_PER_PAGE_OPTIONS[0]

interface PagerState {
  page: number
  bar: HTMLDivElement
}

const states = new WeakMap<HTMLTableElement, PagerState>()
const bars = new Map<HTMLDivElement, HTMLTableElement>()

function rowGroups(table: HTMLTableElement): HTMLTableRowElement[][] {
  const groups: HTMLTableRowElement[][] = []
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      const cells = row.cells
      const attached = cells.length === 1 && cells[0].colSpan > 1 && groups.length > 0
      if (attached) groups[groups.length - 1].push(row)
      else groups.push([row])
    }
  }
  return groups
}

/** The element the bar goes after: the table, or a wrapper that holds
 * only the table (a scroll box), so the bar does not scroll sideways. */
function anchorOf(table: HTMLTableElement): Element {
  let el: Element = table
  while (el.parentElement && el.parentElement.children.length === 1 && el.parentElement.tagName === 'DIV'
    && !el.parentElement.matches('main, .admin-page, .site-card, .sp-card-body')) {
    el = el.parentElement
  }
  return el
}

function makeBar(table: HTMLTableElement): HTMLDivElement {
  const bar = document.createElement('div')
  bar.className = 'tbl-pager'
  bar.innerHTML =
    '<label class="tbl-pager-size">Rows per page <select></select></label>' +
    '<span class="tbl-pager-range"></span>' +
    '<button type="button" class="tbl-pager-prev" title="Previous page">‹</button>' +
    '<span class="tbl-pager-page"></span>' +
    '<button type="button" class="tbl-pager-next" title="Next page">›</button>'
  const select = bar.querySelector('select')!
  for (const n of ROWS_PER_PAGE_OPTIONS) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = String(n)
    select.appendChild(o)
  }
  select.addEventListener('change', () => setRowsPerPage(Number(select.value)))
  bar.querySelector('.tbl-pager-prev')!.addEventListener('click', () => turn(table, -1))
  bar.querySelector('.tbl-pager-next')!.addEventListener('click', () => turn(table, 1))
  bars.set(bar, table)
  return bar
}

function turn(table: HTMLTableElement, step: number) {
  const st = states.get(table)
  if (!st) return
  st.page += step
  apply(table)
}

function setText(el: Element | null, text: string) {
  if (el && el.textContent !== text) el.textContent = text
}

function apply(table: HTMLTableElement) {
  const size = getRowsPerPage() || DEFAULT_ROWS_PER_PAGE
  const groups = rowGroups(table)
  let st = states.get(table)
  if (groups.length <= MIN_ROWS) {
    // Short table: show every row and no bar.
    if (st) {
      for (const g of groups) for (const r of g) if (r.hidden) r.hidden = false
      st.bar.remove()
      bars.delete(st.bar)
      states.delete(table)
    }
    return
  }
  if (!st) {
    st = { page: 0, bar: makeBar(table) }
    states.set(table, st)
  }
  const pages = Math.max(1, Math.ceil(groups.length / size))
  st.page = Math.min(Math.max(0, st.page), pages - 1)
  const from = st.page * size
  const to = Math.min(groups.length, from + size)
  groups.forEach((g, i) => {
    const hide = i < from || i >= to
    for (const r of g) if (r.hidden !== hide) r.hidden = hide
  })
  const anchor = anchorOf(table)
  if (anchor.nextElementSibling !== st.bar) anchor.after(st.bar)
  const select = st.bar.querySelector('select')!
  if (select.value !== String(size)) select.value = String(size)
  setText(st.bar.querySelector('.tbl-pager-range'), `${from + 1}–${to} of ${groups.length}`)
  setText(st.bar.querySelector('.tbl-pager-page'), `Page ${st.page + 1} of ${pages}`)
  ;(st.bar.querySelector('.tbl-pager-prev') as HTMLButtonElement).disabled = st.page === 0
  ;(st.bar.querySelector('.tbl-pager-next') as HTMLButtonElement).disabled = st.page >= pages - 1
}

function scan(root: HTMLElement) {
  for (const [bar, table] of Array.from(bars)) {
    // A bar whose table has gone (the page changed) goes with it.
    if (!table.isConnected) {
      bar.remove()
      bars.delete(bar)
      states.delete(table)
    }
  }
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.dataset.pager === 'off' || table.closest('.leaflet-container')) continue
    apply(table)
  }
}

/** Starts paging every table under `root`; returns a function that stops. */
export function installTablePager(root: HTMLElement = document.body): () => void {
  let raf = 0
  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      scan(root)
    })
  }
  const observer = new MutationObserver((records) => {
    // Our own bar changes are not a reason to scan again.
    // Nor are map tiles and markers moving.
    if (records.every((r) => r.target instanceof Element && r.target.closest('.tbl-pager, .leaflet-container'))) return
    schedule()
  })
  observer.observe(root, { childList: true, subtree: true })
  const stopSize = onRowsPerPageChange(() => {
    // A new size starts every table from its first page.
    for (const table of Array.from(root.querySelectorAll('table'))) {
      const st = states.get(table)
      if (st) st.page = 0
    }
    schedule()
  })
  schedule()
  return () => {
    observer.disconnect()
    stopSize()
    if (raf) cancelAnimationFrame(raf)
  }
}
