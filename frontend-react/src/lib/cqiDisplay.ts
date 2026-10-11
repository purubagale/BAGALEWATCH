// Shared wording for the CQI cells on the Collections and Area Sample
// tables (2026-10-09). The numbers come from the server (core/cqi.py); this
// only decides how each source is labelled, so an estimate is never shown
// as if the phone had reported it.
import type { SampleCqiFields } from '../api/types'

export const CQI_COLUMN_HINT =
  'Reported by the phone when available. "(est.)" is estimated from SINR; ' +
  '"(est. RSRQ)" is a rougher estimate from RSRQ, used when the sample has no SINR.'

export const CQI_MODULATION_HINT =
  'Modulation and spectral efficiency for this CQI, from 3GPP TS 36.213 Table 7.2.3-1 (LTE).'

export function cqiLabel(s: SampleCqiFields): string {
  if (s.cqi_value == null) return '—'
  if (s.cqi_source === 'sinr') return `${s.cqi_value} (est.)`
  if (s.cqi_source === 'rsrq') return `${s.cqi_value} (est. RSRQ)`
  return String(s.cqi_value)
}

export function cqiModulationLabel(s: SampleCqiFields): string {
  if (!s.modulation || s.spectral_efficiency == null) return '—'
  return `${s.modulation} · ${s.spectral_efficiency.toFixed(2)} bps/Hz`
}
