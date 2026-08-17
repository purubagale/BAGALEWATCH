// TRP File Analysis — deep protocol-level per-file diagnostic engine.
// Ported byte-exact from bts_monitor.html's TRP File Analysis feature
// (2026-08-11, "Add this feature from v1 as trp file analysis in
// separate submenu in DT data Manager"): the low-level ZIP/varint/
// protobuf-ish primitives at v1 lines ~9184-9494, and the analysis
// engine itself (TRPA_TECH_FIELDS + _trpaAnalyzeFile + _trpaCombineResults)
// at v1 lines ~9910-10339. See that file's own module comment for the
// full verification history: field-path dictionaries below are CONFIRMED
// against 3 real .trp files (2026-07-24) — a 4G DL (LTE) capture, a
// 4G-to-2G CSFB voice-fallback (GSM) capture, and a standalone 2G voice
// (GSM) capture. Every Summary statistic this engine computes was
// verified to match a reference analysis workbook's numbers exactly (or,
// for the one "max neighbor advantage" edge value, closely — a harmless
// nearest-sample tie-break difference). 3G/WCDMA remains UNVERIFIED — no
// real 3G sample was ever available in either v1 or this port — kept as
// best-effort candidate paths only, flagged as such everywhere it's
// surfaced (summary.unverifiedTech, the UI's tech tag/banner).
//
// Deliberately a SEPARATE, self-contained module from lib/xlsxReader.ts
// (which has its own private ZIP-entry primitives for reading .xlsx
// workbooks) rather than sharing code — this module's ZIP reader also
// needs to handle raw-deflate .trp payloads (not just XML worksheet
// parts), and duplicating ~40 lines of well-tested, byte-exact-ported ZIP
// scanning is a smaller risk than coupling two independently-verified
// parsers together.
//
// v2 had NO .trp binary decoder at all before this — dtTemplateParser.ts
// explicitly deferred it ("the single highest-risk item in the whole v2
// migration"). This module is that decoder, scoped specifically to the
// TRP File Analysis diagnostic feature (NOT wired into the DT session
// upload path, which still only accepts the CSV/XLSX template — that
// remains a separate, not-yet-done follow-up).

// ── Low-level primitives (v1 lines ~9184-9411) ──────────────────────────

interface ZipEntry {
  comp: number
  dataStart: number
  compSize: number
}

/** Reads a protobuf-style base-128 varint starting at `pos`. Returns
 * [value, nextPos]. Values are kept within 32 bits (`>>> 0`) — every real
 * field this engine reads (declaration IDs, lengths, wire tags) fits
 * comfortably within that range; matches v1's own implementation exactly,
 * including its 63-bit shift guard against a runaway/corrupt stream. */
function trpReadVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0
  let shift = 0
  while (true) {
    const b = buf[pos++]
    result |= (b & 0x7f) << shift
    if (!(b & 0x80)) return [result >>> 0, pos]
    shift += 7
    if (shift > 63) throw new Error('varint too long')
  }
}

function trpZipListEntries(bytes: Uint8Array): Record<string, ZipEntry> {
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

async function trpInflateRawRange(bytes: Uint8Array, start: number, len: number): Promise<Uint8Array> {
  const chunk = bytes.subarray(start, start + len)
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([chunk as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

async function trpZipReadEntry(bytes: Uint8Array, entries: Record<string, ZipEntry>, name: string): Promise<Uint8Array | null> {
  const e = entries[name]
  if (!e) return null
  if (e.comp === 0) return bytes.subarray(e.dataStart, e.dataStart + e.compSize)
  if (e.comp === 8) return await trpInflateRawRange(bytes, e.dataStart, e.compSize)
  return null
}

/** Every .trp app-layer part (declarations.cdf, data.cdf) has a 10-byte
 * header of unknown purpose before the raw-deflate payload starts — v1
 * discovered this by trial (see CLAUDE.md's "TRP channel.log format"
 * decision for the sibling channel.log case, bytes 0-7 header + 8-9
 * magic). Same "strip 10, inflate the rest" shape here. */
async function trpInflateAppLayer(bytes: Uint8Array | null): Promise<Uint8Array | null> {
  if (!bytes || bytes.length < 11) return null
  return await trpInflateRawRange(bytes, 10, bytes.length - 10)
}

function trpIsPathText(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 3) return false
  let s: string
  try {
    s = new TextDecoder('ascii', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return /^[A-Za-z][A-Za-z0-9_.[\]]{1,120}$/.test(s) && s.includes('.')
}

function trpIsLabelText(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 2 || bytes.length > 100) return false
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 32 || c >= 0x2028) return false
  }
  return true
}

export interface TrpDecl {
  id: number
  path: string
  label: string | null
}

/** Scans an inflated declarations.cdf part for every (path, id, label)
 * triple it declares — a length-delimited ASCII "path" string (protobuf
 * field 1), followed by a varint "id" (field 2), optionally followed by a
 * label string (field 3). .trp has no public spec; this shape was
 * reverse-engineered and confirmed against 3 real files (see module
 * comment above). */
export interface TrpDeclScanResult {
  decls: TrpDecl[]
  /** Number of times the scan had to fall back to a byte-by-byte resync
   * (i.e. a candidate 0x0a tag byte did NOT turn out to be the start of a
   * valid declaration record) — a rough noise/corruption signal. Zero on
   * a clean file where every 0x0a tag byte really does start a real
   * record; a handful is normal (a real 0x0a data byte can appear inside
   * an unrelated numeric field); a large fraction of the scanned range
   * suggests the part is corrupt or isn't actually a declarations.cdf at
   * all. */
  resyncCount: number
}

/** Message-boundary-aware version of the declaration scan (2026-08-11
 * robustness upgrade — "proper message-boundary-aware protobuf walk").
 * v1's original scan (and this port's first pass) unconditionally
 * advanced by exactly 1 byte per loop iteration regardless of whether a
 * declaration was just successfully parsed, re-scanning bytes that were
 * already consumed as part of that record. That's harmless in the common
 * case (a path/label's own bytes essentially never happen to contain a
 * stray 0x0a, since trpIsPathText/trpIsLabelText both reject byte 0x0a
 * from a valid path or label), but it's still scanning blind rather than
 * walking the actual record structure, which is both slower on large
 * declarations.cdf parts and more prone to a spurious duplicate/garbage
 * entry if a stray 0x0a genuinely does turn up mid-record in some
 * TEMS export variant this port hasn't seen. This version instead jumps
 * straight past a successfully-parsed record's own bytes, and only
 * falls back to a single-byte resync when parsing actually fails at the
 * current position — a real (if still heuristic, since there's no public
 * spec to conform to) message-boundary walk rather than a positional
 * byte scan. */
function trpScanDeclarations(buf: Uint8Array): TrpDeclScanResult {
  const results: TrpDecl[] = []
  const n = buf.length
  let pos = 0
  let resyncCount = 0
  while (pos < n - 4) {
    if (buf[pos] !== 0x0a) {
      pos++
      continue
    }
    const declStart = pos
    let length: number, p2: number
    try {
      ;[length, p2] = trpReadVarint(buf, pos + 1)
    } catch {
      pos = declStart + 1
      resyncCount++
      continue
    }
    if (length < 3 || length > 120 || p2 + length > n) {
      pos = declStart + 1
      resyncCount++
      continue
    }
    const pathBytes = buf.subarray(p2, p2 + length)
    if (!trpIsPathText(pathBytes)) {
      pos = declStart + 1
      resyncCount++
      continue
    }
    const path = new TextDecoder('ascii').decode(pathBytes)
    const p3 = p2 + length
    if (buf[p3] !== 0x10) {
      pos = declStart + 1
      resyncCount++
      continue
    }
    let pid: number, p4: number
    try {
      ;[pid, p4] = trpReadVarint(buf, p3 + 1)
    } catch {
      pos = declStart + 1
      resyncCount++
      continue
    }
    let label: string | null = null
    let afterRecord = p4
    if (buf[p4] === 0x1a) {
      try {
        const [llen, p5] = trpReadVarint(buf, p4 + 1)
        if (llen >= 1 && llen <= 100 && p5 + llen <= n) {
          const lb = buf.subarray(p5, p5 + llen)
          if (trpIsLabelText(lb)) {
            label = new TextDecoder('utf-8').decode(lb)
            afterRecord = p5 + llen
          }
        }
      } catch {
        // no usable label — fine, path/id alone is still a usable
        // declaration; afterRecord stays at p4 (right after the id).
      }
    }
    results.push({ id: pid, path, label })
    pos = afterRecord
  }
  return { decls: results, resyncCount }
}

type FlatField = [number, 'v' | 'f64' | 'len' | 'f32', number | Uint8Array]

/** Decodes a flat (non-nested-message-aware beyond one level) run of
 * protobuf-wire-format fields between [start, end) — wire types 0
 * (varint), 1 (fixed64), 2 (length-delimited), 5 (fixed32). Used both
 * directly (data.cdf's per-sample records) and recursively (the
 * length-delimited sub-messages those records nest their timestamp/
 * parameter-value pairs inside). */
function trpDecodeFlat(buf: Uint8Array, start: number, end: number): FlatField[] {
  const out: FlatField[] = []
  let pos = start
  while (pos < end) {
    let tag: number
    ;[tag, pos] = trpReadVarint(buf, pos)
    const field = tag >>> 3
    const wt = tag & 7
    if (wt === 0) {
      let val: number
      ;[val, pos] = trpReadVarint(buf, pos)
      out.push([field, 'v', val])
    } else if (wt === 1) {
      if (pos + 8 > end) throw new Error('trunc64')
      const view = new DataView(buf.buffer, buf.byteOffset + pos, 8)
      out.push([field, 'f64', view.getFloat64(0, true)])
      pos += 8
    } else if (wt === 2) {
      let length: number
      ;[length, pos] = trpReadVarint(buf, pos)
      if (pos + length > end) throw new Error('trunc-len')
      out.push([field, 'len', buf.subarray(pos, pos + length)])
      pos += length
    } else if (wt === 5) {
      if (pos + 4 > end) throw new Error('trunc32')
      const view = new DataView(buf.buffer, buf.byteOffset + pos, 4)
      out.push([field, 'f32', view.getFloat32(0, true)])
      pos += 4
    } else {
      throw new Error('bad wiretype ' + wt)
    }
  }
  return out
}

interface RawSample {
  ts: number
  values: Record<string, number>
}

export interface TrpDataScanResult {
  samples: RawSample[]
  /** True when the scan stopped before reaching the end of the buffer
   * because a record's length prefix couldn't be read, or a length-
   * prefixed record claimed to extend past the buffer's actual end —
   * both signs of a truncated/interrupted export (2026-08-11 robustness
   * upgrade — "harden error handling / partial-file resilience"). v1's
   * original behavior silently discarded everything from that point
   * onward with no way for the caller to tell a clean end-of-file from a
   * truncated one; this makes that distinction explicit so the UI can
   * warn "recovered N of an estimated M samples" instead of quietly
   * reporting a partial result as if it were complete. */
  truncated: boolean
  bytesConsumed: number
  totalBytes: number
}

/** Scans an inflated data.cdf part into timestamped samples. Each
 * top-level record is length-prefixed; field 1 (a nested message) carries
 * the sample's timestamp, field 3 (repeated nested messages) each carry
 * one (declaration id, value) pair. `wantedIds` maps declaration id ->
 * the human-readable path string to key the returned sample's `values`
 * object by — only ids present in that map are extracted, so callers can
 * cheaply scope this to a curated field set or widen it to "every
 * declared id" for the raw-dump mode. */
function trpScanDataRecords(buf: Uint8Array, wantedIds: Map<number, string>): TrpDataScanResult {
  const n = buf.length
  let pos = 0
  const samples: RawSample[] = []
  let truncated = false
  while (pos < n) {
    let reclen: number, pos2: number
    try {
      ;[reclen, pos2] = trpReadVarint(buf, pos)
    } catch {
      // Ran out of bytes mid-varint — this is only a real truncation if
      // there was meaningfully more than a few trailing pad bytes left;
      // a handful of leftover bytes after the last real record is normal
      // container padding, not corruption.
      truncated = n - pos > 4
      break
    }
    const recStart = pos2
    const recEnd = recStart + reclen
    if (recEnd > n) {
      // A record claims to extend past the actual buffer — the export
      // was cut off mid-record. Whatever's left is unusable; stop here
      // rather than guessing where the next record might start.
      truncated = true
      break
    }
    let fields: FlatField[]
    try {
      fields = trpDecodeFlat(buf, recStart, recEnd)
    } catch {
      pos = recEnd
      continue
    }
    let ts: number | null = null
    const values: Record<string, number> = {}
    for (const [f, kind, v] of fields) {
      if (f === 1 && kind === 'len') {
        try {
          const hdr = trpDecodeFlat(v as Uint8Array, 0, (v as Uint8Array).length)
          for (const [hf, hk, hv] of hdr) {
            if (hf === 1 && hk === 'v') ts = hv as number
          }
        } catch {
          // malformed timestamp sub-message — sample is dropped below
          // (ts stays null) rather than guessing.
        }
      } else if (f === 3 && kind === 'len') {
        try {
          const pfields = trpDecodeFlat(v as Uint8Array, 0, (v as Uint8Array).length)
          let pid: number | null = null
          let val: number | null = null
          for (const [pf, pk, pv] of pfields) {
            if (pf === 1 && pk === 'v') pid = pv as number
            else if (pf !== 1) val = pv as number
          }
          if (pid !== null && wantedIds.has(pid) && val !== null) values[wantedIds.get(pid) as string] = val
        } catch {
          // malformed parameter sub-message — skip just this one field.
        }
      }
    }
    if (ts !== null && Object.keys(values).length) samples.push({ ts, values })
    pos = recEnd
  }
  return { samples, truncated, bytesConsumed: pos, totalBytes: n }
}

interface GpsPoint {
  t: number
  lat: number
  lon: number
}

function trpParseGpxTrack(xmlText: string): GpsPoint[] {
  const pts: GpsPoint[] = []
  const re = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xmlText))) {
    const lat = parseFloat(m[1])
    const lon = parseFloat(m[2])
    const t = Date.parse(m[3]) / 1000
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t)) pts.push({ t, lat, lon })
  }
  pts.sort((a, b) => a.t - b.t)
  return pts
}

