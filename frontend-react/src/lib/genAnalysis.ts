// Huawei GENEX Probe drive-test log (.gen) decoder (2026-10-09).
//
// .gen has no public spec. The layout below was worked out from two real
// 2G idle-mode logs (one NTC drive in Pokhara, 2026-05-29) by matching
// values across messages, and checked against them: every record boundary
// found by walking the file equals the boundary listed in the companion
// .des index, so the .des file is not needed.
//
// Only what those samples proved is decoded: the GPS track, and the 2G
// serving cell (BCCH ARFCN, BSIC, RxLev, C1, C2, and CI/LAC from the cell
// identity message). 3G/4G logs, dedicated-mode fields (RxQual) and call
// events are NOT decoded -- no sample of those has been seen. A file with
// none of the known 2G messages is rejected with a clear error instead of
// being guessed at.
//
// File layout:
//   0x000  "PHU LOG"
//   0x044  start time, Windows SYSTEMTIME (8 x u16 LE), device local time
//   0x195  first record; records are back to back to the end of the file
// Record:  u8 kind | u32 ms since start | u32 payload length | u8 sub | payload
//   sub == 1                 GPS: f64 lng @9, f64 lat @18, f64 altitude @27
//   kind == 1, 00 02 ..      modem message: u32 id @4, body @49
// Modem message 0x2238A02E, body u16 @2 = variant:
//   0  serving report: u16 arfcn @4, u16 bsic @8, i16 RxLev dBm @14,
//      i16 C1 @32, i16 C2 @34
//   1  cell identity:  u16 arfcn @12, u16 bsic @14, u16 CI @18, u16 MCC @20,
//      u16 MNC @24, u16 LAC @28
import type { TrpaRow } from './trpAnalysis'

const FIRST_RECORD_OFFSET = 0x195
const START_TIME_OFFSET = 0x44
const MSG_GSM_SERVING = 0x2238a02e
// The log's clock is the logging PC's local time. Nepal has one time zone
// and no daylight saving, so local time is converted to UTC with a fixed
// offset.
const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000
// A serving report is placed at the nearest GPS fix (one per second in the
// samples) only when that fix is this close in time.
const GPS_MATCH_WINDOW_MS = 1500
// RxLev outside this range is a placeholder, not a reading (-500 and
// -32768 both occur in the samples).
const RXLEV_MIN_DBM = -120
const RXLEV_MAX_DBM = -30

export interface GenFileResult {
  tech: '2G'
  servingRows: TrpaRow[]
  gpsFixCount: number
  /** Serving reports dropped for a placeholder RxLev or no nearby GPS fix. */
  droppedReports: number
}

export function isGenFile(bytes: Uint8Array): boolean {
  const magic = 'PHU LOG'
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false
  return true
}

interface CellIdentity {
  ci: number
  lac: number
  mcc: number
  mnc: number
}

export function genAnalyzeFile(buffer: ArrayBuffer, fileName: string): GenFileResult {
  const bytes = new Uint8Array(buffer)
  if (!isGenFile(bytes)) throw new Error('Not a GENEX Probe log (missing "PHU LOG" header)')
  if (/\.des$/i.test(fileName)) throw new Error('This is the index file. Upload the .gen file instead')
  const dv = new DataView(buffer)
  const size = bytes.length
  if (size < FIRST_RECORD_OFFSET + 10) throw new Error('GENEX Probe log is too short to hold any record')

  const st = (i: number) => dv.getUint16(START_TIME_OFFSET + 2 * i, true)
  // SYSTEMTIME: year, month, day of week, day, hour, minute, second, ms.
  const startUtcMs = Date.UTC(st(0), st(1) - 1, st(3), st(4), st(5), st(6), st(7)) - NPT_OFFSET_MS
  if (!Number.isFinite(startUtcMs) || st(0) < 2000 || st(0) > 2100) throw new Error('GENEX Probe log has no valid start time')

  const gpsT: number[] = []
  const gpsLat: number[] = []
  const gpsLng: number[] = []
  const reports: { t: number; arfcn: number; bsic: number; rxlev: number; c1: number; c2: number }[] = []
  const identities = new Map<string, CellIdentity>()

  let q = FIRST_RECORD_OFFSET
  while (q + 10 <= size) {
    const kind = bytes[q]
    const t = dv.getUint32(q + 1, true)
    const len = dv.getUint32(q + 5, true)
    const sub = bytes[q + 9]
    const p = q + 10
    if (p + len > size) break // truncated final record
    if (sub === 1 && len >= 35) {
      const lng = dv.getFloat64(p + 9, true)
      const lat = dv.getFloat64(p + 18, true)
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
        gpsT.push(t)
        gpsLat.push(lat)
        gpsLng.push(lng)
      }
    } else if (kind === 1 && len >= 49 + 36 && bytes[p] === 0 && bytes[p + 1] === 2 && dv.getUint32(p + 4, true) === MSG_GSM_SERVING) {
      const b = p + 49
      const variant = dv.getUint16(b + 2, true)
      if (variant === 0) {
        reports.push({
          t,
          arfcn: dv.getUint16(b + 4, true),
          bsic: dv.getUint16(b + 8, true),
          rxlev: dv.getInt16(b + 14, true),
          c1: dv.getInt16(b + 32, true),
          c2: dv.getInt16(b + 34, true),
        })
      } else if (variant === 1) {
        identities.set(`${dv.getUint16(b + 12, true)}-${dv.getUint16(b + 14, true)}`, {
          ci: dv.getUint16(b + 18, true),
          mcc: dv.getUint16(b + 20, true),
          mnc: dv.getUint16(b + 24, true),
          lac: dv.getUint16(b + 28, true),
        })
      }
    }
    q = p + len
  }

  if (!reports.length) {
    throw new Error('No 2G serving-cell reports found. Only 2G logs from GENEX Probe are supported so far')
  }

  const servingRows: TrpaRow[] = []
  let dropped = 0
  let g = 0
  for (const r of reports) {
    if (r.rxlev < RXLEV_MIN_DBM || r.rxlev > RXLEV_MAX_DBM) {
      dropped++
      continue
    }
    // Reports and fixes are both in time order, so the nearest fix only moves forward.
    while (g + 1 < gpsT.length && Math.abs(gpsT[g + 1] - r.t) <= Math.abs(gpsT[g] - r.t)) g++
    if (!gpsT.length || Math.abs(gpsT[g] - r.t) > GPS_MATCH_WINDOW_MS) {
      dropped++
      continue
    }
    const ms = startUtcMs + r.t
    const id = identities.get(`${r.arfcn}-${r.bsic}`)
    servingRows.push({
      ts: ms / 1000,
      isoTs: new Date(ms).toISOString(),
      lat: gpsLat[g],
      lon: gpsLng[g],
      rssiFull: r.rxlev,
      bcch: r.arfcn,
      bsic: r.bsic,
      c1: r.c1,
      c2: r.c2,
      cellId: id?.ci ?? null,
      lac: id?.lac ?? null,
    })
  }
  return { tech: '2G', servingRows, gpsFixCount: gpsT.length, droppedReports: dropped }
}
