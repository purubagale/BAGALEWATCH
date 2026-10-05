import { useState } from 'react'
import { apiErrorMessage } from '../api/client'
import {
  useCancelTraceRequest,
  useCreateTraceRequest,
  useRecordTracePhoneConsent,
  useTraceRequests,
} from '../api/queries'
import type { TraceRequestEntry, TraceRequestStatus } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// Device-bound, consent-gated tracing (2026-10-04) -- the operator console for
// core/device_trace.py. A request only ever reaches a phone the user has
// accepted on-device. A phone-call consent recorded here is attestation only:
// it prompts the phone, and the user must still tap Accept there. The device
// also needs OS location permission before it sends anything. This page never
// shows, or asks for, location data itself.

const STATUS_LABEL: Record<TraceRequestStatus, string> = {
  PENDING: 'Awaiting consent',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected by user',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  REVOKED: 'Stopped by user',
}

const CONSENT_LABEL: Record<string, string> = {
  APP: 'On device',
  PHONE_CALL: 'Phone call (recorded)',
  POLICY_BYPASS: 'Emergency policy',
}

function StatusBadge({ status }: { status: TraceRequestStatus }) {
  const tone = status === 'ACCEPTED' ? 'ok' : status === 'PENDING' ? 'warn' : 'muted'
  return <span className={`badge badge-${tone}`}>{STATUS_LABEL[status]}</span>
}

export default function TraceRequestsPage() {
  const { user: me } = useAuth()
  const { data, isLoading, error } = useTraceRequests()
  const create = useCreateTraceRequest()
  const recordPhone = useRecordTracePhoneConsent()
  const cancel = useCancelTraceRequest()

  const [msisdn, setMsisdn] = useState('')
  const [caseRef, setCaseRef] = useState('')
  const [ttl, setTtl] = useState('60')
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [phoneFor, setPhoneFor] = useState<string | null>(null)
  const [phoneRef, setPhoneRef] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)

  if (!me) return null
  if (me.role !== 'rescue_operator' && me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only rescue operators can request a trace.</div>
  }

  async function handleCreate() {
    setFormError(null)
    setNotice(null)
    if (!msisdn.trim()) return setFormError('Phone number is required.')
    if (!caseRef.trim()) return setFormError('Case reference is required.')
    try {
      const res = await create.mutateAsync({
        msisdn: msisdn.trim(),
        case_reference: caseRef.trim(),
        ttl_minutes: Number(ttl) || undefined,
      })
      setNotice(
        res.consent_method === 'POLICY_BYPASS'
          ? 'Created under the active emergency policy. The device has been notified; location still needs OS permission on the phone.'
          : res.push_sent
            ? 'Request sent. The user will be asked on their phone.'
            : 'Request created. The phone has not been pushed yet and will see it on its next check.',
      )
      setMsisdn('')
      setCaseRef('')
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not create the trace request.'))
    }
  }

  async function handlePhoneConsent(id: string) {
    setRowError(null)
    if (!phoneRef.trim()) return setRowError('Enter the call or record reference before saving.')
    try {
      await recordPhone.mutateAsync({ id, phone_consent_ref: phoneRef.trim() })
      setPhoneFor(null)
      setPhoneRef('')
    } catch (err) {
      setRowError(apiErrorMessage(err, 'Could not record phone consent.'))
    }
  }

  async function handleCancel(id: string) {
    setRowError(null)
    try {
      await cancel.mutateAsync(id)
    } catch (err) {
      setRowError(apiErrorMessage(err, 'Could not cancel this request.'))
    }
  }

  const rows: TraceRequestEntry[] = data ?? []

  return (
    <div className="admin-page">
      <h1>Trace Requests</h1>
      <p className="muted">
        A trace is only sent once the user has tapped Accept on their phone. Recording phone consent prompts the
        phone but does not start the trace on its own. Even then, the phone sends location only while location
        permission is on. Every request is audited.
      </p>

      <section>
        <h2>New request</h2>
        {formError && <div className="form-error">{formError}</div>}
        {notice && <div className="page-status" style={{ marginBottom: 8 }}>{notice}</div>}
        <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <label>
            Phone number
            <input value={msisdn} onChange={(e) => setMsisdn(e.target.value)} placeholder="+9779800000000" />
          </label>
          <label>
            Case reference
            <input value={caseRef} onChange={(e) => setCaseRef(e.target.value)} placeholder="Incident or ticket ID" />
          </label>
          <label>
            Duration (minutes)
            <input type="number" min={1} max={1440} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </label>
        </div>
        <div className="admin-page-actions">
          <button className="btn-primary" onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Requests</h2>
        {error && <div className="page-status page-status-error">Could not load trace requests.</div>}
        {isLoading && <div className="page-status">Loading…</div>}
        {rowError && <div className="form-error" style={{ marginBottom: 8 }}>{rowError}</div>}

        {data && (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Phone</th>
                <th>Case</th>
                <th>Status</th>
                <th>Consent</th>
                <th>Expires</th>
                <th>Requested by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = row.status === 'PENDING' || row.status === 'ACCEPTED'
                return (
                  <tr key={row.id}>
                    <td className="admin-table-key">{row.msisdn}</td>
                    <td>{row.case_reference}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>
                      {row.consent_method ? (
                        <>
                          {CONSENT_LABEL[row.consent_method] ?? row.consent_method}
                          {row.consent_at && (
                            <div className="muted">{new Date(row.consent_at).toLocaleString()}</div>
                          )}
                          {row.phone_consent_ref && <div className="muted">Ref: {row.phone_consent_ref}</div>}
                        </>
                      ) : (
                        <span className="muted">None yet</span>
                      )}
                      {row.status === 'PENDING' && row.phone_consent_at && (
                        <div className="muted">Phone consent recorded. Waiting for the user to tap Accept.</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {row.expires_at ? new Date(row.expires_at).toLocaleString() : '—'}
                    </td>
                    <td>{row.requested_by ?? '—'}</td>
                    <td className="admin-table-actions">
                      {row.status === 'PENDING' && !row.phone_consent_at && (
                        phoneFor === row.id ? (
                          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                            <input
                              value={phoneRef}
                              onChange={(e) => setPhoneRef(e.target.value)}
                              placeholder="Call / record ref"
                            />
                            <button
                              className="btn-primary btn-small"
                              onClick={() => handlePhoneConsent(row.id)}
                              disabled={recordPhone.isPending}
                            >
                              Save
                            </button>
                            <button className="btn-secondary btn-small" onClick={() => setPhoneFor(null)}>
                              Close
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn-secondary btn-small"
                            onClick={() => {
                              setPhoneFor(row.id)
                              setPhoneRef('')
                            }}
                          >
                            Record phone consent
                          </button>
                        )
                      )}
                      {open && (
                        <button
                          className="btn-secondary btn-small"
                          onClick={() => handleCancel(row.id)}
                          disabled={cancel.isPending}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="page-status">No trace requests yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