function trpCorrelateGps(pts: GpsPoint[], ts: number): { lat: number; lng: number } | null {
  if (!pts.length) return null
  if (ts <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lon }
  if (ts >= pts[pts.length - 1].t) return { lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lon }
  let lo = 0
  let hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid].t <= ts) lo = mid
    else hi = mid
  }
  const a = pts[lo]
  const b = pts[hi]
  const frac = b.t === a.t ? 0 : (ts - a.t) / (b.t - a.t)
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lon + (b.lon - a.lon) * frac }
}

function trpFindDecl(decls: TrpDecl[], candidatePaths: string[]): TrpDecl | null {
  for (const p of candidatePaths) {
    const d = decls.find((x) => x.path === p)
    if (d) return d
  }
  return null
}

// ── Per-tech field-path dictionaries (v1 lines ~9931-10015) ─────────────

export type TrpaTech = '4G' | '3G' | '2G'

interface TrpaTechConfig {
  servingPrimary: string[]
  serving: Record<string, string[]>
  neighbor: Record<string, string[]>
  levelField: string
  levelUnit: string
  qualityField: string
  qualityUnit: string
  identityField: string
  neighborIdentityField: string
  neighborLevelField: string
  weakThreshold: number
  /** Dot-path prefixes that scope a declaration to this tech (2026-08-11
   * robustness upgrade — "discover unknown fields automatically"). The
   * curated `serving`/`neighbor` dictionaries above only list the field
   * paths this port's authors have actually seen or expect; real TEMS
   * exports declare many more per-tech fields (timing, power control,
   * scheduling, etc.) that were never worth hand-curating individually.
   * Any declaration whose path starts with one of these prefixes, isn't
   * already one of the curated paths, and looks Serving- or Neighbor-
   * shaped gets picked up automatically — see the auto-discovery block
   * in trpaAnalyzeFile. */
  namespacePrefixes: string[]
}

