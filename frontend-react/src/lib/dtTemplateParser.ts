// CSV template upload parser for the Drive-Test Data Manager — ported
// line-for-line from bts_monitor.html's `_rsrpCsvTextToRows` (~7759) and
// `_rsrpParseTemplateRows` (~7674). Scope note (per the Phase 4
// AskUserQuestion decision, see project memory
// project_v2_migration_phase4_2026_07_28): this phase covers the CSV
// template path only. The .trp/.nmf binary decoder is a separate,
// dedicated follow-up — it is the single highest-risk item in the whole
// v2 migration per that same memory and is deliberately not rushed in
// here.
import type { DtSample, DtTech } from '../api/types'

/** Minimal RFC4180-ish CSV line splitter — handles quoted fields containing
 * commas, matches v1's own simple state machine exactly (no CRLF-inside-quote
 * support, same limitation v1 has). */
export function csvTextToRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length)
    .map((line) => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '"') {
          inQ = !inQ
          continue
        }
        if (c === ',' && !inQ) {
          out.push(cur)
          cur = ''
          continue
        }
        cur += c
      }
      out.push(cur)
      return out
    })
}

const normalize = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Strips a leading apostrophe — the downloadable template
// (DtDataManagerPage.tsx's downloadTemplate()) prefixes Time/Date cells
// with `'` so Excel treats them as literal text instead of
// auto-converting/truncating them as a time value on open. If the
// template is re-uploaded as-is (not re-saved through Excel first, which
// would drop the apostrophe on its own), the raw CSV text still has it.
const stripLeadingQuote = (s: string) => (s.startsWith("'") ? s.slice(1) : s)

function findCol(header: string[], ...keys: string[]): number {
  for (const k of keys) {
    const nk = normalize(k)
    const idx = header.findIndex((h) => h.includes(nk))
    if (idx >= 0) return idx
  }
  return -1
}

/** Parses raw CSV rows (header row + data rows) into DtSample[] for a given
 * tech, matching v1's flexible header-matching template exactly: header
 * cells are normalized (lowercased, punctuation/space stripped) so "Rx
 * Level (dBm)", "RxLevel", "Rx-Level" all match the same lookup key.
 * Throws if Lat/Long/<primary signal> columns can't be found — same
 * fail-fast contract as v1 (no partial/silent parse). */
