import { useEffect, useState, type FormEvent } from 'react'
import { apiErrorMessage, apiJson } from '../api/client'
import { useAuth } from '../auth/AuthContext'

// Two-factor login for one's own account (2026-10-15; the server side has
// existed since 2026-10-02, core/mfa.py). Opened from the user menu, or on
// its own when the Security settings require two-factor login for this
// account and it is not set up yet: then it cannot be closed until it is.
// Turning it on: scan the QR code with an authenticator app (Google
// Authenticator, Microsoft Authenticator, FreeOTP...) and type one code to
// prove it works. Turning it off needs a current code.

interface Status {
  totp_enabled: boolean
  required_for_me: boolean
  sso_account: boolean
}

export default function TwoFactorModal({ forced, onClose }: { forced?: boolean; onClose: () => void }) {
  const { clearMfaSetupRequired, logout } = useAuth()
  const [status, setStatus] = useState<Status | null>(null)
  const [enroll, setEnroll] = useState<{ secret: string; qr_data_url: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  const load = () => apiJson<Status>('/api/v2/auth/mfa/status/').then(setStatus).catch((e) => setError(apiErrorMessage(e)))
  useEffect(() => {
    void load()
  }, [])

  async function start() {
    setError(null)
    setBusy(true)
    try {
      setEnroll(await apiJson('/api/v2/auth/mfa/enroll/start/', { method: 'POST', body: '{}' }))
      setCode('')
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await apiJson('/api/v2/auth/mfa/enroll/confirm/', { method: 'POST', body: JSON.stringify({ code }) })
      setEnroll(null)
      setDone('Two-factor login is on. From now on you will be asked for a code after your password.')
      clearMfaSetupRequired()
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'That code did not match. Check the phone\'s clock and try the newest code.'))
    } finally {
      setBusy(false)
    }
  }

  async function disable(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await apiJson('/api/v2/auth/mfa/disable/', { method: 'POST', body: JSON.stringify({ code }) })
      setDone(status?.required_for_me
        ? 'Two-factor login is off, but it is required for your account: you will be asked to set it up at your next sign-in.'
        : 'Two-factor login is off.')
      setCode('')
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Incorrect code.'))
    } finally {
      setBusy(false)
    }
  }

  const mustSetUp = forced && status && !status.totp_enabled
  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 460, width: '95%' }}>
        <div className="modal-hdr"><h2>Two-factor login</h2></div>
        <div className="modal-body">
          {mustSetUp && (
            <p className="pd-caution">
              Two-factor login is required for your account. Set it up to continue.
            </p>
          )}
          {!status && !error && <p className="muted">Loading…</p>}
          {status?.sso_account && (
            <p className="muted">You sign in with NT single sign-on; its own login page handles the second step.</p>
          )}
          {done && <div className="form-success" style={{ marginBottom: 10 }}>{done}</div>}

          {status && !status.sso_account && !status.totp_enabled && !enroll && (
            <>
              <p>
                After your password, you will also type a 6-digit code from an authenticator app on your phone
                (Google Authenticator, Microsoft Authenticator or FreeOTP). Someone who learns your password still
                cannot sign in without your phone.
              </p>
              <button type="button" className="btn-primary" disabled={busy} onClick={start}>Set up two-factor login</button>
            </>
          )}

          {enroll && (
            <form className="edit-grid" style={{ gridTemplateColumns: '1fr' }} onSubmit={confirm}>
              <p style={{ margin: 0 }}>1. In the authenticator app, add an account and scan this code:</p>
              <img src={enroll.qr_data_url} alt="QR code for the authenticator app" style={{ width: 200, height: 200, margin: '0 auto', background: '#fff' }} />
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Cannot scan? Type this key instead: <code style={{ userSelect: 'all' }}>{enroll.secret}</code>
              </p>
              <label>
                2. Type the 6-digit code the app shows
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" />
              </label>
              <button type="submit" className="btn-primary" disabled={busy || code.length !== 6}>Turn on</button>
            </form>
          )}

          {status && !status.sso_account && status.totp_enabled && !done && (
            <form className="edit-grid" style={{ gridTemplateColumns: '1fr' }} onSubmit={disable}>
              <p style={{ margin: 0 }}>
                Two-factor login is on for your account.
                {status.required_for_me && ' It is required for your account by the security settings.'}
              </p>
              <label>
                To turn it off, type a current code
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
              </label>
              <button type="submit" className="btn-danger" disabled={busy || code.length !== 6}>Turn off</button>
            </form>
          )}
          {error && <div className="form-error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="modal-footer">
          {mustSetUp ? (
            <button type="button" className="btn-secondary btn-small" onClick={logout}>Sign out</button>
          ) : (
            <button type="button" className="btn-secondary btn-small" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  )
}
