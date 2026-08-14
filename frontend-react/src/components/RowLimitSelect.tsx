// Shared "how many rows to render" control (2026-08-07) — every table
// that can be driven by a query over the full ~4,700-site dataset needs
// SOME cap to avoid the unbounded-DOM-render crash class documented in
// AdvancedSiteSearchModal.tsx/SlaTrackerPage.tsx/NtaCompliancePage.tsx
// (see the memory/size/security audit, docs/v2_memory_size_security_audit_
// 2026-08-07.md). Per explicit follow-up request, the fixed 300-row cap
// built for that audit is replaced everywhere with a user-adjustable one,
// defaulting to 50 for the best memory/render-cost floor, with larger
// steps available for whoever actually wants to scroll through more.
// CSV export (where it exists) always operates on the full, unfiltered
// result set regardless of this control — exporting to a file was never
// the expensive part, only rendering rows into the DOM was.
export const ROW_LIMIT_OPTIONS = [50, 100, 150, 250, 500] as const
export const DEFAULT_ROW_LIMIT = 50

export default function RowLimitSelect({
  value,
  onChange,
  unit = 'rows',
}: {
  value: number
  onChange: (n: number) => void
  /** Label word after the number — "rows" fits a generic table, but a
   * specific page may read better with "sites"/"points"/etc. */
  unit?: string
}) {
  return (
    <label className="row-limit-select" title={`How many ${unit} to render at once — export/CSV always includes everything, regardless of this setting.`}>
      Show
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {ROW_LIMIT_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {unit}
    </label>
  )
}
