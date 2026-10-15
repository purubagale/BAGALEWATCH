import { ROWS_PER_PAGE_OPTIONS, useRowsPerPage } from '../lib/rowsPerPage'

/** "Rows per page" picker for tables that page on their own (the server
 * pages, or the page has its own pager). Other tables get the same picker
 * from the shared table pager. */
export default function RowsPerPageSelect() {
  const [n, setN] = useRowsPerPage()
  return (
    <label className="tbl-pager-size">
      Rows per page
      <select value={n} onChange={(e) => setN(Number(e.target.value))}>
        {ROWS_PER_PAGE_OPTIONS.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  )
}
