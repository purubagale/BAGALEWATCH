// Minimal in-browser .xlsx reader — ported from bts_monitor.html's
// _xlsxSheetToRows/_trpZipListEntries/_trpZipReadEntry (~9161-9293).
// Deliberately NOT the SheetJS library: v1 already solved "read one flat
// worksheet out of an .xlsx" with a small hand-rolled ZIP + XML reader
// (an .xlsx file IS a ZIP archive of XML parts, and v1's TRP parser
// already had a ZIP entry scanner + raw-deflate inflate for the exact
// same reason .trp files are ZIPs) — reusing that approach avoids a new
// ~1MB npm dependency for what is, on purpose, not a full spreadsheet
// parser (no formulas, no merged cells, no styles — just cell values).
//
// v1's own reader always takes the FIRST worksheet in the file, since its
// own template upload is always single-sheet. This port adds one real
// extension beyond v1 (confirmed necessary 2026-07-28: the user's actual
// reference template bundles 4G/3G/2G example columns into three
// different sheets of one workbook): `readWorkbookSheetForTech()` reads
// `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` to resolve sheet
// names in document order, picks the sheet whose name matches the
// selected tech (normalized, e.g. "4G LTE" matches tech '4G'), and falls
// back to the first sheet if no tech-named sheet is found — so a
// single-sheet template (whatever it's named) still works exactly like
// v1's behavior did.

interface ZipEntry {
  comp: number
  dataStart: number
  compSize: number
}

function zipListEntries(bytes: Uint8Array): Record<string, ZipEntry> {
  const entries: Record<string, ZipEntry> = {}
  let pos = 0
  const n = bytes.length
  while (pos < n - 4) {
    if (bytes[pos] === 0x50 && bytes[pos + 1] === 0x4b && bytes[pos + 2] === 0x03 && bytes[pos + 3] === 0x04) {
      const comp = bytes[pos + 8] | (bytes[pos + 9] << 8)
      const compSize = (bytes[pos + 18] | (bytes[pos + 19] << 8) | (bytes[pos + 20] << 16) | (bytes[pos + 21] << 24)) >>> 0
      const nameLen = bytes[pos + 26] | (bytes[pos + 27] << 8)
      const extraLen = bytes[pos + 28] | (bytes[pos + 29] << 8)
      const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 30, pos + 30 + nameLen))
      const dataStart = pos + 30 + nameLen + extraLen
      entries[name] = { comp, dataStart, compSize }
      pos = dataStart + compSize
    } else {
      pos++
    }
  }
  return entries
}

async function inflateRawRange(bytes: Uint8Array, start: number, len: number): Promise<Uint8Array> {
  const chunk = bytes.subarray(start, start + len)
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([chunk as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

async function zipReadEntry(bytes: Uint8Array, entries: Record<string, ZipEntry>, name: string): Promise<Uint8Array | null> {
  const e = entries[name]
  if (!e) return null
  if (e.comp === 0) return bytes.subarray(e.dataStart, e.dataStart + e.compSize)
  if (e.comp === 8) return await inflateRawRange(bytes, e.dataStart, e.compSize)
  return null
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function colToIdx(letters: string): number {
  let idx = 0
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64)
  return idx - 1
}

/** Turns one worksheet's raw XML (plus the workbook's shared-strings
 * table) into a plain string[][], same cell/row regex approach as v1's
 * `_xlsxSheetToRows` — handles shared-string cells, inline strings,
 * numeric cells, and sparse cell refs (a row doesn't have to list every
 * column; missing cells stay `undefined`, matching a CSV row that's
 * shorter than the header). */
function sheetXmlToRows(sheetXml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(sheetXml))) {
    const rowContent = rm[1]
    const cells: string[] = []
    const cRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g
    let cm: RegExpExecArray | null
    let autoIdx = 0
    while ((cm = cRe.exec(rowContent))) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[2]
      const inner = cm[3] || ''
      const rMatch = attrs.match(/r="([A-Z]+)\d+"/)
      const tMatch = attrs.match(/t="([^"]+)"/)
      const vMatch = inner.match(/<v>([^<]*)<\/v>/)
      let val = vMatch ? vMatch[1] : ''
      if (tMatch && tMatch[1] === 's' && val !== '') {
        const idx = parseInt(val, 10)
        val = shared[idx] !== undefined ? shared[idx] : ''
      } else if (tMatch && tMatch[1] === 'inlineStr') {
        const isMatch = inner.match(/<t[^>]*>([^<]*)<\/t>/)
        val = isMatch ? isMatch[1] : ''
      }
      val = xmlUnescape(val)
      const colIdx = rMatch ? colToIdx(rMatch[1]) : autoIdx
      cells[colIdx] = val
      autoIdx = colIdx + 1
    }
    rows.push(cells)
  }
  return rows
}

async function readSharedStrings(bytes: Uint8Array, entries: Record<string, ZipEntry>): Promise<string[]> {
  const raw = await zipReadEntry(bytes, entries, 'xl/sharedStrings.xml').catch(() => null)
  if (!raw) return []
  const xml = new TextDecoder('utf-8').decode(raw)
  const shared: string[] = []
  const siRe = /<si>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(xml))) {
    const texts = [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1])
    shared.push(xmlUnescape(texts.join('')))
  }
  return shared
}

interface WorkbookSheet {
  name: string
  path: string
}

