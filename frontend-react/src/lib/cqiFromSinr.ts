// CQI derivation from SINR (2026-09-29) — user-confirmed domain fact:
// "there is no direct cqi values stored in .trp file. it is post
// processed value derived using sinr or any other parameter." Verified
// directly against two real 4G DL .trp files this session (declarations.cdf
// decompressed and searched by hand): both declare 345-369 real LTE
// fields, including a genuine `Radio.Lte.ServingCell[8].RsSinr`, but the
// ONLY Cqi-named field in either file is `Radio.Lte.CqiReportMode` — a
// config ENUM ("LTE CQI Report Mode"), not a measured value. Every
// previous cqi field-name candidate in trpAnalysis.ts (CqiCodeword0Average,
// WidebandCqi, etc.) was chasing something that genuinely does not exist
// in this device/TEMS configuration's output — not a naming bug.
//
// This maps a measured SINR (dB) to the CQI index (0-15) a UE would be
// expected to report for it, using the SINR-to-CQI threshold table from
// Brueninghaus et al., "Link Performance Models for System Level
// Simulations of Broadband Radio Access Systems," IEEE PIMRC 2005 — the
// most widely reused reference table for this exact mapping across LTE
// link-level simulators (e.g. ns-3's LTE module). It targets ~10% BLER
// per CQI/MCS combination.
//
// IMPORTANT: this is a well-established APPROXIMATION, not the literal
// algorithm a real UE chipset uses (that also depends on receiver
// implementation, channel estimation, and antenna configuration, none of
// which this file has visibility into) — every caller MUST present this
// as a derived/estimated value, never as a direct measurement. See
// dtBands.ts's `note` field on the 'cqi' DtMetric entry for where that
// disclaimer is actually shown to the user.
const CQI_SINR_THRESHOLDS_DB: [cqi: number, minSinrDb: number][] = [
  [1, -6.7], [2, -4.7], [3, -2.3], [4, 0.2], [5, 2.4], [6, 4.3],
  [7, 5.9], [8, 8.1], [9, 10.3], [10, 11.7], [11, 14.1], [12, 16.3],
  [13, 18.7], [14, 21.0], [15, 22.7],
]

/** Returns the CQI index (0-15) for a measured SINR in dB — 0 means
 * "out of range" (below the lowest usable threshold), matching 3GPP's
 * own CQI=0 reporting convention. */
export function deriveCqiFromSinr(sinrDb: number): number {
  let cqi = 0
  for (const [c, minSinr] of CQI_SINR_THRESHOLDS_DB) {
    if (sinrDb >= minSinr) cqi = c
    else break
  }
  return cqi
}
