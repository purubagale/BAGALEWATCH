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
// columns exactly (BackupPage.tsx's "Site + KPI Data"/"Sector Data"
// downloads) — the natural round-trip is: export a template, fill in
// what's missing, re-upload it here.
//
// This module only PARSES rows client-side into plain objects; the
// actual DB decision is made server-side (core/site_import.py) against
// the real database, not against whatever's cached in the browser.
//
// 2026-08-26 — parseSiteRows/ParsedSiteRow (site identity: name/region/
// district/lat/lng) is GONE, replaced by parseKpiRows/ParsedKpiRow below.
// Site identity now comes only from the Live Site Directory sync
// (core/live_sites.py), confirmed via AskUserQuestion: "no need to add
// site now, only need to add, update sector information, kpi during
// import." parseSectorRows/ParsedSectorRow is unchanged in shape, but
// core/site_import.py no longer auto-creates a missing site from a
// sector row's lat/lng — see that module's docstring.

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

// KPI Data row (2026-08-26) — replaced ParsedSiteRow/parseSiteRows.
// Site identity (name/region/district/lat/lng/etc.) now comes only from
// the Live Site Directory sync (core/live_sites.py), never from an
// upload — this shape only carries Site ID (to match an EXISTING site)
// plus the 4G KPI columns, matching exports.py's _build_site_kpi_workbook
// "KPI Data" sheet exactly, since the natural round-trip is: export that
// template, fill in numbers, re-upload here.
export interface ParsedKpiRow {
  id: string
  rrc: number | null
  erab: number | null
  call_setup: number | null
  call_drop: number | null
  svc_drop: number | null
  intra_ho: number | null
  inter_ho: number | null
  inter_rat: number | null
  ip_thru: number | null
  ip_lat: number | null
  prb: number | null
  bearer_util: number | null
  lic_util: number | null
  cell_avail: number | null
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
  // Originally (2026-08-05) also carried through for the "site not
  // present yet" case, to auto-create a minimal site record from a
  // sector row's own coordinates — that no longer happens (2026-08-26,
  // see core/site_import.py's ImportSitesView docstring): a row naming a
  // site that doesn't exist is now skipped and reported instead. Still
  // used for the sector's OWN location override, though — see below.
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

/** Parses "KPI Data"-shaped rows (2026-08-26): Site ID plus the 4G KPI
 * columns from exports.py's _build_site_kpi_workbook "KPI Data" sheet —
 * RRC/E-RAB/Call Setup/Call Drop/Svc Drop/Intra-HO/Inter-Freq HO/
 * Inter-RAT/IP Throughput/IP Latency/PRB Utilization/Bearer Util/License
 * Util/Cell Avail. Header row (rows[0]) is required. Throws if no Site ID
 * column can be found at all — same fail-fast contract as
 * dtTemplateParser's parseTemplateRows. Rows with a blank Site ID are
 * skipped silently (blank spacer rows are common in hand-edited
 * spreadsheets), not counted as errors. A blank KPI cell parses to
 * `null`, NOT 0 — core/site_import.py's `_apply_kpi` treats null as
 * "no value on this row", never as "clear this field". */
export function parseKpiRows(rows: string[][]): ParsedKpiRow[] {
  if (!rows || rows.length < 2) return []
  const header = rows[0].map(normalize)
  const iId = findCol(header, 'siteid', 'id')
  const iRrc = findCol(header, 'rrcsetupsr', 'rrc')
  const iErab = findCol(header, 'erabsetupsr', 'erab')
  const iCallSetup = findCol(header, 'callsetupsr', 'callsetup')
  const iCallDrop = findCol(header, 'calldroprate', 'calldrop')
  const iSvcDrop = findCol(header, 'svcdroprate', 'svcdrop', 'servicedrop')
  const iIntraHo = findCol(header, 'intrahosr', 'intraho')
  const iInterHo = findCol(header, 'interfreqhosr', 'interho', 'interfreqho')
  const iInterRat = findCol(header, 'interratHosr', 'interrat', 'interrathosr')
  const iIpThru = findCol(header, 'ipthroughput', 'ipthru', 'throughput')
  const iIpLat = findCol(header, 'iplatency', 'iplat', 'latency')
  const iPrb = findCol(header, 'prbutilization', 'prb')
  const iBearerUtil = findCol(header, 'bearerutil', 'beareutilization')
  const iLicUtil = findCol(header, 'licenseutil', 'licutil', 'licenseutilization')
  const iCellAvail = findCol(header, 'cellavail', 'cellavailability')

  if (iId < 0) throw new Error('Could not find a "Site ID" column in this file.')

  const records: ParsedKpiRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue
    const id = cell(row, iId)
    if (!id) continue
    records.push({
      id,
      rrc: num(row, iRrc),
      erab: num(row, iErab),
      call_setup: num(row, iCallSetup),
      call_drop: num(row, iCallDrop),
      svc_drop: num(row, iSvcDrop),
      intra_ho: num(row, iIntraHo),
      inter_ho: num(row, iInterHo),
      inter_rat: num(row, iInterRat),
      ip_thru: num(row, iIpThru),
      ip_lat: num(row, iIpLat),
      prb: num(row, iPrb),
      bearer_util: num(row, iBearerUtil),
      lic_util: num(row, iLicUtil),
      cell_avail: num(row, iCellAvail),
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
  // 'localcell' added (2026-09-23) — a real 4G source file uses "Local
  // Cell" with no "ID"/"Cell ID" suffix at all, which neither existing
  // alias's substring check matches ("localcell" doesn't contain
  // "localcellid" or "cellid" as a substring — the "id" that "cellid"
  // needs never appears). Lowest priority of the three so a file with a
  // more specific column name still prefers it.
  const iLocalCellId = findCol(header, 'localcellid', 'cellid', 'localcell')
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

// Engineering-parameter row (2026-09-27) — the vendor's own nationwide
// "Cell_Wise(Final)" master list (LTE_Engineering_Parameter_*.xlsx) and
// the per-lot WSD RNO report's "Detail" sheet share this same column
// family (confirmed by opening both real files directly with openpyxl):
// Cell Name, BAND, Assigned Carrier, PCI, Antenna Height from ground
// (AGL), Azimuth, Mech./Elec. Downtilt (these six feed the matched
// Sector, keyed by Cell Name alone — core/site_import.py's
// `_apply_engineering_params`), plus existing Tower type, Tower height
// (m), Building height, existing tower height from TSSR, Antenna
// device, Tower remark (these six feed that sector's own Site).
// Property ID/Zone/Palika are deliberately NOT parsed here — the user's
// own words: "property id is site id so no need and exclude zone and
// palika".
//
// Column-alias note: several of the vendor's own headers collide on a
// naive substring match ("Tower height (m)" and "existing tower height
// from TSSR" both contain "height"; "Mech. Downtilt"/"Elec. Downtilt"
// don't match this file's existing mech_tilt/elec_tilt aliases in
// ParsedSectorRow at all, which were written against a different real
// 2G/3G file's own header spelling) — every alias below was chosen
// against the two real files' own exact header text, not guessed.
export interface ParsedEngineeringParamRow {
  cell_name: string
  pci: number | null
  height: number | null
  azimuth: number | null
  mech_tilt: number | null
  elec_tilt: number | null
  // Antenna wedge visualization (2026-09-27) — ONLY the vendor's KML
  // engineering-parameter export (parseKmlEngineeringParams below)
  // carries these; both xlsx sources have no Beamwidth/Radius column at
  // all, so parseEngineeringParamRows always sets them null (same "blank
  // means leave alone" contract as every other field here).
  beamwidth: number | null
  radius: number | null
  carrier: string
  site_band: string
  tower_type: string
  tower_height_m: string
  building_height: string
  tower_height_tssr: string
  antenna_device: string
  tower_remark: string
}

/** Parses the engineering-parameter master-list/WSD "Detail" sheet shape
 * described above. Requires a Cell Name column — matching happens
 * server-side by cell_name alone (`_apply_engineering_params` looks up
 * the Sector directly, no Site ID needed, since these source files carry
 * no separate Site ID column of their own). A row with a blank Cell Name
 * is skipped silently, same as a blank-spacer row anywhere else in this
 * module. */
export function parseEngineeringParamRows(rows: string[][]): ParsedEngineeringParamRow[] {
  if (!rows || rows.length < 2) return []
  const header = rows[0].map(normalize)
  const iCellName = findCol(header, 'cellname')
  const iPci = findCol(header, 'pci')
  const iHeight = findCol(header, 'antennaheight')
  const iAzimuth = findCol(header, 'azimuth')
  const iMt = findCol(header, 'mechdowntilt')
  const iEt = findCol(header, 'elecdowntilt')
  const iCarrier = findCol(header, 'assignedcarrier', 'carrier')
  const iSiteBand = findCol(header, 'band')
  const iTowerType = findCol(header, 'towertype')
  const iTowerHeightM = findCol(header, 'towerheightm')
  const iBuildingHeight = findCol(header, 'buildingheight')
  const iTowerHeightTssr = findCol(header, 'tssr')
  const iAntennaDevice = findCol(header, 'antennadevice')
  const iTowerRemark = findCol(header, 'towerremark')

  if (iCellName < 0) throw new Error('Could not find a "Cell Name" column in this file.')

  const records: ParsedEngineeringParamRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue
    const cellName = cell(row, iCellName)
    if (!cellName || cellName === '—') continue
    records.push({
      cell_name: cellName,
      pci: int(row, iPci),
      height: num(row, iHeight),
      azimuth: num(row, iAzimuth),
      mech_tilt: num(row, iMt),
      elec_tilt: num(row, iEt),
      beamwidth: null,
      radius: null,
      carrier: cell(row, iCarrier),
      site_band: cell(row, iSiteBand),
      tower_type: cell(row, iTowerType),
      tower_height_m: cell(row, iTowerHeightM),
      building_height: cell(row, iBuildingHeight),
      tower_height_tssr: cell(row, iTowerHeightTssr),
      antenna_device: cell(row, iAntennaDevice),
      tower_remark: cell(row, iTowerRemark),
    })
  }
  return records
}

// KML engineering-parameter export (2026-09-27, "i placed a file named
// Nepal NTC_LTE engineering_parameter_14_June_26.kml... how can we use
// its data to show antenna orientation, azimuth, beam power in graphical
// representation"). Opened the real 41MB file directly before writing
// this — its `Sector` folder has one <Placemark> per sector, each with a
// <description> of "Key = Value" lines (confirmed real keys: "Cell
// Name", "PCI", "Radius", "Beamwidth", "Azimuth", "Mechanical Downtilt",
// "Electrical Downtilt", "Antenn Ht" — note the real vendor typo, missing
// an 'a' — "Assigned Carrier", plus the same tower/antenna fields the
// xlsx sources carry). The `Site` folder's own Placemarks have NO
// <description> at all (plain point markers), so skipping any block
// without one is how Sector placemarks get isolated without needing to
// track which <Folder> a Placemark is nested inside. There is NO
// transmit-power/dBm field anywhere in this file — "beam power" is
// rendered as a theoretical coverage wedge from azimuth/beamwidth/radius
// (see sectorWedge.ts), never a fabricated power number.
//
// Unlike parseEngineeringParamRows above (column-POSITION matching for a
// tabular header), this is a per-placemark KEY lookup — every Placemark
// carries a full key/value dict, so each key is matched by an EXACT
// normalized name, not a substring guess.
const _kmlEntityRe = /&(#x0A|amp|lt|gt|quot|apos);/g
function _kmlUnescape(s: string): string {
  return s.replace(_kmlEntityRe, (_m, ent: string) => {
    if (ent === '#x0A') return '\n'
    if (ent === 'amp') return '&'
    if (ent === 'lt') return '<'
    if (ent === 'gt') return '>'
    if (ent === 'quot') return '"'
    return "'" // apos
  })
}

function _kmlDescriptionFields(description: string): Record<string, string> {
  const text = _kmlUnescape(description)
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = normalize(line.slice(0, eq))
    const value = line.slice(eq + 1).trim()
    if (key) fields[key] = value
  }
  return fields
}

function _kmlNum(fields: Record<string, string>, key: string): number | null {
  const v = fields[key]
  if (v === undefined || v === '') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Parses the KML shape described above into the SAME `ParsedEngineeringParamRow`
 * shape `parseEngineeringParamRows` produces, so both sources feed the
 * identical `kind='engineering_params'` backend endpoint. A Placemark with
 * no <description> (the Site folder's own point markers) or a blank Cell
 * Name is skipped silently, same convention as every other parser in this
 * module. `site_band`/`tower_height_tssr` are always '' from this source
 * — not present in the KML's own key list — which the backend already
 * treats as "no value on this row", never "clear this field". */
export function parseKmlEngineeringParams(text: string): ParsedEngineeringParamRow[] {
  const records: ParsedEngineeringParamRow[] = []
  const placemarkRe = /<Placemark>([\s\S]*?)<\/Placemark>/g
  let m: RegExpExecArray | null
  while ((m = placemarkRe.exec(text))) {
    const block = m[1]
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/)
    if (!descMatch) continue // Site folder's plain point markers — no description at all
    const fields = _kmlDescriptionFields(descMatch[1])
    const cellName = (fields.cellname ?? '').trim()
    if (!cellName || cellName === '—') continue
    const pciVal = _kmlNum(fields, 'pci')
    records.push({
      cell_name: cellName,
      pci: pciVal != null ? Math.trunc(pciVal) : null,
      height: _kmlNum(fields, 'antennht'),
      azimuth: _kmlNum(fields, 'azimuth'),
      mech_tilt: _kmlNum(fields, 'mechanicaldowntilt'),
      elec_tilt: _kmlNum(fields, 'electricaldowntilt'),
      beamwidth: _kmlNum(fields, 'beamwidth'),
      radius: _kmlNum(fields, 'radius'),
      carrier: fields.assignedcarrier ?? '',
      site_band: '',
      tower_type: fields.existingtowertype ?? '',
      tower_height_m: fields.towerheightm ?? '',
      building_height: fields.buildingheight ?? '',
      tower_height_tssr: '',
      antenna_device: fields.antennadevice ?? '',
      tower_remark: fields.towerremark ?? '',
    })
  }
  return records
}