const TRPA_TECH_FIELDS: Record<TrpaTech, TrpaTechConfig> = {
  '4G': {
    servingPrimary: ['Radio.Lte.ServingCell[8].Rsrp'],
    serving: {
      rsrp: ['Radio.Lte.ServingCell[8].Rsrp'],
      rsrq: ['Radio.Lte.ServingCell[8].Rsrq'],
      sinr: ['Radio.Lte.ServingCell[8].RsSinr', 'Radio.Lte.ServingCell[8].Sinr'],
      rssi: ['Radio.Lte.ServingCell[8].Rssi'],
      pci: ['Radio.Lte.ServingCell[8].Pci'],
      band: ['Radio.Lte.ServingCell[8].Band'],
      earfcn: ['Radio.Lte.ServingCell[8].Downlink.Earfcn'],
      cellIdCell: ['Radio.Lte.ServingCell[8].CellIdentity.Cell'],
      cellIdEnb: ['Radio.Lte.ServingCell[8].CellIdentity.eNodeB'],
      cellIdComplete: ['Radio.Lte.ServingCell[8].CellIdentity.Complete'],
      pdschBler: ['Radio.Lte.ServingCell[8].Pdsch.Bler'],
      pdschRbPct: ['Radio.Lte.ServingCell[8].Pdsch.ResourceBlocksPercentage', 'Radio.Lte.ServingCell[8].Pdsch.ResourceBlockAllocationPercentage'],
      pdschThroughput: ['Radio.Lte.ServingCell[8].Pdsch.Throughput'],
      rankIndication: ['Radio.Lte.ServingCell[8].RankIndication'],
      cqi: ['Radio.Lte.ServingCell[8].CqiCodeword0Average', 'Radio.Lte.ServingCell[8].Stream[2].Cqi'],
      timingAdvance: ['Radio.Lte.ServingCell[8].TimingAdvance'],
      tac: ['Radio.Lte.ServingSystem.Tac'],
    },
    neighbor: {
      rsrp: ['Radio.Lte.Neighbor[64].Rsrp'],
      rsrq: ['Radio.Lte.Neighbor[64].Rsrq'],
      rssi: ['Radio.Lte.Neighbor[64].Rssi'],
      pci: ['Radio.Lte.Neighbor[64].Pci'],
      earfcn: ['Radio.Lte.Neighbor[64].Earfcn'],
      type: ['Radio.Lte.Neighbor[64].NeighborType'],
    },
    levelField: 'rsrp', levelUnit: 'dBm', qualityField: 'rsrq', qualityUnit: 'dB',
    identityField: 'cellIdComplete', neighborIdentityField: 'pci', neighborLevelField: 'rsrp',
    weakThreshold: -105,
    namespacePrefixes: ['Radio.Lte.'],
  },
  '3G': {
    // UNVERIFIED — no real WCDMA/UMTS sample tested, here or in v1.
    // Best-effort candidate paths only, following the same naming
    // convention TEMS uses for the CONFIRMED 4G/2G lists above.
    servingPrimary: ['Radio.Umts.ServingCell.Rscp', 'Radio.Wcdma.ServingCell.Rscp', 'Radio.Umts.ServingCell[8].Rscp'],
    serving: {
      rscp: ['Radio.Umts.ServingCell.Rscp', 'Radio.Wcdma.ServingCell.Rscp', 'Radio.Umts.ServingCell[8].Rscp'],
      ecno: ['Radio.Umts.ServingCell.EcNo', 'Radio.Umts.ServingCell.EcIo', 'Radio.Wcdma.ServingCell.EcNo'],
      scramblingCode: ['Radio.Umts.ServingCell.ScramblingCode', 'Radio.Umts.ServingCell.Psc'],
    },
    neighbor: {
      rscp: ['Radio.Umts.Neighbor[64].Rscp'],
      ecno: ['Radio.Umts.Neighbor[64].EcNo'],
      scramblingCode: ['Radio.Umts.Neighbor[64].ScramblingCode', 'Radio.Umts.Neighbor[64].Psc'],
    },
    levelField: 'rscp', levelUnit: 'dBm', qualityField: 'ecno', qualityUnit: 'dB',
    identityField: 'scramblingCode', neighborIdentityField: 'scramblingCode', neighborLevelField: 'rscp',
    weakThreshold: -100,
    namespacePrefixes: ['Radio.Umts.', 'Radio.Wcdma.'],
  },
  '2G': {
    servingPrimary: ['Radio.Gsm.ServingCell.RssiFull', 'Radio.Gsm.ServingCell.RssiSub'],
    serving: {
      rssiFull: ['Radio.Gsm.ServingCell.RssiFull'],
      rssiSub: ['Radio.Gsm.ServingCell.RssiSub'],
      rxQualFull: ['Radio.Gsm.ServingCell.RxQualFull'],
      rxQualSub: ['Radio.Gsm.ServingCell.RxQualSub'],
      berActual: ['Radio.Gsm.ServingCell.BitErrorRateActual'],
      berFull: ['Radio.Gsm.ServingCell.BitErrorRateFull'],
      berSub: ['Radio.Gsm.ServingCell.BitErrorRateSub'],
      bcch: ['Radio.Gsm.CurrentArfcn', 'Radio.Gsm.ServingCell.Bcch.Arfcn'],
      bsic: ['Radio.Gsm.ServingCell.Bsic'],
      c1: ['Radio.Gsm.ServingCell.C1'],
      c2: ['Radio.Gsm.ServingCell.C2'],
      cellIdentity: ['Radio.Gsm.ServingCell.CellIdentity'],
      lac: ['Radio.Gsm.ServingCell.Lac'],
      frequencyBand: ['Radio.Gsm.FrequencyBand'],
      msPowerControlLevel: ['Radio.Gsm.ServingCell.MsPowerControlLevel'],
      txPower: ['Radio.Gsm.ServingCell.TxPower'],
    },
    neighbor: {
      rssi: ['Radio.Gsm.Neighbor[64].Rssi'],
      arfcn: ['Radio.Gsm.Neighbor[64].Arfcn'],
      bsic: ['Radio.Gsm.Neighbor[64].Bsic'],
      c1: ['Radio.Gsm.Neighbor[64].C1'],
      c2: ['Radio.Gsm.Neighbor[64].C2'],
    },
    levelField: 'rssiFull', levelUnit: 'dBm', qualityField: 'rxQualFull', qualityUnit: '',
    identityField: 'cellIdentity', neighborIdentityField: 'arfcn', neighborLevelField: 'rssi',
    weakThreshold: -95,
    namespacePrefixes: ['Radio.Gsm.'],
  },
}

// ── Small numeric/formatting helpers (v1 lines ~10017-10047) ────────────

function trpaHaversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function trpaPercentile(vals: number[], p: number): number | null {
  if (!vals || !vals.length) return null
  const s = [...vals].sort((a, b) => a - b)
  const k = (s.length - 1) * p
  const f = Math.floor(k)
  const c = Math.ceil(k)
  if (f === c) return s[k]
  return s[f] + (s[c] - s[f]) * (k - f)
}

function trpaRound(v: number | null, d: number): number | null {
  if (v == null) return null
  return Math.round(v * 10 ** d) / 10 ** d
}

/** Some declared fields (IMSI, IMEI, APN strings, etc.) are length-
 * delimited byte arrays, not numbers. Curated tech fields (Rsrp/Rssi/
 * Pci/etc.) are all numeric in every verified real file, so this never
 * affects them — it only matters for the "every declared field" raw
 * dump, rendering those bytes as a readable string/hex instead of a
 * broken object. */
