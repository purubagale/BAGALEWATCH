import { useRef, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useBranding, useUpdateBranding } from '../api/queries'
import { MAX_IDLE_TIMEOUT_MINUTES, MIN_IDLE_TIMEOUT_MINUTES, useAuth } from '../auth/AuthContext'

// Customize the org-wide logo + app name (2026-08-08 follow-up: "add
// feature to customize logo and name") — shown in the sidebar brand
// block (Layout.tsx) and the login page (LoginPage.tsx), both of which
// fall back to the stock Nepal Telecom logo/"DT-WATCH BTS" when
// nothing's been customized yet. See BrandingSettingsView's docstring on
// the Django side for why the logo travels as a base64 data URL instead
// of multipart/form-data.
const MAX_LOGO_BYTES = 5 * 1024 * 1024

export default function BrandingPage() {
  const { user } = useAuth()
  const { data: branding, isLoading, error } = useBranding()
  const updateBranding = useUpdateBranding()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [appName, setAppName] = useState<string | null>(null)
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)

  // Login-page text customization (2026-08-08 follow-up: "let superadmin
  // to customize the login interface texts also") — same null-means-
  // "use server value" local-override pattern as `appName` above, one
  // field per piece of text LoginPage.tsx renders besides the app name/
  // logo (which already had their own customization).
  const [loginSubtitle, setLoginSubtitle] = useState<string | null>(null)
  const [loginUsernameLabel, setLoginUsernameLabel] = useState<string | null>(null)
  const [loginPasswordLabel, setLoginPasswordLabel] = useState<string | null>(null)
  const [loginButtonText, setLoginButtonText] = useState<string | null>(null)
  // Bottom disclaimer pill (2026-08-11 follow-up), same pattern.
  const [loginDisclaimer, setLoginDisclaimer] = useState<string | null>(null)

  // Session (idle-logout) timeout, in minutes (2026-08-25 follow-up:
  // "session time for logout is very low, add a feature to customize
  // session time for logout"). Kept as a raw string, not a number, while
  // being typed — an in-progress edit like "" or a leading-zero string
  // would otherwise force a premature/confusing numeric coercion before the
  // user finishes typing. null (not "") means "no local edit yet, show the
  // server's current value" — same override pattern as appName etc. above.
  const [idleTimeoutInput, setIdleTimeoutInput] = useState<string | null>(null)

  if (isLoading) return <div className="page-status">Loading branding settings…</div>
  if (error) return <div className="page-status page-status-error">Could not load branding settings.</div>
  if (!user) return null

  // Matches BrandingSettingsView's own gate (PUT is IsSuperadminOnly) —
  // a non-superadmin reaching this route (e.g. by URL) sees a plain
  // message rather than a form that would just 403 on save.
  if (user.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can customize branding.</div>
  }

  const currentName = appName ?? branding?.app_name ?? ''
  const currentLogoSrc = previewDataUrl ?? branding?.logo_url ?? '/nt-logo-gold.webp'
  const hasCustomLogo = !!branding?.logo_url

  const currentLoginSubtitle = loginSubtitle ?? branding?.login_subtitle ?? ''
  const currentLoginUsernameLabel = loginUsernameLabel ?? branding?.login_username_label ?? ''
  const currentLoginPasswordLabel = loginPasswordLabel ?? branding?.login_password_label ?? ''
  const currentLoginButtonText = loginButtonText ?? branding?.login_button_text ?? ''
  const currentLoginDisclaimer = loginDisclaimer ?? branding?.login_disclaimer ?? ''

  const serverIdleTimeout = branding?.idle_timeout_minutes
  const currentIdleTimeout = idleTimeoutInput ?? (serverIdleTimeout != null ? String(serverIdleTimeout) : '')

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSaveError(null)
    setSaveOk(false)
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setSaveError('Please choose an image file.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setSaveError('Image is too large (max 5MB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setPreviewDataUrl(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function handleSaveName() {
    setSaveError(null)
    setSaveOk(false)
    try {
      await updateBranding.mutateAsync({ app_name: currentName })
      setSaveOk(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the app name.'))
    }
  }

  async function handleSaveLogo() {
    if (!previewDataUrl) return
    setSaveError(null)
    setSaveOk(false)
    try {
      await updateBranding.mutateAsync({ logo_data_url: previewDataUrl })
      setPreviewDataUrl(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setSaveOk(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the logo.'))
    }
  }

  async function handleRemoveLogo() {
    setSaveError(null)
    setSaveOk(false)
    try {
      await updateBranding.mutateAsync({ remove_logo: true })
      setPreviewDataUrl(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setSaveOk(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not remove the logo.'))
    }
  }

  async function handleSaveLoginText() {
    setSaveError(null)
    setSaveOk(false)
    try {
      await updateBranding.mutateAsync({
        login_subtitle: currentLoginSubtitle,
        login_username_label: currentLoginUsernameLabel,
        login_password_label: currentLoginPasswordLabel,
        login_button_text: currentLoginButtonText,
        login_disclaimer: currentLoginDisclaimer,
      })
      setSaveOk(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the login page text.'))
    }
  }

  async function handleSaveIdleTimeout() {
    setSaveError(null)
    setSaveOk(false)
    const trimmed = currentIdleTimeout.trim()
    if (trimmed === '') {
      // Explicit reset to the server's env-var default — see
      // BrandingSettingsWrite's own comment on why null (not omission) is
      // what triggers this.
      try {
        await updateBranding.mutateAsync({ idle_timeout_minutes: null })
        setIdleTimeoutInput(null)
        setSaveOk(true)
      } catch (err) {
        setSaveError(apiErrorMessage(err, 'Could not reset the session timeout.'))
      }
      return
    }
    const minutes = Number(trimmed)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_IDLE_TIMEOUT_MINUTES) {
      setSaveError(
        `Enter a whole number between 0 and ${MAX_IDLE_TIMEOUT_MINUTES} minutes (0 disables auto sign-out).`,
      )
      return
    }
    try {
      await updateBranding.mutateAsync({ idle_timeout_minutes: minutes })
      setIdleTimeoutInput(null)
      setSaveOk(true)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the session timeout.'))
    }
  }

  return (
    <div className="admin-page branding-page">
      <h1>Branding</h1>
      <p className="muted">
        Customize the logo and app name shown in the sidebar and on the sign-in page. Leave blank to use the default
        Nepal Telecom logo and "DT-WATCH BTS" name.
      </p>

      {saveError && <div className="login-error">{saveError}</div>}
      {saveOk && !saveError && <div className="branding-save-ok">Saved.</div>}

      <section className="branding-section">
        <h2>Logo</h2>
        <div className="branding-logo-row">
          <img src={currentLogoSrc} alt="Logo preview" className="branding-logo-preview" />
          <div className="branding-logo-controls">
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} />
            <div className="branding-logo-buttons">
              <button type="button" onClick={handleSaveLogo} disabled={!previewDataUrl || updateBranding.isPending}>
                {updateBranding.isPending ? 'Saving…' : 'Save logo'}
              </button>
              {previewDataUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setPreviewDataUrl(null)
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                >
                  Cancel
                </button>
              )}
              {hasCustomLogo && !previewDataUrl && (
                <button type="button" onClick={handleRemoveLogo} disabled={updateBranding.isPending}>
                  Remove custom logo
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="branding-section">
        <h2>App name</h2>
        <div className="branding-name-row">
          <input
            type="text"
            value={currentName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="DT-WATCH BTS"
            maxLength={100}
          />
          <button type="button" onClick={handleSaveName} disabled={updateBranding.isPending}>
            {updateBranding.isPending ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </section>

      <section className="branding-section">
        <h2>Login page text</h2>
        <p className="muted">
          Customize the text shown on the sign-in screen below the app name. Leave any field blank to use its
          default.
        </p>
        <div className="branding-login-text-grid">
          <label>
            Subtitle
            <input
              type="text"
              value={currentLoginSubtitle}
              onChange={(e) => setLoginSubtitle(e.target.value)}
              placeholder="Nepal Telecom · 4G RAN O&M — sign in"
              maxLength={200}
            />
          </label>
          <label>
            Username field label
            <input
              type="text"
              value={currentLoginUsernameLabel}
              onChange={(e) => setLoginUsernameLabel(e.target.value)}
              placeholder="Username"
              maxLength={50}
            />
          </label>
          <label>
            Password field label
            <input
              type="text"
              value={currentLoginPasswordLabel}
              onChange={(e) => setLoginPasswordLabel(e.target.value)}
              placeholder="Password"
              maxLength={50}
            />
          </label>
          <label>
            Sign-in button text
            <input
              type="text"
              value={currentLoginButtonText}
              onChange={(e) => setLoginButtonText(e.target.value)}
              placeholder="Sign in"
              maxLength={50}
            />
          </label>
          <label>
            Bottom disclaimer text
            <input
              type="text"
              value={currentLoginDisclaimer}
              onChange={(e) => setLoginDisclaimer(e.target.value)}
              placeholder="Internal system — Nepal Telecom 4G RAN O&M. All activities are monitored."
              maxLength={200}
            />
          </label>
        </div>
        <div className="admin-page-actions">
          <button type="button" onClick={handleSaveLoginText} disabled={updateBranding.isPending}>
            {updateBranding.isPending ? 'Saving…' : 'Save login page text'}
          </button>
        </div>
      </section>

      <section className="branding-section">
        <h2>Session timeout</h2>
        <p className="muted">
          Minutes of inactivity before everyone is automatically signed out. Enter 0 to turn auto sign-out off, or
          clear this field entirely to fall back to the server's own env-var default instead of a saved override.
          Currently in effect: {serverIdleTimeout ?? '…'} min. Applies to every user, on their next sign-in or once
          their idle timer next resets.
        </p>
        <div className="branding-name-row">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_IDLE_TIMEOUT_MINUTES}
            step={1}
            value={currentIdleTimeout}
            onChange={(e) => setIdleTimeoutInput(e.target.value)}
            placeholder={`e.g. ${MIN_IDLE_TIMEOUT_MINUTES * 3}`}
          />
          <button type="button" onClick={handleSaveIdleTimeout} disabled={updateBranding.isPending}>
            {updateBranding.isPending ? 'Saving…' : 'Save session timeout'}
          </button>
        </div>
      </section>
    </div>
  )
}
