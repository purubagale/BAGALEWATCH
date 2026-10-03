import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { DASHBOARD_PATH } from '../constants/opaqueRoutes'

/**
 * Lands here after Keycloak -> Django -> SPA (2026-08-23, Keycloak SSO).
 *
 * The backend has already authenticated the user, enforced the `dtwatch`
 * group, resolved their role and minted the app's own JWT. All that reaches
 * the browser is a one-time `code` in the query string, which this page
 * trades for the tokens. Deliberately NOT the tokens themselves: those would
 * otherwise sit in a URL, and therefore in browser history, in any referrer,
 * and in the logs of anything in between.
 *
 * The code is single-use server-side (Redis GETDEL) and expires in about a
 * minute, so this runs exactly once — hence the `exchanged` ref rather than
 * relying on the effect not re-firing. React 18 StrictMode double-invokes
 * effects in development, and without the guard the second call would consume
 * an already-consumed code and show a spurious failure.
 */
export default function SsoCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { user, loginWithSsoCode } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const exchanged = useRef(false)

  const code = params.get('code')

  useEffect(() => {
    if (!code || exchanged.current) return
    exchanged.current = true

    loginWithSsoCode(code)
      .then(() => {
        // `replace` so the spent code is not left in history — going Back
        // must not land on a URL that now fails.
        navigate(DASHBOARD_PATH, { replace: true })
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 400) {
          setError('This sign-in link has already been used or has expired. Please sign in again.')
        } else if (err instanceof ApiError && err.status === 403) {
          setError('This account is disabled. Contact an administrator.')
        } else if (err instanceof ApiError) {
          setError(`Could not complete sign-in (HTTP ${err.status}).`)
        } else {
          setError('Could not reach the server to complete sign-in.')
        }
      })
  }, [code, loginWithSsoCode, navigate])

  // Already signed in (e.g. this page was revisited) — nothing to do.
  if (user) return <Navigate to={DASHBOARD_PATH} replace />

  // Reached without a code: not a real callback, so send them to the login
  // page rather than showing an error for something they did not do.
  if (!code) return <Navigate to="/login" replace />

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo-wrap">
            <img src="/nt-logo-gold.webp" alt="" className="login-logo" />
          </div>
          <h1 className="login-heading">Sign-in failed</h1>
          <div className="login-error">{error}</div>
          <button type="button" className="login-submit" onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo-wrap">
          <img src="/nt-logo-gold.webp" alt="" className="login-logo" />
        </div>
        <h1 className="login-heading">Signing in…</h1>
        <p className="login-note">Completing single sign-on, please wait.</p>
      </div>
    </div>
  )
}