/** Resolves the ordered list of {name, path} for every worksheet in the
 * workbook by reading `xl/workbook.xml` (sheet name + r:id, in document
 * order) and `xl/_rels/workbook.xml.rels` (r:id -> target file). Falls
 * back to a single `xl/worksheets/sheet1.xml` entry if either part is
 * missing/malformed (matches v1's own "sheet1.xml, or first worksheet
 * found" fallback for a workbook that doesn't expose usable rels). */
async function listWorkbookSheets(bytes: Uint8Array, entries: Record<string, ZipEntry>): Promise<WorkbookSheet[]> {
  const wbXmlRaw = await zipReadEntry(bytes, entries, 'xl/workbook.xml').catch(() => null)
  const relsRaw = await zipReadEntry(bytes, entries, 'xl/_rels/workbook.xml.rels').catch(() => null)
  if (wbXmlRaw && relsRaw) {
    const wbXml = new TextDecoder('utf-8').decode(wbXmlRaw)
    const relsXml = new TextDecoder('utf-8').decode(relsRaw)
    // Attribute order in real-world workbook.xml/.rels files isn't
    // guaranteed (varies by the tool that wrote it) — pull each attribute
    // independently out of the matched tag rather than assuming a fixed
    // order like "name before r:id" or "Id before Target".
    const relTargets: Record<string, string> = {}
    const relTagRe = /<Relationship\b[^>]*\/>/g
    let rtm: RegExpExecArray | null
    while ((rtm = relTagRe.exec(relsXml))) {
      const tag = rtm[0]
      const id = tag.match(/\bId="([^"]+)"/)?.[1]
      const target = tag.match(/\bTarget="([^"]+)"/)?.[1]
      if (id && target) relTargets[id] = target
    }
    const sheets: WorkbookSheet[] = []
    const sheetTagRe = /<sheet\b[^>]*\/>/g
    let stm: RegExpExecArray | null
    while ((stm = sheetTagRe.exec(wbXml))) {
      const tag = stm[0]
      const name = tag.match(/\bname="([^"]+)"/)?.[1]
      const rId = tag.match(/\br:id="([^"]+)"/)?.[1]
      if (!name || !rId) continue
      const target = relTargets[rId]
      if (!target) continue
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\//, '')}`
      sheets.push({ name: xmlUnescape(name), path })
    }
    if (sheets.length) return sheets
  }
  const fallback = Object.keys(entries).find((n) => /^xl\/worksheets\/sheet1\.xml$/i.test(n))
    ?? Object.keys(entries).find((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))
  return fallback ? [{ name: 'Sheet1', path: fallback }] : []
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Reads an .xlsx ArrayBuffer and returns the rows of whichever sheet
 * matches `tech` by name (normalized substring match, e.g. "4G LTE" or
 * "4G Template" both match tech '4G') — falling back to the first sheet
 * in the workbook if no tech-named sheet exists, so a plain single-sheet
 * template still works regardless of what its one sheet is called. */
export async function readXlsxRowsForTech(buffer: ArrayBuffer, tech: '4G' | '3G' | '2G'): Promise<string[][]> {
  const bytes = new Uint8Array(buffer)
  let entries: Record<string, ZipEntry>
  try {
    entries = zipListEntries(bytes)
  } catch {
    throw new Error('Could not read this file as an .xlsx workbook (not a valid ZIP container).')
  }
  const sheets = await listWorkbookSheets(bytes, entries)
  if (!sheets.length) throw new Error('Could not find any worksheet in this .xlsx file.')

  const techKey = normalize(tech)
  const matched = sheets.find((s) => normalize(s.name).includes(techKey)) ?? sheets[0]

  const shared = await readSharedStrings(bytes, entries)
  const sheetRaw = await zipReadEntry(bytes, entries, matched.path)
  if (!sheetRaw) throw new Error(`Could not read the "${matched.name}" worksheet.`)
  const sheetXml = new TextDecoder('utf-8').decode(sheetRaw)
  return sheetXmlToRows(sheetXml, shared)
}

/** Generic sibling of readXlsxRowsForTech (2026-08-05) — for uploads that
 * aren't tech-keyed (site/sector import, not drive-test data). Reads the
 * sheet whose name contains `nameHint` (normalized substring match, same
 * approach as the tech matcher above), or the first sheet in the
 * workbook if `nameHint` is omitted or doesn't match anything — so a
 * plain single-sheet export (e.g. this app's own "Site Details.xlsx"
 * export, re-uploaded as-is) always works regardless of what its one
 * sheet happens to be named. */
export async function readXlsxRows(buffer: ArrayBuffer, nameHint?: string): Promise<string[][]> {
  const bytes = new Uint8Array(buffer)
  let entries: Record<string, ZipEntry>
  try {
    entries = zipListEntries(bytes)
  } catch {
    throw new Error('Could not read this file as an .xlsx workbook (not a valid ZIP container).')
  }
  const sheets = await listWorkbookSheets(bytes, entries)
  if (!sheets.length) throw new Error('Could not find any worksheet in this .xlsx file.')

  const hintKey = nameHint ? normalize(nameHint) : ''
  const matched = (hintKey && sheets.find((s) => normalize(s.name).includes(hintKey))) || sheets[0]

  const shared = await readSharedStrings(bytes, entries)
  const sheetRaw = await zipReadEntry(bytes, entries, matched.path)
  if (!sheetRaw) throw new Error(`Could not read the "${matched.name}" worksheet.`)
  const sheetXml = new TextDecoder('utf-8').decode(sheetRaw)
  return sheetXmlToRows(sheetXml, shared)
}