function trpaFormatRawValue(val: number | Uint8Array | null): string | number | null {
  if (val == null) return null
  if (typeof val === 'number') return val
  if (val instanceof Uint8Array) {
    let printable = val.length > 0
    for (let i = 0; i < val.length; i++) {
      const b = val[i]
      if (b < 0x20 || b > 0x7e) {
        printable = false
        break
      }
    }
    if (printable) return new TextDecoder('ascii').decode(val)
    return '0x' + Array.from(val).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return String(val)
}

// ── Compound event extraction (2026-08-14, "detect and store... events
// for which the log is taken like fallback events from fallback log,
// download success event from DL log etc") ──────────────────────────────
//
// Everything above (trpScanDataRecords + the curated per-tech field
// dictionaries) only ever decodes ONE level of nesting: a data.cdf sample
// record's field-3 "parameter" list, where each parameter is a flat
// [declared id, scalar value] pair. Real TEMS exports ALSO declare
// compound "Event" records under Call.*/Data.*/Location.* namespaces
// (confirmed 2026-08-14 by hand against 3 real sample files — a voice-
// call capture, a 4G DL/FTP capture, and a second voice-call capture with
// a Location.PositionLostEvent) whose "value" bytes are themselves
// ANOTHER full set of [child declared id, child value] pairs — the exact
// same wire shape as the outer parameter list, just one level deeper.
// Real decoded examples from that investigation: Call.CallEndEvent
// (CallEstablished, Cause, EndType, ServingRadioTechnology),
// Call.CallSetupEvent (SetupTime), Data.Ftp.Download.EndEvent (File,
// FileSize, Duration, ServiceThroughputAverage, ServiceStatus,
// ClientIpAddress, ServerIpAddress), Data.SessionStatisticsEvent
// (LteBandwidth, LteFrequencyBand, AverageThroughputLte, TimeSpentOnLte).
// These are entirely separate from the Radio.* signal dictionaries above
// — they carry real, TEMS-native, explicitly-tagged occurrences, exactly
// the "TEMS's own explicit marker" the user asked for over any inferred/
// threshold-based detection.
//
// Deliberately generic rather than a hardcoded Call/Data/Location field
// dictionary (the user's own scoping answer: "according to the log
// file" — whatever event types a given file's declarations actually
// contain should be picked up, not a fixed upfront category list). The
// approach: for EVERY field-3 parameter entry in EVERY sample record
// (not just ones in a curated `wantedIds` map — a plain scalar dictionary
// lookup would miss these entirely, since compound-event declarations
// were never added to any per-tech `serving`/`neighbor` dictionary),
// attempt to decode its value bytes as a nested [child id, child value]
// list via the exact same decode shape trpScanDataRecords already uses
// for the outer parameter list. If that nested decode succeeds AND every
// child id resolves to a real declared path, it's treated as a genuine
// compound event (type = the outer field's own declared path, e.g.
// "Call.CallEndEvent"); if decoding fails or even ONE child id is
// unrecognized, it's left alone as an ordinary scalar/opaque field (same
// conservative "don't fabricate" stance as trpaFormatRawValue's own
// printable/hex fallback) — never guessed at.
export interface TrpaEventRow {
  ts: number
  isoTs: string
  lat: number | null
  lon: number | null
  /** The compound event's own declared path, e.g. "Call.CallEndEvent",
   * "Data.Ftp.Download.EndEvent", "Location.PositionLostEvent" — whatever
   * this specific file's declarations.cdf actually names it. */
  type: string
  /** Decoded child field path -> value, e.g. { "Call.CallEndEvent.Cause":
   * 2, "Call.CallEndEvent.CallEstablished": 0 }. Keyed by the child's own
   * full declared path (not a short name) so two different event types
   * sharing a field name never collide. */
  fields: Record<string, string | number>
}

/** Attempts to decode one field-3 parameter's `value` bytes as a nested
 * compound event (see module comment above). Returns null (treat as an
 * ordinary non-event field) unless EVERY top-level item in `value`
 * decodes cleanly as a [declared child id, value] pair with a KNOWN
 * child declaration — a strict, conservative match, not a best-effort
 * guess, since a real scalar byte-string field (an IMSI, an APN, ordinary
 * opaque bytes) could otherwise coincidentally parse as garbage-looking
 * "fields" if this were lenient. */
function trpTryDecodeEventFields(value: Uint8Array, declById: Map<number, TrpDecl>): Record<string, string | number> | null {
  let inner: FlatField[]
  try {
    inner = trpDecodeFlat(value, 0, value.length)
  } catch {
    return null
  }
  if (!inner.length) return null
  const fields: Record<string, string | number> = {}
  for (const [, kind, v] of inner) {
    if (kind !== 'len') return null
    let pair: FlatField[]
    try {
      pair = trpDecodeFlat(v as Uint8Array, 0, (v as Uint8Array).length)
    } catch {
      return null
    }
    let childId: number | null = null
    let childVal: number | Uint8Array | null = null
    for (const [pf, pk, pv] of pair) {
      if (pf === 1 && pk === 'v') childId = pv as number
      else if (pf !== 1) childVal = pv as number | Uint8Array
    }
    if (childId === null || childVal === null) return null
    const decl = declById.get(childId)
    if (!decl) return null
    const formatted = trpaFormatRawValue(childVal)
    if (formatted === null) return null
    fields[decl.path] = formatted
  }
  return Object.keys(fields).length ? fields : null
}

/** Excluded from event extraction (2026-08-14, verified live against the
 * 3 real sample files): TEMS also declares hundreds of RAW over-the-air
 * Layer3 protocol messages this same way (MeasurementReport, PagingRequest,
 * SystemInformation, the GSM Cc/Mm/Rr call-control messages, etc., all
 * under Message.Layer3.*, plus a generic Radio.Common.Layer3MessageEvent
 * wrapper that fires once per message). These decode 100% correctly by the
 * exact same nested-pair logic as a real named event — confirmed live: a
 * single 46-second 2G voice capture alone produced 289 of them — but they
 * are a raw protocol TRACE, not the kind of named business/service
 * occurrence the user asked for ("fallback events... download success
 * event"). Bundling hundreds of these into every session's persisted meta
 * JSON (fetched on every session-list load) would be architecturally wrong
 * for what meta is for (a small aggregate blob, not a full protocol log) —
 * and would bury the handful of real Call/Data/Location events that
 * actually matter. Everything else this file's declarations contain still
 * gets picked up generically (Call.*, Data.*, Location.*, the periodic
 * Radio.Lte.SessionStatistics.*Event/SessionUsage.*Event snapshots, etc.)
 * — this is a targeted 2-item exclusion of a firehose category, not a
 * narrowing back down to a fixed category whitelist. A full raw Layer3
 * message trace would be a good fit for the separate TRP File Analysis
 * diagnostic page (unbounded, throwaway, XLSX-exportable) if ever wanted
 * there — just not for this session-tied feature. */
const EXCLUDED_EVENT_PATH_PREFIXES = ['Message.Layer3.']
const EXCLUDED_EVENT_PATHS = new Set(['Radio.Common.Layer3MessageEvent'])
function isExcludedEventPath(path: string): boolean {
  if (EXCLUDED_EVENT_PATHS.has(path)) return true
  return EXCLUDED_EVENT_PATH_PREFIXES.some((p) => path.startsWith(p))
}

/** Scans an inflated data.cdf part for compound events, independent of
 * (and in addition to) trpScanDataRecords' curated scalar extraction
 * above — see module comment. Walks the same record structure (field 1 =
 * timestamp sub-message, field 3 = repeated parameter entries) but
 * inspects EVERY parameter regardless of `wantedIds`, since event-root
 * declarations are never in the curated per-tech dictionaries.
 * Defensively capped at `maxEvents` (real files carry a handful to a few
 * dozen per file — see module comment's real examples — so this should
 * never actually trigger; it exists only as insurance against a
 * pathological file, matching this codebase's general defensiveness
 * convention). */
function trpScanEvents(
  buf: Uint8Array,
  declById: Map<number, TrpDecl>,
  maxEvents = 5000,
): { events: { ts: number; type: string; fields: Record<string, string | number> }[]; capped: boolean } {
  const n = buf.length
  let pos = 0
  const events: { ts: number; type: string; fields: Record<string, string | number> }[] = []
  let capped = false
  while (pos < n) {
    let reclen: number, pos2: number
    try {
      ;[reclen, pos2] = trpReadVarint(buf, pos)
    } catch {
      break
    }
    const recStart = pos2
    const recEnd = recStart + reclen
    if (recEnd > n) break
    let fields: FlatField[]
    try {
      fields = trpDecodeFlat(buf, recStart, recEnd)
    } catch {
      pos = recEnd
      continue
    }
    let ts: number | null = null
    for (const [f, kind, v] of fields) {
      if (f === 1 && kind === 'len') {
        try {
          const hdr = trpDecodeFlat(v as Uint8Array, 0, (v as Uint8Array).length)
          for (const [hf, hk, hv] of hdr) if (hf === 1 && hk === 'v') ts = hv as number
        } catch {
          // malformed timestamp sub-message — event(s) in this record are
          // skipped below (ts stays null), same as trpScanDataRecords.
        }
      }
    }
    if (ts !== null) {
      for (const [f, kind, v] of fields) {
        if (f !== 3 || kind !== 'len') continue
        try {
          const pfields = trpDecodeFlat(v as Uint8Array, 0, (v as Uint8Array).length)
          let pid: number | null = null
          let val: number | Uint8Array | null = null
          for (const [pf, pk, pv] of pfields) {
            if (pf === 1 && pk === 'v') pid = pv as number
            else if (pf !== 1) val = pv as number | Uint8Array
          }
          if (pid === null || val === null || !(val instanceof Uint8Array)) continue
          const rootDecl = declById.get(pid)
          if (!rootDecl || isExcludedEventPath(rootDecl.path)) continue
          const decoded = trpTryDecodeEventFields(val, declById)
          if (!decoded) continue
          if (events.length >= maxEvents) {
            capped = true
            continue
          }
          events.push({ ts, type: rootDecl.path, fields: decoded })
        } catch {
          // malformed parameter sub-message — skip just this one field.
        }
      }
    }
    pos = recEnd
  }
  return { events, capped }
}

// ── Per-file analysis (v1 lines ~10055-10254) ────────────────────────────

export type TrpaRow = { ts: number; isoTs: string; lat: number | null; lon: number | null } & Record<string, unknown>

export interface TrpaBestServerRow {
  isoTs: string
  neighborId: unknown
  neighborLevel: number
  servingLevel: number
  servingQuality: number | null
  delta: number | null
  timeGapS: number | null
  strongerByMargin: boolean
}

export interface TrpaSummary {
  fileName: string
  technology: TrpaTech
  provider: string
  gpsFixCount: number
  gpsSpanMApprox: number | null
  mobility: string
  meanLat: number | null
  meanLon: number | null
  gridBinId: string | null
  servingLevelField: string
  servingLevelUnit: string
  servingLevelSamples: number
  servingLevelMean: number | null
  servingLevelP10: number | null
  servingLevelMin: number | null
  servingLevelMax: number | null
  servingQualityField: string
  servingQualityUnit: string
  servingQualitySamples: number
  servingQualityMean: number | null
  servingQualityP10: number | null
  distinctServingCellIds: number
  servingCellIds: string
  distinctNeighborCellsSeen: number
  neighborSightingsCompared: number
  neighborSightingsWithin6dBOrStronger: number
  maxNeighborAdvantageDb: number | null
  siteClassification: string
  unverifiedTech: boolean
}

export interface TrpaRawSample {
  ts: number
  isoTs: string
  lat: number | null
  lon: number | null
  values: Record<string, string | number | null>
}

export interface TrpaFileResult {
  tech: TrpaTech
  provider: string
  servingRows: TrpaRow[]
  neighborRows: TrpaRow[]
  bestServerRows: TrpaBestServerRow[]
  summary: TrpaSummary
  servingKeysFound: string[]
  neighborKeysFound: string[]
  /** Subsets of servingKeysFound/neighborKeysFound that were NOT in the
   * curated candidate dictionary — picked up by the 2026-08-11
   * auto-discovery pass. Empty on a file where TEMS declared nothing
   * beyond the curated set. */
  autoDiscoveredServingKeys: string[]
  autoDiscoveredNeighborKeys: string[]
  fieldPaths: { serving: Record<string, string>; neighbor: Record<string, string> }
  cfg: TrpaTechConfig
  rawSamples: TrpaRawSample[]
  rawPaths: string[]
  rawPathLabels: Record<string, string>
  rawTruncated: boolean
  totalDeclarationsFound: number
  /** Compound events decoded from this file — see the "Compound event
   * extraction" module comment above trpTryDecodeEventFields. Whatever
   * event types this file's own declarations actually contain (the Call
   * namespace for a voice/fallback-type capture, the Data/Ftp namespace
   * for a download-type capture, the Location namespace where present) —
   * never a fixed category list. Empty array (not undefined) when the
   * file has no recognizable compound events at all. */
  events: TrpaEventRow[]
  /** Human-readable notes about anything this file's parse had to work
   * around — missing/unparseable GPS track, a noisy declaration scan
   * (many single-byte resyncs), data.cdf truncation, or falling back
   * past an unreadable provider. Empty for a clean parse. Surfaced in
   * TrpAnalysisPage's Files Overview and the XLSX export's warnings
   * column (2026-08-11 robustness upgrade). */
  warnings: string[]
}

/** Best-effort per-tech site/area classification, shared by both the
 * per-file summary and the combined per-tech rollup below — identical
 * thresholds in both places (v1 duplicates this logic rather than
 * factoring it out too, so this port mirrors that exactly to avoid
 * introducing a divergence that isn't in the original). */
function classify(within6: number, neighborIdCount: number, maxAdv: number | null, levelMean: number | null, weakThreshold: number): string {
  if (within6 > 0) return 'handover candidate present (a neighbor was >6 dB stronger than serving at least once)'
  if (neighborIdCount >= 3 && maxAdv != null && maxAdv > -6) return 'multi-cell overlap zone (several candidate cells visible)'
  if (levelMean != null && levelMean < weakThreshold) return 'coverage-limited (weak serving signal, no stronger alternative seen)'
  return 'stable single-server coverage'
}

function mobilityLabel(spanM: number): string {
  if (spanM < 10) return 'stationary (<10 m)'
  if (spanM < 100) return 'walking (<100 m)'
  return `vehicle/drive (${Math.round(spanM)} m span)`
}

export interface TrpaAnalyzeOpts {
  extractRaw?: boolean
  rawCellBudget?: number
}

/** Decodes one .trp file into a full per-file analysis result. Reuses the
 * primitives above the same way v1's engine does: locate whichever
 * `trp/providers/sp{N}/cdf/declarations.cdf` part actually declares one
 * of the three techs' serving-cell signal field (first match wins), then
 * decode `data.cdf` from that same provider. Throws if the file isn't a
 * ZIP container or no recognized tech is found — caller (the page) shows
 * that per-file, doesn't abort the whole batch. */
export async function trpaAnalyzeFile(buffer: ArrayBuffer, fileName: string, opts?: TrpaAnalyzeOpts): Promise<TrpaFileResult> {
  const bytes = new Uint8Array(buffer)
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('Not a ZIP-container TRP file (unsupported/legacy format)')
  const entries = trpZipListEntries(bytes)
  const warnings: string[] = []

  const gpxRaw = await trpZipReadEntry(bytes, entries, 'trp/positions/wptrack.xml').catch(() => null)
  const gpsPoints = gpxRaw ? trpParseGpxTrack(new TextDecoder('utf-8').decode(gpxRaw)) : []
  if (!gpxRaw) warnings.push('No GPS track found (trp/positions/wptrack.xml missing) — rows will have no lat/lon.')
  else if (!gpsPoints.length) warnings.push('GPS track file was present but contained no usable waypoints — rows will have no lat/lon.')

  // Provider selection (2026-08-11 robustness upgrade — "harden error
  // handling / partial-file resilience"). v1's original loop, and this
  // port's first pass, committed to the FIRST provider whose
  // declarations.cdf matched a tech's serving-signal field, then read
  // that provider's data.cdf afterward, unconditionally — if that
  // data.cdf turned out to be missing/corrupt, the whole file failed with
  // no fallback even when a later provider entry would have worked. Now
  // both declarations AND data.cdf are confirmed readable before a
  // provider is committed to; a failure at either step just moves on to
  // the next candidate and leaves a note in `warnings`.
  const declNames = Object.keys(entries).filter((n) => /^trp\/providers\/sp\d+\/cdf\/declarations\.cdf$/.test(n))
  let chosenProvider: string | null = null
  let chosenTech: TrpaTech | null = null
  let decls: TrpDecl[] | null = null
  let dataInflated: Uint8Array | null = null
  let totalResyncCount = 0
  outer: for (const declName of declNames) {
    const provider = (declName.match(/sp\d+/) as RegExpMatchArray)[0]
    const raw = await trpZipReadEntry(bytes, entries, declName).catch(() => null)
    if (!raw) continue
    const inflated = await trpInflateAppLayer(raw).catch(() => null)
    if (!inflated) continue
    const { decls: d, resyncCount } = trpScanDeclarations(inflated)
    for (const tech of Object.keys(TRPA_TECH_FIELDS) as TrpaTech[]) {
      const cfg = TRPA_TECH_FIELDS[tech]
      if (!trpFindDecl(d, cfg.servingPrimary)) continue
      const dataRawCandidate = await trpZipReadEntry(bytes, entries, `trp/providers/${provider}/cdf/data.cdf`).catch(() => null)
      if (!dataRawCandidate) {
        warnings.push(`Provider ${provider} declared ${tech} fields but its data.cdf was missing — tried the next provider.`)
        continue
      }
      const dataInflatedCandidate = await trpInflateAppLayer(dataRawCandidate).catch(() => null)
      if (!dataInflatedCandidate) {
        warnings.push(`Provider ${provider} declared ${tech} fields but its data.cdf could not be decompressed — tried the next provider.`)
        continue
      }
      chosenProvider = provider
      chosenTech = tech
      decls = d
      dataInflated = dataInflatedCandidate
      totalResyncCount = resyncCount
      break outer
    }
  }
  if (!chosenProvider || !chosenTech || !decls || !dataInflated) {
    const suffix = warnings.length ? ` (${warnings[warnings.length - 1]})` : ''
    throw new Error(`No recognized 4G/3G/2G serving-cell signal declaration with readable sample data found in this file.${suffix}`)
  }
  if (totalResyncCount > 20) {
    warnings.push(`Declaration scan needed ${totalResyncCount} byte-level resyncs — the declarations.cdf part may be partially corrupt; some fields could be missing.`)
  }

  const cfg = TRPA_TECH_FIELDS[chosenTech]
  const servingKeysFound: string[] = []
  const neighborKeysFound: string[] = []
  const fieldPaths = { serving: {} as Record<string, string>, neighbor: {} as Record<string, string> }
  for (const key of Object.keys(cfg.serving)) {
    const d = trpFindDecl(decls, cfg.serving[key])
    if (d) {
      servingKeysFound.push(key)
      fieldPaths.serving[key] = d.path
    }
  }
  for (const key of Object.keys(cfg.neighbor)) {
    const d = trpFindDecl(decls, cfg.neighbor[key])
    if (d) {
      neighborKeysFound.push(key)
      fieldPaths.neighbor[key] = d.path
    }
  }

  // Auto-discovery beyond the curated candidate list (2026-08-11
  // robustness upgrade — "discover unknown fields automatically"). The
  // curated dictionaries above are a hand-picked subset of what TEMS
  // actually declares; anything else under this tech's namespace that
  // looks Serving- or Neighbor-shaped is picked up here too, keyed as
  // `auto_<pathSegments>` so it can never collide with a curated key name.
  // This is purely additive: it widens which columns get populated in the
  // Serving/Neighbor tabs, but summary stats (levelField/qualityField/
  // identityField etc.) stay pinned to the curated keys above — an
  // auto-discovered field is never promoted into a "summary" role, since
  // there's no principled way to know which of several unknown fields is
  // the one worth headlining.
  const curatedPathSet = new Set([...Object.values(fieldPaths.serving), ...Object.values(fieldPaths.neighbor)])
  const autoDiscoveredServingKeys: string[] = []
  const autoDiscoveredNeighborKeys: string[] = []
  const seenAutoKeys = new Set<string>()
  for (const d of decls) {
    if (curatedPathSet.has(d.path)) continue
    if (!cfg.namespacePrefixes.some((prefix) => d.path.startsWith(prefix))) continue
    const isNeighbor = /\bNeighbor\b/.test(d.path)
    const isServing = !isNeighbor && /\bServing(Cell|System)\b/.test(d.path)
    if (!isNeighbor && !isServing) continue
    let autoKey = `auto_${d.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
    if (seenAutoKeys.has(autoKey)) autoKey = `${autoKey}_${d.id}`
    seenAutoKeys.add(autoKey)
    if (isNeighbor) {
      neighborKeysFound.push(autoKey)
      fieldPaths.neighbor[autoKey] = d.path
      autoDiscoveredNeighborKeys.push(autoKey)
    } else {
      servingKeysFound.push(autoKey)
      fieldPaths.serving[autoKey] = d.path
      autoDiscoveredServingKeys.push(autoKey)
    }
  }

  // Full raw extraction ("every possible field") is opt-in via `opts.
  // extractRaw` — extracting + holding every declared field for every
  // sample in memory, times multiple uploaded files, crashed the browser
  // tab (OOM) on real multi-file batches in v1 (confirmed 2026-07-24).
  // Default false here (curated-only) unless the caller explicitly asks.
  const extractRaw = !!opts?.extractRaw
  const rawCellBudget = opts?.rawCellBudget || 3000000
  const wantedAll = new Map<number, string>()
  const pathToDecl = new Map<string, TrpDecl>()
  for (const d of decls) pathToDecl.set(d.path, d)
  if (extractRaw) {
    for (const d of decls) wantedAll.set(d.id, d.path)
  } else {
    const curatedPaths = new Set([...Object.values(fieldPaths.serving), ...Object.values(fieldPaths.neighbor)])
    for (const d of decls) if (curatedPaths.has(d.path)) wantedAll.set(d.id, d.path)
  }

  // dataInflated was already read + decompressed during provider
  // selection above (so a bad data.cdf can trigger provider fallback
  // instead of failing the whole file) — no need to re-fetch it here.
  const { samples, truncated: dataTruncated, bytesConsumed, totalBytes } = trpScanDataRecords(dataInflated, wantedAll)
  if (dataTruncated) {
    const pct = totalBytes > 0 ? Math.round((bytesConsumed / totalBytes) * 100) : 0
    warnings.push(`Sample data (data.cdf) appears truncated — stopped after ${pct}% of the decompressed bytes; later samples in the drive are likely missing.`)
  }

  // Compound-event extraction (2026-08-14) — independent pass over the
  // SAME already-inflated dataInflated buffer (no extra decompression
  // cost), using ALL of this provider's declared ids (not just the
  // curated wantedAll set above) since event-root declarations were
  // never added to any per-tech serving/neighbor dictionary. See
  // trpScanEvents' own comment for why this can't reuse wantedAll.
  const declById = new Map<number, TrpDecl>()
  for (const d of decls) declById.set(d.id, d)
  const { events: rawEvents, capped: eventsCapped } = trpScanEvents(dataInflated, declById)
  const events: TrpaEventRow[] = rawEvents
    .map((e) => {
      const gps = trpCorrelateGps(gpsPoints, e.ts)
      return {
        ts: e.ts,
        isoTs: new Date(Math.round(e.ts * 1000)).toISOString(),
        lat: gps ? gps.lat : null,
        lon: gps ? gps.lng : null,
        type: e.type,
        fields: e.fields,
      }
    })
    .sort((a, b) => a.ts - b.ts)
  if (events.length) {
    warnings.push(`Found ${events.length} named event(s) with explicit TEMS markers (e.g. call setup/end, FTP download completion) beyond the curated radio fields — see Events.`)
  }
  if (eventsCapped) {
    warnings.push('Event extraction hit its per-file cap (5000 events) — later events were dropped.')
  }

  const servingRows: TrpaRow[] = []
  const neighborRows: TrpaRow[] = []
  const rawSamples: TrpaRawSample[] = []
  // Wide (pivoted) raw extraction: one row per SAMPLE, one column per
  // declared parameter. Cap is cell-budget-aware (samples × distinct-
  // paths-in-this-file) AND the budget itself is shared across the whole
  // uploaded batch (computed by the caller as a fixed total divided by
  // file count), so total memory stays roughly bounded regardless of how
  // many files are uploaded at once — same as v1.
  const allPathsSet = new Set<string>()
  let rawSampleCap = 0
  if (extractRaw) {
    for (const s of samples) for (const p of Object.keys(s.values)) allPathsSet.add(p)
    rawSampleCap = Math.max(2000, Math.floor(rawCellBudget / Math.max(1, allPathsSet.size)))
  }
  let rawTruncated = false
  for (const s of samples) {
    const gps = trpCorrelateGps(gpsPoints, s.ts)
    const isoTs = new Date(Math.round(s.ts * 1000)).toISOString()
    const lat = gps ? gps.lat : null
    const lon = gps ? gps.lng : null
    const srv: Record<string, unknown> = {}
    const nbr: Record<string, unknown> = {}
    const rawVals: Record<string, string | number | null> | null = extractRaw ? {} : null
    for (const path of Object.keys(s.values)) {
      const val = trpaFormatRawValue(s.values[path])
      if (extractRaw && rawVals) rawVals[path] = val
      for (const key of Object.keys(fieldPaths.serving)) if (fieldPaths.serving[key] === path) srv[key] = val
      for (const key of Object.keys(fieldPaths.neighbor)) if (fieldPaths.neighbor[key] === path) nbr[key] = val
    }
    if (Object.keys(srv).length) servingRows.push({ ts: s.ts, isoTs, lat, lon, ...srv })
    if (Object.keys(nbr).length) neighborRows.push({ ts: s.ts, isoTs, lat, lon, ...nbr })
    if (extractRaw) {
      if (rawSamples.length < rawSampleCap) {
        rawSamples.push({ ts: s.ts, isoTs, lat, lon, values: rawVals as Record<string, string | number | null> })
      } else rawTruncated = true
    }
  }
  if (rawTruncated) {
    warnings.push(`Raw field extraction hit its per-file cell budget (${rawSampleCap} samples) — later raw rows were dropped; curated Serving/Neighbor tabs are unaffected.`)
  }
  servingRows.sort((a, b) => a.ts - b.ts)
  neighborRows.sort((a, b) => a.ts - b.ts)
  rawSamples.sort((a, b) => a.ts - b.ts)
  const rawPaths = extractRaw ? [...allPathsSet].sort() : []
  const rawPathLabels: Record<string, string> = {}
  if (extractRaw) for (const p of rawPaths) { const d = pathToDecl.get(p); if (d?.label) rawPathLabels[p] = d.label }

  // Best-server comparison: for every neighbor sighting that carries the
  // tech's neighbor level field, find the nearest-in-time serving sample
  // that carries the serving level field, and compute the delta.
  const servingLevelSeries = servingRows
    .filter((r) => r[cfg.levelField] != null)
    .map((r) => ({ ts: r.ts, v: r[cfg.levelField] as number, q: r[cfg.qualityField] as number | undefined }))
  function nearestServing(ts: number) {
    if (!servingLevelSeries.length) return null
    let lo = 0
    let hi = servingLevelSeries.length - 1
    if (ts <= servingLevelSeries[0].ts) return servingLevelSeries[0]
    if (ts >= servingLevelSeries[hi].ts) return servingLevelSeries[hi]
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (servingLevelSeries[mid].ts <= ts) lo = mid
      else hi = mid
    }
    const a = servingLevelSeries[lo]
    const b = servingLevelSeries[hi]
    return Math.abs(a.ts - ts) <= Math.abs(b.ts - ts) ? a : b
  }
  const bestServerRows: TrpaBestServerRow[] = []
  const nLevelKey = cfg.neighborLevelField
  for (const r of neighborRows) {
    const nLevel = r[nLevelKey]
    if (nLevel == null) continue
    const near = nearestServing(r.ts)
    if (!near) continue
    const delta = (nLevel as number) - near.v
    bestServerRows.push({
      isoTs: r.isoTs as string,
      neighborId: r[cfg.neighborIdentityField] ?? null,
      neighborLevel: nLevel as number,
      servingLevel: near.v,
      servingQuality: near.q ?? null,
      delta: trpaRound(delta, 2),
      timeGapS: trpaRound(Math.abs(r.ts - near.ts), 3),
      strongerByMargin: delta > 6,
    })
  }

  // Summary
  const levelVals = servingRows.filter((r) => r[cfg.levelField] != null).map((r) => r[cfg.levelField] as number)
  const qualityVals = servingRows.filter((r) => r[cfg.qualityField] != null).map((r) => r[cfg.qualityField] as number)
  const servingIdVals = new Set(servingRows.filter((r) => r[cfg.identityField] != null).map((r) => r[cfg.identityField]))
  const neighborIdVals = new Set(neighborRows.filter((r) => r[cfg.neighborIdentityField] != null).map((r) => r[cfg.neighborIdentityField]))
  const deltas = bestServerRows.map((r) => r.delta as number)
  const within6 = deltas.filter((d) => d > 6).length
  const maxAdv = deltas.length ? Math.max(...deltas) : null

  let meanLat: number | null = null
  let meanLon: number | null = null
  let spanM = 0
  if (gpsPoints.length) {
    meanLat = gpsPoints.reduce((a, p) => a + p.lat, 0) / gpsPoints.length
    meanLon = gpsPoints.reduce((a, p) => a + p.lon, 0) / gpsPoints.length
    const pts = gpsPoints.length > 300 ? gpsPoints.filter((_, i) => i % Math.ceil(gpsPoints.length / 300) === 0) : gpsPoints
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = trpaHaversineM(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon)
        if (d > spanM) spanM = d
      }
    }
  }
  const mobility = mobilityLabel(spanM)
  const gridBinId = meanLat != null && meanLon != null
    ? `${(Math.round(meanLat / 0.0005) * 0.0005).toFixed(5)},${(Math.round(meanLon / 0.0005) * 0.0005).toFixed(5)}`
    : null

  const levelMean = levelVals.length ? levelVals.reduce((a, b) => a + b, 0) / levelVals.length : null
  const siteClassification = classify(within6, neighborIdVals.size, maxAdv, levelMean, cfg.weakThreshold)

  const summary: TrpaSummary = {
    fileName, technology: chosenTech, provider: chosenProvider,
    gpsFixCount: gpsPoints.length, gpsSpanMApprox: trpaRound(spanM, 1), mobility,
    meanLat: trpaRound(meanLat, 7), meanLon: trpaRound(meanLon, 7), gridBinId,
    servingLevelField: cfg.levelField, servingLevelUnit: cfg.levelUnit,
    servingLevelSamples: levelVals.length,
    servingLevelMean: trpaRound(levelMean, 2),
    servingLevelP10: trpaRound(trpaPercentile(levelVals, 0.1), 2),
    servingLevelMin: levelVals.length ? trpaRound(Math.min(...levelVals), 2) : null,
    servingLevelMax: levelVals.length ? trpaRound(Math.max(...levelVals), 2) : null,
    servingQualityField: cfg.qualityField, servingQualityUnit: cfg.qualityUnit,
    servingQualitySamples: qualityVals.length,
    servingQualityMean: trpaRound(qualityVals.length ? qualityVals.reduce((a, b) => a + b, 0) / qualityVals.length : null, 2),
    servingQualityP10: trpaRound(trpaPercentile(qualityVals, 0.1), 2),
    distinctServingCellIds: servingIdVals.size, servingCellIds: [...servingIdVals].join(', '),
    distinctNeighborCellsSeen: neighborIdVals.size,
    neighborSightingsCompared: bestServerRows.length,
    neighborSightingsWithin6dBOrStronger: within6,
    maxNeighborAdvantageDb: maxAdv != null ? trpaRound(maxAdv, 2) : null,
    siteClassification,
    unverifiedTech: chosenTech === '3G',
  }
  if (chosenTech === '3G') warnings.push('3G/WCDMA field paths are unverified against a real file — treat these values as best-effort.')

  if (autoDiscoveredServingKeys.length || autoDiscoveredNeighborKeys.length) {
    warnings.push(`Auto-discovered ${autoDiscoveredServingKeys.length} extra serving field(s) and ${autoDiscoveredNeighborKeys.length} extra neighbor field(s) beyond the curated list.`)
  }

  return {
    tech: chosenTech, provider: chosenProvider, servingRows, neighborRows, bestServerRows, summary,
    servingKeysFound, neighborKeysFound, autoDiscoveredServingKeys, autoDiscoveredNeighborKeys,
    fieldPaths, cfg, rawSamples, rawPaths, rawPathLabels, rawTruncated,
    totalDeclarationsFound: decls.length, events, warnings,
  }
}

