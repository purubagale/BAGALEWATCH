import type { DtPurpose } from '../api/types'

// Why a drive was run (2026-10-14, core/dt_retention.py). Only yearly drives
// count toward "the latest yearly drives" of a place when old readings are
// reduced to summaries, so the upload asks for it every time.
export const PURPOSE_OPTIONS: { value: DtPurpose; label: string }[] = [
  { value: 'yearly', label: 'Yearly (NTA)' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'optimization', label: 'Optimization' },
  { value: 'other', label: 'Other' },
]

export function purposeLabel(value: string | undefined) {
  return PURPOSE_OPTIONS.find((p) => p.value === value)?.label ?? 'Other'
}

export function PurposeSelect({
  value,
  onChange,
  placeholder = 'Purpose of the drive…',
}: {
  value: DtPurpose | ''
  onChange: (v: DtPurpose) => void
  placeholder?: string
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as DtPurpose)}>
      {value === '' && <option value="">{placeholder}</option>}
      {PURPOSE_OPTIONS.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  )
}

/** SHA-256 of a file's bytes, as hex. Worked out in the browser only: the
 * file itself is never sent; the fingerprint finds a re-upload. */
export async function fileFingerprint(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** One fingerprint for a session made from several files. */
export async function combinedFingerprint(hashes: string[]): Promise<string> {
  if (hashes.length === 1) return hashes[0]
  const text = new TextEncoder().encode([...hashes].sort().join('|'))
  return fileFingerprint(text.buffer as ArrayBuffer)
}
