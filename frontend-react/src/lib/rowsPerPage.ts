// Rows per page for every table (2026-10-15, "for all tables, add a
// feature to define no. of rows to display in a page, default 20"). One
// choice for the whole app, kept in this browser; changing it on any table
// changes it on all of them.
import { useEffect, useState } from 'react'

export const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100, 200] as const
export const DEFAULT_ROWS_PER_PAGE = 20
const KEY = 'dtwatch_rows_per_page'
const EVENT = 'dtwatch-rows-per-page'

export function getRowsPerPage(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    if ((ROWS_PER_PAGE_OPTIONS as readonly number[]).includes(n)) return n
  } catch {
    // storage blocked: fall through to the default
  }
  return DEFAULT_ROWS_PER_PAGE
}

export function setRowsPerPage(n: number) {
  try {
    localStorage.setItem(KEY, String(n))
  } catch {
    // storage blocked: the choice still applies until the page reloads
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: n }))
}

export function onRowsPerPageChange(fn: (n: number) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<number>).detail)
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

export function useRowsPerPage(): [number, (n: number) => void] {
  const [n, setN] = useState(getRowsPerPage)
  useEffect(() => onRowsPerPageChange(setN), [])
  return [n, setRowsPerPage]
}