// ── Multi-file combination (v1 lines ~10256-10339) ───────────────────────

export interface TrpaTechRollup {
  filesCount: number
  levelField: string
  levelUnit: string
  qualityField: string
  qualityUnit: string
  servingSamples: number
  levelMean: number | null
  levelP10: number | null
  levelMin: number | null
  levelMax: number | null
  qualitySamples: number
  qualityMean: number | null
  qualityP10: number | null
  distinctServingCellIds: number
  servingCellIds: string
  distinctNeighborCellsSeen: number
  neighborSightingsCompared: number
  neighborSightingsWithin6dBOrStronger: number
  maxNeighborAdvantageDb: number | null
  siteClassification: string
  unverifiedTech: boolean
}

export interface TrpaCombined {
  files: TrpaFileResult[]
  techsPresent: TrpaTech[]
  byTech: Record<string, TrpaTechRollup>
  servingRows: (TrpaRow & { sourceFile: string; tech: TrpaTech })[]
  neighborRows: (TrpaRow & { sourceFile: string; tech: TrpaTech })[]
  bestServerRows: (TrpaBestServerRow & { sourceFile: string; tech: TrpaTech })[]
  allServingKeys: string[]
  allNeighborKeys: string[]
  totalGpsFixCount: number
  combinedSpanM: number | null
  combinedMobility: string
  meanLat: number | null
  meanLon: number | null
}

