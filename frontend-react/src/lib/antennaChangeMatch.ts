// Antenna-change review-time comparison (2026-09-29, "for the comparison
// with data currently in the db... comparison should be done with both
// before and after, mark it with green... if matched and red with data
// if not matched. no need to store comparison in db. it is only for
// analysis before save import.") — the vendor's own before_change/
// after_change columns (RfAntennaChangePreviewRow) are always free text,
// carried through unchanged from the .docx table ("10/0/2.5" style
// Azimuth/MT/ET); this compares that text against the matched Sector's
// CURRENT azimuth/mech_tilt/elec_tilt (current_azimuth/current_mech_tilt/
// current_elec_tilt, added to the parse-preview response the same day)
// purely for display in ImportWizard's review table — nothing here is
// ever sent back to the server.

// Small tolerance for float noise (2.5 vs 2.50, 10 vs 10.0000001), not
// loose enough to treat a genuinely different half-degree value as a
// match.
const EPSILON = 0.05

function parseAzMtEt(text: string): [number, number, number] | null {
  const parts = text.split('/').map((p) => p.trim())
  if (parts.length !== 3) return null
  const nums = parts.map((p) => parseFloat(p))
  if (nums.some((n) => !Number.isFinite(n))) return null
  return nums as [number, number, number]
}

function numericMatch(a: [number, number, number], b: [number, number, number]): boolean {
  return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON
}

/** Formats a sector's azimuth/mech_tilt/elec_tilt the same "Az/MT/ET"
 * shape the vendor's own before/after columns use, so the two read
 * naturally side by side. `—` for whichever of the three is null. */
export function formatAzMtEt(azimuth: number | null, mechTilt: number | null, elecTilt: number | null): string {
  return `${azimuth ?? '—'}/${mechTilt ?? '—'}/${elecTilt ?? '—'}`
}

export type AntennaMatchStatus = 'matched-before' | 'matched-after' | 'matched-both' | 'mismatch' | 'no-current-data'

export interface AntennaMatchResult {
  status: AntennaMatchStatus
  /** The matched sector's current Az/MT/ET, formatted — always populated
   * except when `status` is 'no-current-data' (no azimuth/tilt recorded
   * for this sector at all, nothing to compare against). */
  currentText: string
}

/** Compares a matched sector's CURRENT azimuth/mech_tilt/elec_tilt against
 * the vendor's own before_change/after_change text for that row. A sector
 * with no azimuth/tilt recorded at all (all three null) can't be
 * compared either way — reported as 'no-current-data', not a mismatch,
 * so the review table doesn't flag a site that simply has no engineering
 * data yet as a false "doesn't match" red. */
export function compareAntennaChange(
  currentAzimuth: number | null,
  currentMechTilt: number | null,
  currentElecTilt: number | null,
  beforeChange: string,
  afterChange: string,
): AntennaMatchResult {
  if (currentAzimuth == null && currentMechTilt == null && currentElecTilt == null) {
    return { status: 'no-current-data', currentText: '' }
  }
  const current: [number, number, number] = [currentAzimuth ?? 0, currentMechTilt ?? 0, currentElecTilt ?? 0]
  const currentText = formatAzMtEt(currentAzimuth, currentMechTilt, currentElecTilt)
  const beforeParsed = parseAzMtEt(beforeChange)
  const afterParsed = parseAzMtEt(afterChange)
  const matchesBefore = beforeParsed != null && numericMatch(current, beforeParsed)
  const matchesAfter = afterParsed != null && numericMatch(current, afterParsed)
  if (matchesBefore && matchesAfter) return { status: 'matched-both', currentText }
  if (matchesBefore) return { status: 'matched-before', currentText }
  if (matchesAfter) return { status: 'matched-after', currentText }
  return { status: 'mismatch', currentText }
}
