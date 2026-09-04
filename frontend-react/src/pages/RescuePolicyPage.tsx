import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useRescueConsentPolicy, useSetRescueConsentPolicy } from '../api/queries'

// Rescue Policy (2026-09-03) -- the admin-facing half of core/rescue.py's
// RescueConsentPolicyView, which existed on the backend since 2026-09-02
// with no page anywhere calling it. Reachable only via the Rescue Policy
// MenuItem (access='superadmin', migration 0049_rescue_menu_items.py),
// so no separate client-side role check is needed here -- same reasoning
// ApiAccessPage.tsx documents for its own access='superadmin' gating.
//
// Declaring 'optional' here does NOT let a rescue operator find a number
// that was never enrolled -- see RescueConsentPolicy's own docstring: it
// only relaxes the consent flag on an EXISTING enrollment record, it can
// never invent one. This page says that plainly so a superadmin doesn't
// mistake this for "unlock lookup for anyone."

// Converts an ISO string (or null) to the value a <input type="datetime-local">
// expects (local time, no seconds/timezone) -- and back. Kept local to this
// page since nothing else in the app currently needs a datetime-local field.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export default function RescuePolicyPage() {
  const { data: policy, isLoading, error } = useRescueConsentPolicy()
  const setPolicy = useSetRescueConsentPolicy()

  const [mode, setMode] = useState<'mandatory' | 'optional'>('mandatory')
  const [reason, setReason] = useState('')
  const [activeUntil, setActiveUntil] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!policy) return
    setMode(policy.mode)
    setReason(policy.reason)
    setActiveUntil(isoToLocalInput(policy.active_until))
  }, [policy])

  if (isLoading) return <div className="page-status">Loading rescue policy…</div>
  if (error) return <div className="page-status page-status-error">Could not load the rescue policy.</div>
  if (!policy) return null

  async function handleSave() {
    setSaveError(null)
    setSaved(false)
    try {
      await setPolicy.mutateAsync({
        mode,
        reason,
        active_until: mode === 'optional' ? localInputToIso(activeUntil) : null,
      })
      setSaved(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the rescue policy.'))
    }
  }

  return (
    <div className="admin-page" style={{ maxWidth: 640 }}>
      <h1>Rescue Policy</h1>
      <p className="muted">
        Controls how strictly Rescue Lookup enforces a subscriber's own opt-in consent. Every change here is
        permanently logged with your account, the reason given, and when it took effect.
      </p>
      <p className="muted">
        <strong>What "Optional" does NOT do:</strong> it never lets a lookup find a phone number that was never
        registered for rescue location through this app. It only relaxes the consent flag on numbers that
        already enrolled -- so someone who withdrew consent (or never explicitly withdrew, under a real
        carrier/government integration with no in-app consent screen at all) can still be found while this is
        active.
      </p>

      <div className="page-status" style={{ marginBottom: 16 }}>
        Currently: <strong>{policy.is_optional_active ? 'Optional override ACTIVE' : 'Mandatory (default)'}</strong>
        {policy.mode === 'optional' && !policy.is_optional_active && ' — declared optional, but expired'}
      </div>

      {saveError && <div className="form-error">{saveError}</div>}
      {saved && <div className="form-success">Saved.</div>}

      <div className="edit-grid" style={{ gridTemplateColumns: '1fr', gap: 12 }}>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'mandatory' | 'optional')}>
            <option value="mandatory">Mandatory (default) — only consenting subscribers can be found</option>
            <option value="optional">Optional (emergency override) — any enrolled number can be found</option>
          </select>
        </label>
        <label>
          Reason
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. 2026 flood response, NDRRMA case #..."
          />
        </label>
        {mode === 'optional' && (
          <label>
            Active until (auto-reverts to mandatory after this time)
            <input
              type="datetime-local"
              value={activeUntil}
              onChange={(e) => setActiveUntil(e.target.value)}
            />
          </label>
        )}
      </div>

      <div className="admin-page-actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" onClick={handleSave} disabled={setPolicy.isPending}>
          {setPolicy.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
