// Site/Sector import from an uploaded Excel/CSV file (2026-08-05), per
// explicit user request: "since i have not uploaded complete site,
// coordinate, sector details so i need feature to upload excel file
// such that, it checks the uploaded file and compare with the database
// data of site, if exist already then do nothing, if not exist then add
// data like in V1."
//
// Column matching is flexible (same normalized-substring approach as
// dtTemplateParser.ts's findCol — lowercased, punctuation/spaces
// stripped, so "Site ID", "SiteID", "Site-ID" all match), and the
// expected headers deliberately match this app's own Excel EXPORT
// columns exactly (BackupPage.tsx's "Site Details"/"Sector Data"
// downloads) — the natural round-trip is: export a template, fill in
// what's missing, re-upload it here.
//
// This module only PARSES rows client-side into plain objects; the
// actual "does this ID already exist, skip if so" decision is made
// server-side (core/site_import.py) against the real database, not
// against whatever site list happens to be cached in the browser.

const normalize = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function findCol(header: string[], ...keys: string[]): number {
  for (const k of keys) {
    const idx = header.indexOf(normalize(k))
    if (idx >= 0) return idx
  }
  for (const k of keys) {
    const nk = normalize(k)
    const idx = header.findIndex((h) => h.includes(nk))
    if (idx >= 0) return idx
  }
  return -1
}

function cell(row: string[], i: number): string {
  return i >= 0 && row[i] != null ? String(row[i]).trim() : ''
}

function num(row: string[], i: number): number | null {
  if (i < 0) return null
  const v = parseFloat(cell(row, i))
  return Number.isFinite(v) ? v : null
}

function int(row: string[], i: number): number | null {
  if (i < 0) return null
  const v = parseInt(cell(row, i), 10)
  return Number.isFinite(v) ? v : null
}

export interface ParsedSiteRow {
  id: string
  name: string
  region: string
  district: string
  city: string
  lat: number | null
  lng: number | null
}

export interface ParsedSectorRow {
  site_id: string
  cell_name: string
  sector: string
  // 2026-08-09 follow-up ("yes for 2g and 3g also need sector import") —
  // the Sector Data template never carried a Tech column at all, so
  // every sector added/updated through this import stayed at its blank
  // default Tech forever (see core/site_import.py's SECTOR_FIELDS
  // comment). Blank/unrecognized here just means "leave whatever the
  // sector already has alone" on an update, or "" on a brand-new sector
  // — same "don't fabricate/guess" rule as every other column.
  //
  // Same-day follow-up ("allow seperate upload of sector data for 4g,
  // 3g and 2g rather than using tech type column in single sheet"): this
  // parsed value is now mostly a fallback. BackupPage.tsx's
  // SectorImportSlot sends its OWN `tech` on the request body (one per
  // upload slot), which core/site_import.py applies to every row and
  // overrides whatever this column says — this field only still matters
  // for a raw API caller that posts rows with no top-level `tech`.
  tech: string
  local_cell_id: number | null
  height: number | null
  azimuth: number | null
  mech_tilt: number | null
  elec_tilt: number | null
  pci: number | null
  // Carried through 2026-08-05 for the "site not present yet" case — a
  // re-uploaded sector row has everything needed to auto-create a
  // minimal site record (id + coordinates) if that site doesn't exist in
  // the system yet. See core/site_import.py's ImportSitesView.
  //
  // 2026-08-09 follow-up ("when i upload the sector data, also import
  // each sector lat long also and store"): this is no longer necessarily
  // just the site's own coordinate repeated on every row — Sector now
  // has its own optional GPS override (see Sector.lat/lng's docstring in
  // models.py), and core/exports.py's _build_sector_data_workbook emits
  // a sector's OWN lat/lng here when it has one, falling back to the
  // site's only when it doesn't. The backend (`_sector_location_override()`
  // in site_import.py) is what actually decides whether a given row's
  // value is a genuine per-sector override or just the site's location —
  // this parser's job is only to carry whatever the file says through
  // unchanged, same as every other column here.
  lat: number | null
  lng: number | null
  // 2026-08-09 follow-up ("need to store all those data also") — real
  // columns from the user's own 3G/2G source files with nowhere to go
  // before now. Plain text, carried through unchanged like every other
  // column here — see Sector.carrier/site_band/cell_active_status/
  // site_existence's docstring in models.py for why these aren't
  // interpreted into a boolean/enum.
  carrier: string
  site_band: string
  cell_active_status: string
  site_existence: string
}

/** Parses "Site Details"-shaped rows: Site ID, Site Name, Region, City,
 * Province / District, Latitude, Longitude[, Sector Count (ignored —
 * derived, not stored)]. Header row (rows[0]) is required. Throws if no
 * Site ID column can be found at all — same fail-fast contract as
 * dtTemplateParser's parseTemplateRows (no silent partial parse of a
 * file that clearly isn't the expected shape). Rows with a blank Site ID
 * are skipped silently (blank spacer rows are common in hand-edited
 * spreadsheets), not counted as errors. */
