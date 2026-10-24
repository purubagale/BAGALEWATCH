// A position typed or pasted in any common format (2026-10-19), for the
// Site Topology search box. Accepted, among others:
//   27.7172, 85.3240          27.7172 85.3240          27.7172;85.3240
//   27.7172 N, 85.3240 E      N27.7172 E85.3240        27.7172°N 85.3240°E
//   27°43'01.9"N 85°19'26.4"E                          27 43 1.9 N 85 19 26.4 E
//   27°43.032'N 85°19.440'E (degrees and decimal minutes)
//   lat: 27.7172, lng: 85.324                          geo:27.7172,85.324
//   a Google Maps link with @27.7172,85.324,15z or ?q=27.7172,85.324
// A pair given longitude first (85.3, 27.7) is swapped when that is the only
// reading that falls in Nepal. Returns null when the text is not a position.

export interface LatLng { lat: number; lng: number }

const NEPAL = { lat: [26.2, 30.6], lng: [80, 88.3] }
const inNepal = (p: LatLng) => p.lat >= NEPAL.lat[0] && p.lat <= NEPAL.lat[1] && p.lng >= NEPAL.lng[0] && p.lng <= NEPAL.lng[1]
const valid = (p: LatLng) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180

// One coordinate: degrees, optional minutes and seconds, optional hemisphere.
const PART = String.raw`([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*(?:°|º|deg|d|\s)?\s*(?:(\d+(?:\.\d+)?)\s*(?:'|′|’|min|m|\s)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|”|''|sec|s)?)?)?\s*([NSEW])?`

function toDecimal(m: RegExpMatchArray, offset: number): { value: number; hemi: string | null } | null {
  const pre = m[offset], deg = m[offset + 1], min = m[offset + 2], sec = m[offset + 3], post = m[offset + 4]
  if (deg == null) return null
  const d = Number(deg)
  const minutes = min != null ? Number(min) : 0
  const seconds = sec != null ? Number(sec) : 0
  if (minutes >= 60 || seconds >= 60) return null
  let value = Math.abs(d) + minutes / 60 + seconds / 3600
  const hemi = (pre || post || '').toUpperCase() || null
  if (d < 0 || hemi === 'S' || hemi === 'W') value = -value
  return { value, hemi }
}

export function parseLatLng(text: string): LatLng | null {
  let t = text.trim()
  if (!t) return null
  // Links and labelled forms first.
  const at = t.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) ?? t.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
    ?? t.match(/^geo:(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i)
  if (at) return pick({ lat: Number(at[1]), lng: Number(at[2]) })
  t = t.replace(/\b(?:lat(?:itude)?|lon(?:g(?:itude)?)?|lng)\s*[:=]?\s*/gi, ' ').replace(/[()[\]]/g, ' ').trim()
  // Text with letters other than hemispheres and units is a site name, not a position.
  if (/[A-DF-MO-RT-VX-Z]/i.test(t.replace(/\b(?:deg|min|sec)\b/gi, '').replace(/[NSEW]/g, ''))) return null

  const re = new RegExp(String.raw`^\s*${PART}\s*[,;/\s]\s*${PART}\s*$`, 'i')
  const m = t.match(re)
  if (m) {
    const a = toDecimal(m, 1)
    const b = toDecimal(m, 6)
    if (a && b) {
      // Hemisphere letters say which is which.
      if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S') return pick({ lat: b.value, lng: a.value }, false)
      if (a.hemi || b.hemi) return pick({ lat: a.value, lng: b.value }, false)
      return pick({ lat: a.value, lng: b.value })
    }
  }
  return null
}

function pick(p: LatLng, maySwap = true): LatLng | null {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null
  const swapped = { lat: p.lng, lng: p.lat }
  if (maySwap && !inNepal(p) && inNepal(swapped)) return swapped
  if (valid(p)) return p
  if (maySwap && valid(swapped)) return swapped
  return null
}
