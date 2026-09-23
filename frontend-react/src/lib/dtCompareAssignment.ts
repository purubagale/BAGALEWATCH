// Before/after ordering for the Delta compare view (2026-09-12) — given
// exactly two sessions selected on DtSessionHistoryPage, decides which
// one is "before" (compare endpoint's `a`) and which is "after" (`b`).
import type { DtSessionListItem, OptimizationActivityRole } from '../api/types'

const ROLE_ORDER: Record<OptimizationActivityRole, number> = {
  baseline: 0,
  after_change: 1,
  re_verify: 2,
}

export type DtCompareOrderReason = 'activity-role' | 'date' | 'upload-order'

export interface DtCompareOrder {
  before: DtSessionListItem
  after: DtSessionListItem
  reason: DtCompareOrderReason
}

export const DT_COMPARE_ORDER_REASON_LABELS: Record<DtCompareOrderReason, string> = {
  'activity-role': 'by Optimization Activity role',
  date: 'by session date (older = before)',
  'upload-order': 'by upload order (no date on one/both sessions)',
}

/**
 * Preferred signal: a shared Optimization Activity. If both sessions are
 * linked to the SAME activity, its role ordering (baseline < after_change
 * < re_verify — the real before/after-change/re-verify workflow
 * OptimizationActivitySession models) decides unambiguously, regardless
 * of upload order or which one happens to have a later `date`.
 *
 * Falls back to `date` (older session = before) when there's no shared
 * activity between the two, or a shared activity exists but both
 * sessions carry the SAME role on it (a role can't order two same-role
 * sessions against each other).
 *
 * Final fallback: `saved_at` (upload order) for the rare case where
 * neither session has a `date` set at all. The caller (DtSessionHistoryPage)
 * still shows a swap button regardless of which reason won, since any of
 * these heuristics can guess wrong for a given pair.
 */
export function assignDtCompareOrder(x: DtSessionListItem, y: DtSessionListItem): DtCompareOrder {
  const sharedActivityId = x.activities.map((a) => a.id).find((id) => y.activities.some((a2) => a2.id === id))
  if (sharedActivityId != null) {
    const xRole = x.activities.find((a) => a.id === sharedActivityId)!.role
    const yRole = y.activities.find((a) => a.id === sharedActivityId)!.role
    if (ROLE_ORDER[xRole] !== ROLE_ORDER[yRole]) {
      return ROLE_ORDER[xRole] < ROLE_ORDER[yRole]
        ? { before: x, after: y, reason: 'activity-role' }
        : { before: y, after: x, reason: 'activity-role' }
    }
  }
  if (x.date && y.date && x.date !== y.date) {
    return x.date < y.date ? { before: x, after: y, reason: 'date' } : { before: y, after: x, reason: 'date' }
  }
  return x.saved_at <= y.saved_at
    ? { before: x, after: y, reason: 'upload-order' }
    : { before: y, after: x, reason: 'upload-order' }
}
