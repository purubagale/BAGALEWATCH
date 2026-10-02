import { useState, type FormEvent } from 'react'
import { apiErrorMessage } from '../api/client'
import { useChangePassword } from '../api/queries'

// Self-service change-password (2026-10-02), opened from Layout.tsx's user
// menu. A modal rather than its own route -- reachable from every page via
// the same dropdown, and there is nothing here worth deep-linking to.
export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const changePassword = useChangePassword()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }
    try {
      await changePassword.mutateAsync({ old_password: oldPassword, new_password: newPassword })
      setDone(true)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change password.'))
    }
  }

  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 420, width: '95%' }}>
        <div className="modal-hdr">
          <h2>Change password</h2>
        </div>
        <div className="modal-body">
          {done ? (
            <div className="form-success">Password changed successfully.</div>
          ) : (
            <form className="edit-grid" onSubmit={handleSubmit} style={{ gridTemplateColumns: '1fr' }}>
              <label>
                Current password
                <input
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  autoFocus
                  autoComplete="current-password"
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {error && <div className="form-error">{error}</div>}
              <button
                type="submit"
                className="btn-primary"
                disabled={changePassword.isPending || !oldPassword || !newPassword || !confirmPassword}
              >
                {changePassword.isPending ? 'Changing…' : 'Change password'}
              </button>
            </form>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary btn-small" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