export function parseSiteRows(rows: string[][]): ParsedSiteRow[] {
  if (!rows || rows.length < 2) return []
  const header = rows[0].map(normalize)
  const iId = findCol(header, 'siteid', 'id')
  const iName = findCol(header, 'sitename', 'name')
  const iRegion = findCol(header, 'region')
  const iDistrict = findCol(header, 'provincedistrict', 'district', 'province')
  const iCity = findCol(header, 'city')
  const iLat = findCol(header, 'latitude', 'lat')
  const iLng = findCol(header, 'longitude', 'long', 'lng', 'lon')

  if (iId < 0) throw new Error('Could not find a "Site ID" column in this file.')

  const records: ParsedSiteRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue
    const id = cell(row, iId)
    if (!id) continue
    records.push({
      id,
      name: cell(row, iName),
      region: cell(row, iRegion),
      district: cell(row, iDistrict),
      city: cell(row, iCity),
      lat: num(row, iLat),
      lng: num(row, iLng),
    })
  }
  return records
}

/** Parses "Sector Data"-shaped rows: Site ID, Cell Name, Sector, Tech
 * (2026-08-09 follow-up — see ParsedSectorRow's `tech` doc), Local Cell
 * ID, Lat, Long (kept — see ParsedSectorRow's `lat`/`lng` doc), Height,
 * Azimuth, MT, ET, PCI, and Carrier/Site Band/Cell Active Status/Site
 * Existence (same-day follow-up — see ParsedSectorRow's doc for those).
 * Requires both a Site ID and a Cell Name column — a sector row with
 * neither identifies anything meaningful to add. */
export function parseSectorRows(rows: string[][]): ParsedSectorRow[] {
  if (!rows || rows.length < 2) return []
  const header = rows[0].map(normalize)
  const iSiteId = findCol(header, 'siteid', 'id')
  const iCellName = findCol(header, 'cellname')
  const iSector = findCol(header, 'sector')
  // 'tech' is still parsed for backward compatibility with an
  // already-exported combined sheet, but the primary way a row's tech
  // gets set now is the upload SLOT itself (2026-08-09, "allow seperate
  // upload of sector data for 4g, 3g and 2g rather than using tech type
  // column in single sheet") — see BackupPage.tsx's SectorImportSlot,
  // which sends its own `tech` on the request body and overrides
  // whatever (if anything) this column parses.
  const iTech = findCol(header, 'tech', 'technology')
  // 'cellid' added (2026-08-09) — the user's real 3G source file uses a
  // bare "Cell ID" header instead of "Local Cell ID"; kept as a lower-
  // priority alias after 'localcellid' so an unambiguous file with BOTH
  // columns still prefers the more specific one.
  const iLocalCellId = findCol(header, 'localcellid', 'cellid')
  const iLat = findCol(header, 'latitude', 'lat')
  const iLng = findCol(header, 'longitude', 'long', 'lng', 'lon')
  const iHeight = findCol(header, 'height')
  const iAzimuth = findCol(header, 'azimuth')
  // 'mechanicaltilt'/'mechnicaltilt' (sic — matches a real typo seen in
  // the user's 2G source file, "Mechnical Tilt") and 'electricaltilt'
  // added 2026-08-09 for the same reason as 'cellid' above: the real 2G/
  // 3G source spreadsheets spell these out differently than this app's
  // own "MT (deg)"/"ET (deg)" export template does.
  const iMt = findCol(header, 'mt', 'mechtilt', 'mechanicaltilt', 'mechnicaltilt')
  const iEt = findCol(header, 'et', 'electilt', 'electricaltilt')
  const iPci = findCol(header, 'pci')
  // 2026-08-09 follow-up ("need to store all those data also") — Carrier,
  // Site Band, Cell Active Status, and a per-tech "Site Existence" flag,
  // matched against the exact real headers the user showed ("Carrier",
  // "Site Band", "Cell Active Status"/"CELL ACT STATUS", "3G Site
  // Existence"/"Physical Site Existance 2G" — note both the correct
  // "Existence" spelling and the real file's "Existance" typo). The
  // upload SLOT (4G/3G/2G) already says which tech this file is, so the
  // existence-flag alias deliberately doesn't try to match the "2G"/"3G"
  // part of that header text, just "existence"/"existance" anywhere in it.
  const iCarrier = findCol(header, 'carrier')
  const iSiteBand = findCol(header, 'siteband', 'band')
  const iCellActiveStatus = findCol(header, 'cellactivestatus', 'cellactstatus')
  const iSiteExistence = findCol(header, 'existence', 'existance')

  if (iSiteId < 0) throw new Error('Could not find a "Site ID" column in this file.')
  if (iCellName < 0) throw new Error('Could not find a "Cell Name" column in this file.')

  const records: ParsedSectorRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue
    const siteId = cell(row, iSiteId)
    const cellName = cell(row, iCellName)
    if (!siteId || !cellName || cellName === '—') continue
    records.push({
      site_id: siteId,
      cell_name: cellName,
      sector: cell(row, iSector),
      tech: cell(row, iTech),
      local_cell_id: int(row, iLocalCellId),
      lat: num(row, iLat),
      lng: num(row, iLng),
      height: num(row, iHeight),
      azimuth: num(row, iAzimuth),
      mech_tilt: num(row, iMt),
      elec_tilt: num(row, iEt),
      pci: int(row, iPci),
      carrier: cell(row, iCarrier),
      site_band: cell(row, iSiteBand),
      cell_active_status: cell(row, iCellActiveStatus),
      site_existence: cell(row, iSiteExistence),
    })
  }
  return records
}