/** Combines N per-file results (a drive-test route/area is typically
 * captured as several separate .trp files) into one multi-file view:
 * every serving/neighbor/best-server row tagged with its source file +
 * tech, plus a per-tech aggregate rollup (pooling ALL files of that tech
 * together — never averaging across different techs, since RSRP/RSSI/
 * RSCP are not comparable numbers). Each file's own self-contained
 * summary is kept untouched in `files`. */
export function trpaCombineResults(perFileResults: TrpaFileResult[]): TrpaCombined {
  const techsPresent = [...new Set(perFileResults.map((r) => r.tech))]
  const allServing: (TrpaRow & { sourceFile: string; tech: TrpaTech })[] = []
  const allNeighbor: (TrpaRow & { sourceFile: string; tech: TrpaTech })[] = []
  const allBestServer: (TrpaBestServerRow & { sourceFile: string; tech: TrpaTech })[] = []
  for (const r of perFileResults) {
    for (const row of r.servingRows) allServing.push({ ...row, sourceFile: r.summary.fileName, tech: r.tech })
    for (const row of r.neighborRows) allNeighbor.push({ ...row, sourceFile: r.summary.fileName, tech: r.tech })
    for (const row of r.bestServerRows) allBestServer.push({ ...row, sourceFile: r.summary.fileName, tech: r.tech })
  }
  const allServingKeys = [...new Set(perFileResults.flatMap((r) => r.servingKeysFound))]
  const allNeighborKeys = [...new Set(perFileResults.flatMap((r) => r.neighborKeysFound))]

  const byTech: Record<string, TrpaTechRollup> = {}
  for (const tech of techsPresent) {
    const cfg = (perFileResults.find((r) => r.tech === tech) as TrpaFileResult).cfg
    const servingOfTech = allServing.filter((r) => r.tech === tech)
    const neighborOfTech = allNeighbor.filter((r) => r.tech === tech)
    const bestServerOfTech = allBestServer.filter((r) => r.tech === tech)
    const levelVals = servingOfTech.filter((r) => r[cfg.levelField] != null).map((r) => r[cfg.levelField] as number)
    const qualityVals = servingOfTech.filter((r) => r[cfg.qualityField] != null).map((r) => r[cfg.qualityField] as number)
    const servingIdVals = new Set(servingOfTech.filter((r) => r[cfg.identityField] != null).map((r) => r[cfg.identityField]))
    const neighborIdVals = new Set(neighborOfTech.filter((r) => r[cfg.neighborIdentityField] != null).map((r) => r[cfg.neighborIdentityField]))
    const deltas = bestServerOfTech.map((r) => r.delta as number)
    const within6 = deltas.filter((d) => d > 6).length
    const maxAdv = deltas.length ? Math.max(...deltas) : null
    const levelMean = levelVals.length ? levelVals.reduce((a, b) => a + b, 0) / levelVals.length : null
    const siteClassification = classify(within6, neighborIdVals.size, maxAdv, levelMean, cfg.weakThreshold)
    byTech[tech] = {
      filesCount: perFileResults.filter((r) => r.tech === tech).length,
      levelField: cfg.levelField, levelUnit: cfg.levelUnit, qualityField: cfg.qualityField, qualityUnit: cfg.qualityUnit,
      servingSamples: levelVals.length,
      levelMean: trpaRound(levelMean, 2),
      levelP10: trpaRound(trpaPercentile(levelVals, 0.1), 2),
      levelMin: levelVals.length ? trpaRound(Math.min(...levelVals), 2) : null,
      levelMax: levelVals.length ? trpaRound(Math.max(...levelVals), 2) : null,
      qualitySamples: qualityVals.length,
      qualityMean: trpaRound(qualityVals.length ? qualityVals.reduce((a, b) => a + b, 0) / qualityVals.length : null, 2),
      qualityP10: trpaRound(trpaPercentile(qualityVals, 0.1), 2),
      distinctServingCellIds: servingIdVals.size, servingCellIds: [...servingIdVals].join(', '),
      distinctNeighborCellsSeen: neighborIdVals.size,
      neighborSightingsCompared: bestServerOfTech.length,
      neighborSightingsWithin6dBOrStronger: within6,
      maxNeighborAdvantageDb: maxAdv != null ? trpaRound(maxAdv, 2) : null,
      siteClassification,
      unverifiedTech: tech === '3G',
    }
  }

  // Combined GPS span across every point from every file (sampled the
  // same way the per-file span calc is, to keep the O(n^2) pairwise scan
  // cheap).
  const allPts: { lat: number; lon: number }[] = []
  for (const row of allServing) if (row.lat != null && row.lon != null) allPts.push({ lat: row.lat, lon: row.lon })
  for (const row of allNeighbor) if (row.lat != null && row.lon != null) allPts.push({ lat: row.lat, lon: row.lon })
  let spanM = 0
  let meanLat: number | null = null
  let meanLon: number | null = null
  if (allPts.length) {
    meanLat = allPts.reduce((a, p) => a + p.lat, 0) / allPts.length
    meanLon = allPts.reduce((a, p) => a + p.lon, 0) / allPts.length
    const pts = allPts.length > 300 ? allPts.filter((_, i) => i % Math.ceil(allPts.length / 300) === 0) : allPts
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = trpaHaversineM(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon)
        if (d > spanM) spanM = d
      }
    }
  }
  const combinedMobility = mobilityLabel(spanM)

  return {
    files: perFileResults, techsPresent, byTech,
    servingRows: allServing, neighborRows: allNeighbor, bestServerRows: allBestServer,
    allServingKeys, allNeighborKeys,
    totalGpsFixCount: perFileResults.reduce((a, r) => a + r.summary.gpsFixCount, 0),
    combinedSpanM: trpaRound(spanM, 1), combinedMobility,
    meanLat: trpaRound(meanLat, 7), meanLon: trpaRound(meanLon, 7),
  }
}

