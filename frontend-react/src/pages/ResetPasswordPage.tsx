import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useConfirmPasswordReset } from '../api/queries'

// Opened from the link core/password_reset.py's PasswordResetRequestView
// emails (?uid=<b64 pk>&token=<token>) -- public, unauthenticated, same
// `.login-page`/`.login-card` chrome as LoginPage.tsx so it doesn't look
// like a different app mid-flow. A plain route (not a LoginPage mode like
// the "forgot password?" request form) because this one is reached by
// clicking a link in an email, not by clicking something on this page.
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const uid = params.get('uid') || ''
  const token = params.get('token') || ''
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const confirmReset = useConfirmPasswordReset()

  const missingParams = !uid || !token

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    try {
      await confirmReset.mutateAsync({ uid, token, new_password: newPassword })
      setDone(true)
    } catch (err) {
      setError(apiErrorMessage(err, 'This reset link is invalid or has expired.'))
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-brand-name">Reset password</div>
        </div>
        <div className="login-rule" />

        {missingParams && (
          <div className="login-error">
            This reset link is missing required information. Request a new one from the login page.
          </div>
        )}

        {!missingParams && done && (
          <div className="login-form">
            <div className="form-success">Password reset successfully. You can now sign in.</div>
            <Link to="/login" className="login-submit" style={{ textAlign: 'center', textDecoration: 'none' }}>
              Go to login
            </Link>
          </div>
        )}

        {!missingParams && !done && (
          <form className="login-form" onSubmit={handleSubmit}>
            <input
              className="login-input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
              placeholder="New password"
              aria-label="New password"
            />
            <input
              className="login-input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Confirm new password"
              aria-label="Confirm new password"
            />
            {error && <div className="login-error">{error}</div>}
            <button
              type="submit"
              disabled={confirmReset.isPending || !newPassword || !confirmPassword}
              className="login-submit"
            >
              {confirmReset.isPending ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
