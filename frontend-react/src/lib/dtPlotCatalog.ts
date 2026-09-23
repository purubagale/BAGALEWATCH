// DT Plot Catalog (2026-09-23, plan Step 7) — turns the user's own
// 2.4.1-2.4.38 drive-test report checklist into a living, in-app
// reference instead of something only tracked in conversation. A plain
// static array, not a DB table -- this is a fixed reference list, same
// convention as dtBands.ts's ALL_METRICS or SiteDetailPage.tsx's
// KPI_FIELDS. Each entry maps one checklist row to whether this app can
// already produce it and, if not, exactly what real sample file is
// needed to build it -- see the "Working from real sample files" section
// of the drive-test plotting plan for the process that flips a row from
// 'needs-sample' to 'available' once that sample arrives.

export type DtPlotPhase = 'pre' | 'post'
export type DtPlotStatus = 'available' | 'needs-sample'

export interface DtPlotCatalogEntry {
  id: string
  title: string
  phase: DtPlotPhase
  // Which view in this app already produces this plot, when status is
  // 'available' -- 'explore' means DtExploreTab's tabs (RSRP/RSRQ/SINR/
  // CQI/DL Throughput/PCI/Band), 'compare' means the Pre/Post delta
  // report (DtCompareReportView.tsx via DT Session History's Compare
  // flow).
  view: 'explore' | 'compare' | null
  status: DtPlotStatus
  // Only set for a 'needs-sample' row -- exactly what's still missing,
  // written so a real sample file can be matched against it directly.
  note?: string
}

export const DT_PLOT_CATALOG: DtPlotCatalogEntry[] = [
  { id: '2.4.1', title: 'PCI Plot (PS DL-Best server)', phase: 'pre', view: 'explore', status: 'available' },
  { id: '2.4.2', title: 'PCI Plot (PS DL-Best server)', phase: 'post', view: 'explore', status: 'available' },
  { id: '2.4.3', title: 'Band (Mode: DL at FREE Mode)', phase: 'pre', view: 'explore', status: 'available' },
  { id: '2.4.4', title: 'Band (Mode: DL at FREE Mode)', phase: 'post', view: 'explore', status: 'available' },
  { id: '2.4.5', title: 'Band (Mode: Idle at FREE Mode)', phase: 'pre', view: 'explore', status: 'available' },
  { id: '2.4.6', title: 'Band (Mode: Idle at FREE Mode)', phase: 'post', view: 'explore', status: 'available' },
  { id: '2.4.7', title: 'RSRP (Mode: Idle at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.8', title: 'RSRP (Mode: Idle at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.9', title: 'Band (Mode: Idle at B3 Lock mode)', phase: 'pre', view: 'explore', status: 'available' },
  { id: '2.4.10', title: 'Band (Mode: Idle at B3 Lock mode)', phase: 'post', view: 'explore', status: 'available' },
  { id: '2.4.11', title: 'RSRP (Mode: Idle at B3 Lock mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.12', title: 'RSRP (Mode: Idle at B3 Lock mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.13', title: 'Band (Mode: Idle at B20 Lock mode)', phase: 'pre', view: 'explore', status: 'available' },
  { id: '2.4.14', title: 'Band (Mode: Idle at B20 Lock mode)', phase: 'post', view: 'explore', status: 'available' },
  { id: '2.4.15', title: 'RSRP (Mode: Idle at B20 Lock mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.16', title: 'RSRP (Mode: Idle at B20 Lock mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.17', title: 'RSRP (Mode: DL at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.18', title: 'RSRP (Mode: DL at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.19', title: 'SINR (Mode: DL at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.20', title: 'SINR (Mode: DL at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.21', title: 'CQI (Mode: DL at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.22', title: 'CQI (Mode: DL at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.23', title: 'RSRQ (Mode: DL at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.24', title: 'RSRQ (Mode: DL at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  { id: '2.4.25', title: 'Download Plot from PDCP (Mode: DL at FREE Mode)', phase: 'pre', view: 'compare', status: 'available' },
  { id: '2.4.26', title: 'Download Plot from PDCP (Mode: DL at FREE Mode)', phase: 'post', view: 'compare', status: 'available' },
  {
    id: '2.4.27', title: 'Upload Plot from PDCP (Mode: UL at FREE Mode)', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'No uplink throughput field is parsed anywhere in trpAnalysis.ts today (only pdschThroughput, DL) -- needs a real 4G .trp with a genuine UL throughput field present, to find and verify its Radio.Lte.* path against.',
  },
  {
    id: '2.4.28', title: 'Upload Plot from PDCP (Mode: UL at FREE Mode)', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.27 above.',
  },
  {
    id: '2.4.29', title: 'PS Setup Success Rate and PS Drop rate plot', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'Partial: attempted/succeeded/failed counts are already captured per-session in meta.downloadSummary at upload time (trpaSummarizeDownloadEvents, shown by DtCallDownloadSummary.tsx during review) -- not yet surfaced as its own Pre/Post comparison view. Needs a decision on whether that\'s a real "drop rate" or just a download-attempt outcome tally before building the plot.',
  },
  {
    id: '2.4.30', title: 'PS Setup Success Rate and PS Drop rate plot', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.29 above.',
  },
  {
    id: '2.4.31', title: 'HOSR-Intra-Freq With Tech Mode From FREE MODE DL', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'Only a coverage-overlap heuristic exists ("handover candidate present" -- a neighbor stronger than serving), not real handover attempt/success event counting. Needs a real 4G .trp with genuine handover events to decode and verify a HOSR field mapping against.',
  },
  {
    id: '2.4.32', title: 'HOSR-Intra-Freq With Tech Mode From FREE MODE DL', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.31 above.',
  },
  {
    id: '2.4.33', title: 'HOSR-Intra-Freq with Band From FREE MODE DL', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.31 above, plus needs the per-handover target band recorded, not just success/failure.',
  },
  {
    id: '2.4.34', title: 'HOSR-Intra-Freq with Band From FREE MODE DL', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.33 above.',
  },
  {
    id: '2.4.35', title: 'VoLTE MOS', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'No MOS field is parsed anywhere in trpAnalysis.ts today -- this is a new TEMS field family from scratch. Needs a real VoLTE-call .trp capture to find and verify its MOS field path against.',
  },
  {
    id: '2.4.36', title: 'VoLTE MOS', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.35 above.',
  },
  {
    id: '2.4.37', title: 'ViLTE AMR Codec Plot', phase: 'pre', view: null,
    status: 'needs-sample',
    note: 'No codec field is parsed anywhere in trpAnalysis.ts today. Needs a real ViLTE-call .trp capture to find and verify its codec field path against.',
  },
  {
    id: '2.4.38', title: 'ViLTE AMR Codec Plot', phase: 'post', view: null,
    status: 'needs-sample',
    note: 'Same gap as 2.4.37 above.',
  },
]