// ── Call/download KPI summaries (2026-08-15 follow-up) ───────────────────
// The per-event table from the initial "detect and store events" pass
// (see TrpaEventRow above) was correct but too raw for what the user
// actually wanted: "i need to store only the data like total no. of call
// attempted, total call success, total call drop, total call rejected,
// percentage... for 4g dl, total no. of download attempted, total
// download succeed, total download fail... for 4g fallback, total no. of
// call attempted, total no. of fallback, success, fail". This section
// aggregates the already-decoded TrpaEventRow[] into exactly those
// counts — no new binary decoding, pure aggregation over events that
// were already verified correct against 3 real files.
//
// Deliberately does NOT classify outcomes using the numeric `Cause`/
// `EndType`/`CallEstablished` codes on Call.CallEndEvent — no authoritative
// public TEMS documentation for their exact meaning could be found (see
// this module's other enum-uncertainty notes), and guessing at them here
// would risk silently wrong numbers in what's meant to be a real
// operational KPI figure. Every classification below instead uses
// STRUCTURAL evidence — which named TEMS events did or didn't fire for a
// given call/download attempt — which is unambiguous and requires no
// external documentation to defend:
//   - "attempted"  = a Call.CallAttemptEvent (or Call.CallInitiationEvent
//                    if that's absent) exists for this call index.
//   - "setupSuccess" = that call index also has a Call.CallSetupEvent —
//                    TEMS's own explicit "the call was set up" marker.
//                    This is the standard telecom Call Setup Success Rate
//                    (CSSR) definition.
//   - "rejected"   = attempted but never reached CallSetupEvent.
//   - "completed"  = reached CallSetupEvent AND has a Call.CallEndEvent —
//                    a clean, TEMS-logged end.
//   - "dropped"    = reached CallSetupEvent but NEVER got a CallEndEvent
//                    — the standard telecom Call Drop definition (a
//                    connected call that ended abnormally). Confirmed
//                    against real data: sample file `ff023691.trp`'s call
//                    reached CallSetupEvent but its provider never even
//                    DECLARES a CallEndEvent namespace at all — and that
//                    same file logs a `General.ServiceProvider.
//                    HealthChangedEvent` ("Device restart due to
//                    DiagnosticMalfunction") right where a normal call
//                    would still be running — real, structural evidence
//                    of an abnormal drop, not a guess.
//   - "fallbackDetected" = Call.CallEndEvent.SrvccHandoverOccurredDuringCall
//                    decoded as 1 — TEMS's own literal, self-describing
//                    SRVCC/fallback marker (the field NAME states its own
//                    meaning; no external enum table needed). Real
//                    limitation, stated plainly rather than hidden: this
//                    field only ever appears ON a CallEndEvent, so a
//                    dropped call's fallback status is structurally
//                    unknowable from this marker — `fallbackDetected` can
//                    only ever be true for a `completed` call. None of
//                    the 3 real sample files had this flag set true (the
//                    field is declared but its value never fired in any
//                    of those 3 specific calls) — so real fallback counts
//                    will read 0 until a capture where CSFB actually
//                    triggers mid-call is uploaded.
//   - Downloads: "attempted" = count of Data.Ftp.Download.BeginEvent (or
//                    EndEvent count if Begin is somehow missing);
//                    "succeeded" = the paired EndEvent reports a real
//                    positive FileSize or ServiceThroughputAverage (i.e.
//                    TEMS actually recorded completion data) — again
//                    structural, not a guessed status-code meaning.
//                    Confirmed against the real DL file: its first
//                    download cycle's EndEvent has FileSize=10534912 and
//                    ServiceThroughputAverage=4391.4 (succeeded); its
//                    second cycle's EndEvent has neither (File decoded as
//                    empty bytes) — failed.

