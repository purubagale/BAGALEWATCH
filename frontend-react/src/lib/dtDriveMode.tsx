import { useState } from 'react'

// Curated "Drive Mode" options (2026-09-23) -- real drive tests for one
// site are re-run per mode (Free Mode / a specific band-lock / Idle vs an
// active DL/UL session), not just once, and there was no way to tell two
// same-site/same-tech sessions apart by which mode they were driven in.
// Deliberately just UI convenience, not a schema constraint --
// DriveTestSession.mode is a plain CharField (see its docstring), so
// typing anything else into the "Custom…" option below always works too.
// Shared between DtUploadPage.tsx (set at upload time) and
// DtSessionHistoryPage.tsx (editable after the fact, same "one dedicated
// field, one small edit action" convention as remarks).
export const DRIVE_MODE_OPTIONS = ['Free Mode', 'B3 Lock', 'B20 Lock', 'Idle']

/** Small "Drive Mode" picker -- curated dropdown + a "Custom…" free-text
 * fallback, since DriveTestSession.mode is a plain CharField (any string
 * is valid, the dropdown above is just convenience). */
export function DriveModeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [customMode, setCustomMode] = useState(value !== '' && !DRIVE_MODE_OPTIONS.includes(value))
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select
        value={customMode ? '__custom__' : value}
        onChange={(e) => {
          if (e.target.value === '__custom__') {
            setCustomMode(true)
            return
          }
          setCustomMode(false)
          onChange(e.target.value)
        }}
      >
        <option value="">Drive Mode (optional)</option>
        {DRIVE_MODE_OPTIONS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      {customMode && (
        <input
          type="text"
          placeholder="Custom mode"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 130 }}
        />
      )}
    </span>
  )
}
