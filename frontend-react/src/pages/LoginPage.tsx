import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { ApiError } from '../api/client'
import { useBranding } from '../api/queries'
import { DASHBOARD_PATH } from '../constants/opaqueRoutes'

export default function LoginPage() {
  const { user, login, loading } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Customizable branding (2026-08-08 follow-up) — BrandingSettingsView's
  // GET is deliberately AllowAny (not IsAuthenticated) specifically so
  // this pre-login page can read it. Falls back to the stock Nepal
  // Telecom logo/app name when nothing's been customized yet.
  const { data: branding } = useBranding()
  const brandLogoSrc = branding?.logo_url || '/ntc-logo.jpg'
  const brandName = branding?.app_name || 'BAGALEWATCH BTS'
  // Login-page text customization (2026-08-08 follow-up: "let superadmin
  // to customize the login interface texts also") — same fallback
  // convention as the logo/name above: an empty string from the server
  // means "not customized," so `||` falls through to the original
  // hardcoded copy.
  const loginSubtitle = branding?.login_subtitle || 'Nepal Telecom · 4G RAN O&M — sign in'
  const usernameLabel = branding?.login_username_label || 'Username'
  const passwordLabel = branding?.login_password_label || 'Password'
  const buttonText = branding?.login_button_text || 'Sign in'
  const disclaimer =
    branding?.login_disclaimer || 'Internal system — Nepal Telecom 4G RAN O&M. All activities are monitored.'

  // Dashboard is the default landing page (2026-08-08) — matches
  // RootRedirect in App.tsx; was /sites before Dashboard existed. Points
  // at the opaque path directly (2026-08-08 follow-up), same reasoning
  // as RootRedirect.
  if (user) return <Navigate to={DASHBOARD_PATH} replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await login(username, password)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid username or password.')
      } else if (err instanceof ApiError && err.status === 403) {
        setError('This account is disabled.')
      } else if (err instanceof ApiError && err.status === 429) {
        // Brute-force lockout (2026-08-08 security hardening) — matches
        // v1's 5-attempt/15-minute lockout, see LoginView's docstring on
        // the Django side.
        setError('Too many failed login attempts. Try again in 15 minutes.')
      } else if (err instanceof ApiError) {
        // A real HTTP response came back, just not one of the expected
        // shapes above (e.g. a 500) — distinct from "couldn't reach the
        // server at all", which is a network-level failure, not an
        // ApiError. Conflating the two (2026-07-27) turned a real Django
        // 500 into a misleading "is the server running?" message while
        // the server was, in fact, running and responding.
        setError(`Server error (${err.status}). Check the Django logs.`)
      } else {
        setError('Could not reach the server. Is the Django API running?')
      }
    }
  }

  return (
    <div className="login-page">
      {/* Bright-card theme (2026-08-11, "login portal in this attached
          [reference screenshot] seems bright and attractive, use this
          theme") — dotted background + pill badge header + circular
          avatar + pill inputs/button + bottom disclaimer bar, restyled
          around this app's existing --brand-primary token (#0153A5, the
          real NTC logo blue) rather than the reference's own color, so
          it stays visually consistent with the rest of the app (topbar,
          buttons, etc.) instead of introducing a second unrelated brand
          color. Deliberately did NOT add a "Forgot Password?" link like
          the reference has — this app has no password-reset flow (only
          an admin-driven user management page), so a link with nothing
          behind it would just be a dead end. */}
      <button
        type="button"
        className="theme-toggle-btn login-theme-toggle"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      <div className="login-badge">{brandName} Login</div>
      <form className="login-card" onSubmit={handleSubmit}>
        {/* Real Nepal Telecom logo (2026-08-07 branding pass), now
            customizable (2026-08-08 follow-up) — falls back to the
            stock public/ntc-logo.jpg + app name when nothing's been
            uploaded via the Branding settings page. Wrapped in a
            circular soft-brand-color badge to match the reference. */}
        <div className="login-avatar">
          <img src={brandLogoSrc} alt={brandName} className="login-logo" />
        </div>
        <h1>{brandName}</h1>
        <p className="login-subtitle">{loginSubtitle}</p>
        <label className="login-field">
          <span className="login-field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
            </svg>
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder={usernameLabel}
            aria-label={usernameLabel}
          />
        </label>
        <label className="login-field">
          <span className="login-field-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M7 10V7a5 5 0 0 1 10 0v3" />
            </svg>
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder={passwordLabel}
            aria-label={passwordLabel}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={loading || !username || !password} className="login-submit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
          {loading ? 'Signing in…' : buttonText}
        </button>
      </form>
      <div className="login-disclaimer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z" />
        </svg>
        {disclaimer}
      </div>
    </div>
  )
}