export interface DtCallSummary {
  attempted: number
  setupSuccess: number
  rejected: number
  completed: number
  dropped: number
  fallbackDetected: number
  setupSuccessRatePct: number | null
  rejectRatePct: number | null
  dropRatePct: number | null
}

export interface DtDownloadSummary {
  attempted: number
  succeeded: number
  failed: number
  successRatePct: number | null
}

function trpaFieldEndingWith(fields: Record<string, string | number>, suffix: string): string | number | undefined {
  for (const [k, v] of Object.entries(fields)) if (k.endsWith(suffix)) return v
  return undefined
}

function trpaCallIndexOf(e: TrpaEventRow): number | null {
  const v = trpaFieldEndingWith(e.fields, '.CallIndex')
  return typeof v === 'number' ? v : null
}

function trpaPct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null
}

/** Aggregates every Call.* event in `events` into the call KPI summary
 * described above, grouped by each call's own CallIndex field (every
 * Call.* event type carries its own copy of this field — confirmed
 * against all 3 real sample files). Returns null when `events` has no
 * Call.* events at all (a pure data/DL-only capture), matching the
 * "only build a section for what the log actually contains" convention
 * the rest of this feature already follows. */
export function trpaSummarizeCallEvents(events: TrpaEventRow[]): DtCallSummary | null {
  const callEvents = events.filter((e) => e.type.startsWith('Call.'))
  if (!callEvents.length) return null
  const byIndex = new Map<number, TrpaEventRow[]>()
  for (const e of callEvents) {
    const idx = trpaCallIndexOf(e)
    if (idx === null) continue
    const arr = byIndex.get(idx) ?? []
    arr.push(e)
    byIndex.set(idx, arr)
  }
  let attempted = 0
  let setupSuccess = 0
  let completed = 0
  let dropped = 0
  let fallbackDetected = 0
  for (const group of byIndex.values()) {
    const hasAttempt = group.some((e) => e.type === 'Call.CallAttemptEvent') || group.some((e) => e.type === 'Call.CallInitiationEvent')
    const hasSetup = group.some((e) => e.type === 'Call.CallSetupEvent')
    const endEvt = group.find((e) => e.type === 'Call.CallEndEvent')
    if (hasAttempt) attempted++
    if (hasSetup) setupSuccess++
    if (hasSetup && endEvt) completed++
    if (hasSetup && !endEvt) dropped++
    if (endEvt && trpaFieldEndingWith(endEvt.fields, '.SrvccHandoverOccurredDuringCall') === 1) fallbackDetected++
  }
  const rejected = Math.max(0, attempted - setupSuccess)
  return {
    attempted, setupSuccess, rejected, completed, dropped, fallbackDetected,
    setupSuccessRatePct: trpaPct(setupSuccess, attempted),
    rejectRatePct: trpaPct(rejected, attempted),
    dropRatePct: trpaPct(dropped, setupSuccess),
  }
}

/** Aggregates every Data.Ftp.Download.* Begin/End event pair in `events`
 * into the download KPI summary described above. Returns null when there
 * are no download Begin/End events at all (a voice-only capture). */
export function trpaSummarizeDownloadEvents(events: TrpaEventRow[]): DtDownloadSummary | null {
  const begins = events.filter((e) => e.type === 'Data.Ftp.Download.BeginEvent')
  const ends = events.filter((e) => e.type === 'Data.Ftp.Download.EndEvent')
  if (!begins.length && !ends.length) return null
  const attempted = Math.max(begins.length, ends.length)
  const succeeded = ends.filter((e) => {
    const fileSize = trpaFieldEndingWith(e.fields, '.FileSize')
    const throughput = trpaFieldEndingWith(e.fields, '.ServiceThroughputAverage')
    return (typeof fileSize === 'number' && fileSize > 0) || (typeof throughput === 'number' && throughput > 0)
  }).length
  const failed = Math.max(0, attempted - succeeded)
  return { attempted, succeeded, failed, successRatePct: trpaPct(succeeded, attempted) }
}
