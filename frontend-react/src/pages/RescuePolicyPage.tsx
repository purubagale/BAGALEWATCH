import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useDeclareEmergency, useEmergencyStatus, useEndEmergency } from '../api/queries'

// Rescue Policy / Emergency Switch (2026-09-03, rewritten 2026-10-07) --
// the admin-facing control over core/emergency.py's EmergencyDeclareView/
// EmergencyEndView. Reachable only via the Rescue Policy MenuItem
// (access='superadmin', migration 0049_rescue_menu_items.py), so no
// separate client-side role check is needed here -- same reasoning
// ApiAccessPage.tsx documents for its own access='superadmin' gating.
//
// This used to drive core/rescue.py's RescueConsentPolicyView
// ('mandatory'/'optional' mode on RescueConsentPolicy), which was
// retired to 410 Gone on 2026-10-05 in favor of the single Emergency
// Switch below -- rescue search is off by default, and declaring an
// emergency is the only way to turn it on, for a capped number of days.
// Declaring an emergency does NOT let a rescue operator find a number
// that was never enrolled -- see EmergencyDeclaration's own docstring:
// it only relaxes the consent flag on an EXISTING enrollment record, it
// can never invent one. This page says that plainly so a superadmin
// doesn't mistake this for "unlock lookup for anyone."
export function EmergencySwitchPanel() {
  const { data: status, isLoading, error } = useEmergencyStatus()
  const declare = useDeclareEmergency()
  const end = useEndEmergency()

  const [reason, setReason] = useState('')
  const [days, setDays] = useState('7')
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [seeded, setSeeded] = useState(false)

  // Seed the reason field from the active emergency exactly once it
  // arrives, so "Update emergency" starts from the current reason
  // instead of blank -- an effect (not render-phase setState) because
  // useEmergencyStatus() resolves asynchronously.
  useEffect(() => {
    if (status?.active && !seeded) {
      setReason(status.reason ?? '')
      setSeeded(true)
    }
  }, [status, seeded])

  if (isLoading) return <p className="muted">Loading emergency status…</p>
  if (error) return <p className="form-error form-error-inline">Could not load emergency status.</p>
  if (!status) return null

  async function handleDeclare() {
    setFormError(null)
    setNotice(null)
    const trimmed = reason.trim()
    if (!trimmed) {
      setFormError('Reason is required.')
      return
    }
    const n = Number(days)
    if (!Number.isFinite(n) || n < 1 || n > status!.max_days) {
      setFormError(`Days must be between 1 and ${status!.max_days}.`)
      return
    }
    try {
      await declare.mutateAsync({ reason: trimmed, days: n })
      setNotice(status!.active ? 'Emergency updated.' : 'Emergency declared. Rescue search is on.')
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not declare the emergency.'))
    }
  }

  async function handleEnd() {
    setFormError(null)
    setNotice(null)
    try {
      await end.mutateAsync()
      setNotice('Emergency ended. Rescue search is off.')
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not end the emergency.'))
    }
  }

  return (
    <section>
      <h2>Rescue emergency</h2>
      <p className="muted">
        Rescue search (<code>/api/v2/rescue/lookup/</code>) is off by default. Declaring an emergency turns it on
        for a capped number of days, for every rescue operator. It also lets a case trace start without the
        device accepting first. Every declare, change, and end is permanently logged with your account.
      </p>
      <p className="muted">
        <strong>What this does NOT do:</strong> it never lets a lookup find a phone number that was never
        registered for rescue location through this app. It only relaxes the consent flag on numbers that already
        enrolled -- so someone who withdrew consent (or never explicitly withdrew, under a real carrier/government
        integration with no in-app consent screen at all) can still be found while this is active.
      </p>

      <div className="page-status" style={{ marginBottom: 16 }}>
        {status.active ? (
          <>
            Active: <strong>{status.reason}</strong> — ends {new Date(status.expires_at!).toLocaleString()}
            {status.declared_by && <> · declared by {status.declared_by}</>}
          </>
        ) : (
          <>No emergency declared. Rescue search is off.</>
        )}
      </div>

      {formError && <div className="form-error">{formError}</div>}
      {notice && <div className="form-success">{notice}</div>}

      <div className="edit-grid" style={{ gridTemplateColumns: '1fr', gap: 12 }}>
        <label>
          Reason
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. 2026 flood response, NDRRMA case #..."
          />
        </label>
        <label>
          Days ({status.default_days} by default, up to {status.max_days})
          <input
            type="number"
            min={1}
            max={status.max_days}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
      </div>

      <div className="admin-page-actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" onClick={handleDeclare} disabled={declare.isPending}>
          {declare.isPending ? 'Saving…' : status.active ? 'Update emergency' : 'Declare emergency'}
        </button>
        {status.active && (
          <button
            className="btn-secondary"
            onClick={handleEnd}
            disabled={end.isPending}
            style={{ marginLeft: 8 }}
          >
            {end.isPending ? 'Ending…' : 'End emergency now'}
          </button>
        )}
      </div>
    </section>
  )
}

export default function RescuePolicyPage() {
  return (
    <div className="admin-page" style={{ maxWidth: 640 }}>
      <h1>Rescue Policy</h1>
      <EmergencySwitchPanel />
    </div>
  )
}