export function parseTemplateRows(rows: string[][], tech: DtTech): DtSample[] {
  if (!rows || rows.length < 2) return []
  const header = rows[0].map(normalize)

  // A single combined "DateTime" column (e.g. "2026-07-12 15:33:23.500",
  // seen in the user's real vendor export template, 2026-07-28) takes
  // priority over separate Time/Date columns — checked first because
  // "datetime" contains both "time" and "date" as substrings, so the
  // separate-column search below would otherwise match the SAME column
  // twice and get fed a duplicated "2026-07-12 15:33:23.500 2026-07-12
  // 15:33:23.500" string.
  const iDateTime = findCol(header, 'datetime')
  const iTime = iDateTime < 0 ? findCol(header, 'time') : -1
  const iDate = iDateTime < 0 ? findCol(header, 'date') : -1
  const iLat = findCol(header, 'lat')
  const iLng = findCol(header, 'long', 'lng', 'lon')

  let iPrimary = -1
  let primaryLabel = ''
  let iRsrq = -1,
    iSinr = -1,
    iPci = -1,
    iRxQual = -1,
    iBcch = -1,
    iBsic = -1,
    iEcno = -1,
    iScr = -1

  if (tech === '2G') {
    iPrimary = findCol(header, 'rxlevel', 'rxlev')
    primaryLabel = 'RxLevel'
    iRxQual = findCol(header, 'rxqual')
    iBcch = findCol(header, 'bcch')
    iBsic = findCol(header, 'bsic')
  } else if (tech === '3G') {
    iPrimary = findCol(header, 'rscp')
    primaryLabel = 'RSCP'
    iEcno = findCol(header, 'ecno', 'ec/no', 'ecio', 'ec/io')
    iScr = findCol(header, 'scramblingcode', 'scrcode', 'scrambling')
  } else {
    iPrimary = findCol(header, 'rsrp')
    primaryLabel = 'RSRP'
    iRsrq = findCol(header, 'rsrq')
    iSinr = findCol(header, 'sinr')
    iPci = findCol(header, 'pci')
  }

  if (iLat < 0 || iLng < 0 || iPrimary < 0) {
    throw new Error(`Could not find Lat/Long/${primaryLabel} columns — check the header row matches the ${tech} template`)
  }

  const records: DtSample[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !row.length) continue
    const lat = parseFloat(row[iLat])
    const lng = parseFloat(row[iLng])
    const primary = parseFloat(row[iPrimary])
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(primary)) continue

    let ts = ''
    let dateVal = ''
    if (iDateTime >= 0) {
      let dtVal = stripLeadingQuote(String(row[iDateTime] ?? '').trim())
      // XLSX-only case: a genuine Excel date/time cell comes back as a
      // bare numeric day-count serial (e.g. "46215.6484...") rather than
      // literal text, if the source workbook stored it as a real date
      // cell with a display format instead of a text string — the sheet
      // reader (xlsxReader.ts) doesn't apply number formats, it just
      // returns the underlying value. Detected here by "purely numeric"
      // (a real ISO-ish string always has a "-" or ":" in it) and
      // converted via the standard 1900-date-system epoch offset (25569
      // days between the epoch Excel actually uses, 1899-12-30, and the
      // Unix epoch, 1970-01-01 — including Excel's intentional Feb-29-1900
      // bug, which is baked into that same offset).
      if (dtVal && /^\d+(\.\d+)?$/.test(dtVal)) {
        const serial = parseFloat(dtVal)
        if (serial > 1) dtVal = new Date(Math.round((serial - 25569) * 86400 * 1000)).toISOString()
      }
      if (dtVal) {
        const d = new Date(dtVal)
        ts = isNaN(d.getTime()) ? dtVal : d.toISOString()
        dateVal = dtVal.slice(0, 10)
      }
    } else {
      const timeVal = iTime >= 0 ? stripLeadingQuote(String(row[iTime] ?? '').trim()) : ''
      dateVal = iDate >= 0 ? stripLeadingQuote(String(row[iDate] ?? '').trim()) : ''
      if (dateVal && timeVal) {
        const d = new Date(`${dateVal} ${timeVal}`)
        ts = isNaN(d.getTime()) ? `${dateVal} ${timeVal}` : d.toISOString()
      } else if (dateVal) {
        const d = new Date(dateVal)
        ts = isNaN(d.getTime()) ? dateVal : d.toISOString()
      } else if (timeVal) {
        ts = timeVal
      }
    }

    // `rsrp` always carries the primary dBm-scale signal reading regardless
    // of tech (RxLevel/RSCP/RSRP) — see dtBands.ts's metricsForTech(), same
    // convention on both the parser and the map/legend side.
    const rec: DtSample = {
      ts,
      date: dateVal,
      lat,
      lng,
      rsrp: primary,
      rsrq: null,
      sinr: null,
      dl: null,
      pci: null,
      serving_site_id: null,
      serving_site_name: null,
      serving_sector: null,
      serving_cell_name: null,
      serving_local_cell_id: null,
      serving_dist_km: null,
      cell_role: 'serving',
      rx_qual: null,
      bcch: null,
      bsic: null,
      rscp: null,
      ecno: null,
      scrambling_code: null,
    }

    if (tech === '4G') {
      if (iRsrq >= 0) {
        const v = parseFloat(row[iRsrq])
        if (Number.isFinite(v)) rec.rsrq = v
      }
      if (iSinr >= 0) {
        const v = parseFloat(row[iSinr])
        if (Number.isFinite(v)) rec.sinr = v
      }
      if (iPci >= 0) {
        const v = parseInt(row[iPci], 10)
        if (Number.isFinite(v)) rec.pci = v
      }
    } else if (tech === '3G') {
      rec.rscp = primary
      if (iEcno >= 0) {
        const v = parseFloat(row[iEcno])
        if (Number.isFinite(v)) rec.ecno = v
      }
      if (iScr >= 0) {
        const v = row[iScr]
        rec.scrambling_code = v != null && String(v).trim() !== '' ? parseInt(String(v).trim(), 10) || null : null
      }
    } else if (tech === '2G') {
      if (iRxQual >= 0) {
        const v = parseFloat(row[iRxQual])
        if (Number.isFinite(v)) rec.rx_qual = v
      }
      if (iBcch >= 0) {
        const v = row[iBcch]
        rec.bcch = v != null && String(v).trim() !== '' ? parseInt(String(v).trim(), 10) || null : null
      }
      if (iBsic >= 0) {
        const v = row[iBsic]
        rec.bsic = v != null && String(v).trim() !== '' ? parseInt(String(v).trim(), 10) || null : null
      }
    }

    records.push(rec)
  }
  return records
}

/** Flat haversine distance in km — same formula v1 uses for GPS track
 * length (`_rsrpHaversineKm`) and nearest-site lookups. Shared here so
 * `computeSessionMeta`'s route-distance calc and the auto-naming
 * district resolver (DtDataManagerPage.tsx's `resolveDistrict`) don't
 * each carry their own copy. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const la1 = toRad(lat1)
  const la2 = toRad(lat2)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** Derives the session-level meta blob (gpsCount/routeKm/duration/avgRsrp
 * etc.) from a parsed sample array — mirrors what v1's saveDtSession()
 * computes at save time so the History tab's summary cards match. */
export function computeSessionMeta(samples: DtSample[], fileNames: string[]) {
  const withGps = samples.filter((s) => s.lat != null && s.lng != null)
  const withRsrp = samples.filter((s) => s.rsrp != null)
  const avgRsrp = withRsrp.length
    ? withRsrp.reduce((sum, s) => sum + (s.rsrp as number), 0) / withRsrp.length
    : null

  let routeKm = 0
  for (let i = 1; i < withGps.length; i++) {
    const a = withGps[i - 1]
    const b = withGps[i]
    routeKm += haversineKm(a.lat as number, a.lng as number, b.lat as number, b.lng as number)
  }

  const times = samples.map((s) => s.ts).filter((t): t is string => !!t).sort()
  const startTime = times[0] ?? ''
  const endTime = times[times.length - 1] ?? ''

  return {
    gpsCount: withGps.length,
    fileNames,
    routeKm: routeKm.toFixed(2),
    startTime,
    endTime,
    avgRsrp: avgRsrp !== null ? Math.round(avgRsrp * 10) / 10 : null,
  }
}
