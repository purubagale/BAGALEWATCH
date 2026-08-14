// Shared status color/label table — was previously duplicated inline in
// SidebarTree.tsx; pulled out here 2026-07-30 so the new Topology page
// (whose filter chips need the labels too, not just the dot colors) uses
// the exact same values instead of a second hand-copied table drifting
// out of sync. Matches v1's rsrpDotColor-adjacent STATUS_COLOR/labels
// (bts_monitor.html) — 'ok' | 'warn' | 'crit' | 'nodata' is the Site
// model's real status vocabulary (core/models.py's Site.status).

export const STATUS_COLOR: Record<string, string> = {
  ok: '#16a34a',
  warn: '#f59e0b',
  crit: '#dc2626',
  nodata: '#6b7280',
}

export const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  warn: 'Warning',
  crit: 'Critical',
  nodata: 'No KPI',
}

// Fixed display order for filter chips — All first, then worst-to-best
// isn't the convention v1 used (it went OK/Warning/Critical/No KPI, i.e.
// the order status naturally trends from good to bad to unknown), kept
// identical here for familiarity.
export const STATUS_ORDER: string[] = ['ok', 'warn', 'crit', 'nodata']

export function statusColor(status: string | null | undefined): string {
  return STATUS_COLOR[status ?? ''] ?? STATUS_COLOR.nodata
}
