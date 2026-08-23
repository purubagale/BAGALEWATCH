import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { ApiError } from '../api/client'
import { useBranding } from '../api/queries'
import { DASHBOARD_PATH } from '../constants/opaqueRoutes'
import { APP_VERSION } from '../lib/version'

/** Reasons the backend can bounce a failed SSO attempt back to /login.
 *
 * The server sends a coarse code rather than a message, deliberately: it must
 * not reveal whether an account exists. Mapping happens here so the copy can
 * be user-facing without the server leaking anything. Anything unrecognised
 * falls through to a generic line rather than rendering a raw code. */
const SSO_ERRORS: Record<string, string> = {
  no_app_access:
    'Your account is not authorised for DT-WATCH. Ask an administrator to add you to the DT-WATCH group.',
  link_conflict:
    'An account with your username already exists here and could not be verified as yours. Contact an administrator.',
  inactive_user: 'This account is disabled. Contact an administrator.',
  sso_unavailable: 'Single sign-on is not configured on this server.',
  idp_error: 'Sign-in was cancelled or refused by the identity provider.',
  idp_unreachable: 'Could not reach the identity provider. Try again shortly.',
  bad_state: 'That sign-in attempt expired. Please try again.',
  bad_login_code: 'That sign-in link has already been used. Please try again.',
  invalid_id_token: 'The identity provider returned a token we could not verify.',
}

export default function LoginPage() {
  const { user, login, loading } = useAuth()
  const [params] = useSearchParams()
  const { theme, toggleTheme } = useTheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Customizable branding (2026-08-08 follow-up) — BrandingSettingsView's
  // GET is deliberately AllowAny (not IsAuthenticated) specifically so
  // this pre-login page can read it. Falls back to the stock Nepal
  // Telecom logo/app name when nothing's been customized yet.
  const { data: branding } = useBranding()
  // Default logo is now the shared Nepal Telecom tile (2026-08-23) — the same
  // asset dutychart's login uses. This page was restyled to match that one,
  // and a matching mark is most of why the two read as one system. A logo
  // uploaded on the Branding page still overrides it.
  const brandLogoSrc = branding?.logo_url || '/nt-logo-gold.webp'
  const brandName = branding?.app_name || 'DT-WATCH BTS'
  // Login-page text customization (2026-08-08 follow-up: "let superadmin
  // to customize the login interface texts also") — same fallback
  // convention as the logo/name above: an empty string from the server
  // means "not customized," so `||` falls through to the original
  // hardcoded copy.
  const loginSubtitle = branding?.login_subtitle || 'Nepal Telecom · 4G RAN O&M'
  const usernameLabel = branding?.login_username_label || 'Username'
  const passwordLabel = branding?.login_password_label || 'Password'
  const buttonText = branding?.login_button_text || 'Login'
  const disclaimer =
    branding?.login_disclaimer || 'Internal system — Nepal Telecom 4G RAN O&M. All activities are monitored.'

  // Which sign-in methods this server offers (2026-08-23). Both default to
  // the pre-SSO behaviour while `branding` is still loading: no SSO button,
  // password form shown. That way a slow or failed branding fetch degrades
  // to exactly what this page did before SSO existed, rather than to a page
  // with no way to sign in at all.
  const ssoEnabled = branding?.sso_enabled === true
  const localLoginEnabled = branding?.local_login_enabled !== false
  const ssoErrorCode = params.get('sso_error')
  const ssoError = ssoErrorCode
    ? SSO_ERRORS[ssoErrorCode] || 'Single sign-on failed. Please try again.'
    : null

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
        // Covers both a disabled account and the SSO-only cutover
        // (2026-08-23): with LOCAL_LOGIN_ENABLED=0 the server 403s this
        // endpoint. The form is hidden in that case, so reaching here means
        // a stale page was left open across the cutover.
        setError('Password sign-in is unavailable for this account. Try single sign-on.')
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
      {/* Card layout matched to dutychart's login (2026-08-23, "put the UI
          as dutychart") — logo tile, name + subtitle, hairline rule, "Login"
          heading, plain 8px-radius fields, solid primary button, OR rule,
          outlined SSO button. Replaces the 2026-08-11 bright-card treatment
          (pill badge, circular avatar, pill inputs, icon-prefixed fields) so
          the two internal apps read as one system.

          Deliberately NOT carried over from that reference: "Remember me",
          "Forgot Password?" and "Sign up". dt-watch has no password-reset
          flow and no self-registration (accounts are admin-created or
          JIT-created via SSO), and its tokens live in sessionStorage by a
          deliberate choice in client.ts that Remember me would have to
          reverse. Rendering them would be three controls that do nothing.

          Unlike the reference, colors come from this app's theme tokens
          rather than literal white/grays — dutychart's login is light-only,
          this one has a working dark theme to preserve. */}
      <button
        type="button"
        className="theme-toggle-btn login-theme-toggle"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      <div className="login-card">
        <div className="login-logo-wrap">
          <img src={brandLogoSrc} alt={brandName} className="login-logo" />
        </div>
        <div className="login-brand">
          <div className="login-brand-name">{brandName}</div>
          <div className="login-brand-sub">{loginSubtitle}</div>
        </div>
        <div className="login-rule" />
        <h1 className="login-heading">Login</h1>

        {ssoError && <div className="login-error">{ssoError}</div>}

        {localLoginEnabled && (
          <form className="login-form" onSubmit={handleSubmit}>
            <input
              className="login-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder={usernameLabel}
              aria-label={usernameLabel}
            />
            <div className="login-input-wrap">
              <input
                className="login-input login-input-with-btn"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder={passwordLabel}
                aria-label={passwordLabel}
              />
              {/* tabIndex -1 so tabbing runs straight from the password field
                  to the submit button rather than through a control that only
                  changes how the field is displayed. */}
              <button
                type="button"
                tabIndex={-1}
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    <path d="M1 1l22 22" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" disabled={loading || !username || !password} className="login-submit">
              {loading ? 'Signing in…' : buttonText}
            </button>
          </form>
        )}

        {ssoEnabled && (
          <>
            {localLoginEnabled && <div className="login-or">or</div>}
            {/* A real link, not a fetch: this must be a top-level browser
                navigation so it can follow the backend's 302 to Keycloak and
                carry the state cookie. An XHR would be blocked by CORS at
                the identity provider and could not show a login form. */}
            <a className="login-sso-btn" href="/api/v2/auth/sso/login/">
              <img src="/nt-logo-gold.webp" alt="" className="login-sso-logo" />
              Login with NT SSO
            </a>
          </>
        )}

        {!localLoginEnabled && !ssoEnabled && (
          <div className="login-error">
            No sign-in method is enabled on this server. Contact an administrator.
          </div>
        )}
      </div>

      {/* Plain text, not a link to /about: that page shows a git SHA and
          build tag, which is more than an unauthenticated visitor needs. */}
      <div className="login-version">{APP_VERSION}</div>

      <div className="login-disclaimer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z" />
        </svg>
        {disclaimer}
      </div>
    </div>
  )
}
