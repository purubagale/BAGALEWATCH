import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { DJANGO_API_URL, apiJson, clearTokens, getAccessToken, setOnAuthExpired, setTokens } from '../api/client'
import type { Me } from '../api/types'
// Public, unauthenticated payload — already fetched by the login page, so
// reusing it here costs no extra request in the common case. queries.ts does
// not import from this module, so there is no cycle.
import { useBranding } from '../api/queries'

// Fallback inactivity timeout, used until the server's value arrives and if
// an older backend never sends one. Mirrors v1's client-side 5-minute logout
// (SESSION_LIFETIME_SECS in bagalewatch_api.py) — a deliberate UX-parity
// choice, not the JWT access-token lifetime (15 min, see settings.py), which
// only bounds how long a stolen token stays valid.
const DEFAULT_IDLE_TIMEOUT_MINUTES = 5

// Bounds for the server-provided value (2026-08-23, "autologout time should
// be configurable"). 0 is special-cased as "never" before this clamp; the
// floor exists because a sub-minute timeout logs people out mid-sentence, and
// the ceiling because a week-long idle session is not an idle session.
const MIN_IDLE_TIMEOUT_MINUTES = 1
const MAX_IDLE_TIMEOUT_MINUTES = 8 * 60

// How long sign-out will wait on the backend before giving up and signing
// out locally anyway. Short on purpose: someone who clicked Sign out must end
// up signed out even if the API is wedged.
const LOGOUT_CALL_TIMEOUT_MS = 3000

interface AuthState {
  user: Me | null
  loading: boolean
  restoring: boolean
  login: (username: string, password: string) => Promise<void>
  loginWithSsoCode: (code: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(false)
  // True only while we're attempting to restore a session from a token that
  // survived a page reload (see client.ts's sessionStorage mirroring).
  // ProtectedRoute waits on this instead of redirecting to /login the
  // instant `user` is still null on the very first render after a refresh.
  const [restoring, setRestoring] = useState(() => !!getAccessToken())
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loggingOut = useRef(false)
  const { data: branding } = useBranding()

  const logout = useCallback(async () => {
    // Re-entrancy guard: the Sign out button, the idle timer and
    // onAuthExpired all land here, and the await below leaves a window in
    // which a second caller could fire a second logout.
    if (loggingOut.current) return
    loggingOut.current = true
    if (idleTimer.current) clearTimeout(idleTimer.current)

    // For an SSO login, DT-WATCH's own tokens are only half the session. The
    // Keycloak browser session outlives them, so the next "Sign in with NT
    // SSO" walks straight back in with no prompt at all — on a shared
    // workstation, into the previous user's account. Only Keycloak can end
    // that session, via the end-session URL the backend hands back here
    // (RP-Initiated Logout). No URL (local account, SSO off, ID token gone)
    // means there is nothing to end and /login is the right target.
    //
    // Deliberately a raw fetch rather than apiFetch: on a 401 apiFetch
    // attempts a silent refresh and then calls onAuthExpired() -> logout(),
    // i.e. straight back into this function. Refreshing a session we are in
    // the middle of ending is pointless regardless.
    //
    // If the token is already gone — the session-expiry path, where apiFetch
    // has cleared it before calling onAuthExpired — there is nothing to
    // authenticate the call with, so the Keycloak session cannot be ended
    // from here and sign-out stays local.
    let target = '/login'
    const token = getAccessToken()
    if (token) {
      const ctl = new AbortController()
      const bail = setTimeout(() => ctl.abort(), LOGOUT_CALL_TIMEOUT_MS)
      try {
        const res = await fetch(`${DJANGO_API_URL}/auth/logout/`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: ctl.signal,
        })
        // 204 = nothing to end. A 200 body carries the Keycloak URL.
        if (res.ok && res.status !== 204) {
          const body = await res.json().catch(() => null)
          if (body?.keycloak_logout_url) target = body.keycloak_logout_url as string
        }
      } catch {
        // Timed out, offline, or the token was already dead — fall through
        // to a local sign-out rather than trapping the user in a session
        // they asked to leave.
      } finally {
        clearTimeout(bail)
      }
    }

    clearTokens()
    // Hard navigation instead of just clearing React state in place
    // (2026-08-05 fix, user report: "when i logged out and logged in,
    // should be in refreshed state, not in previously closed state").
    // Tokens now survive a normal reload in sessionStorage (see
    // client.ts, 2026-07-30), which fixed accidental logouts — but the
    // flip side is that a plain `setUser(null)` alone left every other
    // piece of client-side view state untouched in memory: useTreeStore's
    // expanded tree nodes/selected site/map scope, DT Data Manager's
    // active tab and session-history selections, any page-local
    // useState — all of it survived a logout because nothing was ever
    // tied to the auth session in the first place. Logging back in just
    // re-populated `user` on top of that stale state. A real reload wipes
    // the entire JS heap, which is the only thing that actually
    // guarantees a clean slate — and matches v1's own logout/idle-timeout
    // behavior (hard-reload), so this isn't a new UX pattern for this
    // codebase, just parity with the original.
    window.location.href = target
  }, [])

  // Inactivity timeout, from the server (public branding payload) so it can
  // be changed with an .env edit and a backend restart instead of a frontend
  // rebuild. `null` = auto-logout disabled (IDLE_TIMEOUT_MINUTES=0).
  const idleTimeoutMs = (() => {
    const raw = branding?.idle_timeout_minutes
    const minutes = typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : DEFAULT_IDLE_TIMEOUT_MINUTES
    if (minutes === 0) return null
    const clamped = Math.min(
      Math.max(minutes, MIN_IDLE_TIMEOUT_MINUTES),
      MAX_IDLE_TIMEOUT_MINUTES,
    )
    return clamped * 60 * 1000
  })()

  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    if (idleTimeoutMs === null) return
    idleTimer.current = setTimeout(logout, idleTimeoutMs)
  }, [logout, idleTimeoutMs])

  // Re-arm when the server's value lands (the branding fetch resolves after
  // the first render) or changes, so the new timeout takes effect without
  // waiting for the user's next click.
  useEffect(() => {
    if (!user) return
    resetIdleTimer()
  }, [idleTimeoutMs, user, resetIdleTimer])

  useEffect(() => {
    setOnAuthExpired(() => logout())
    return () => setOnAuthExpired(null)
  }, [logout])

  // Restore-on-reload: a normal refresh wipes React state but the access
  // token survives in sessionStorage (client.ts). If one's present, confirm
  // it's still valid and re-hydrate `user` from it; apiFetch's existing
  // 401-retry-via-refresh-token already covers an access token that expired
  // mid-session. If both tokens are dead (refresh also expired/revoked),
  // clear them so the user lands on the login page instead of a half-logged-in limbo.
  useEffect(() => {
    if (!getAccessToken()) {
      setRestoring(false)
      return
    }
    let cancelled = false
    apiJson<Me>('/api/v2/auth/me/')
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        if (!cancelled) clearTokens()
      })
      .finally(() => {
        if (!cancelled) setRestoring(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!user) return
    resetIdleTimer()
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart']
    events.forEach((e) => window.addEventListener(e, resetIdleTimer))
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetIdleTimer))
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [user, resetIdleTimer])

  // Both sign-in paths end here (2026-08-23). /auth/sso/token/ deliberately
  // returns the same payload shape /auth/login/ does, so establishing the
  // session is byte-for-byte identical once the response is in hand — which
  // is what keeps SSO from needing any session plumbing of its own.
  const establishSession = useCallback(async (path: string, body: unknown) => {
    setLoading(true)
    try {
      const data = await apiJson<Me & { access: string; refresh: string }>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setTokens(data.access, data.refresh)
      const { access: _a, refresh: _r, ...me } = data
      setUser(me)
    } finally {
      setLoading(false)
    }
  }, [])

  const login = useCallback(
    (username: string, password: string) =>
      establishSession('/api/v2/auth/login/', { username, password }),
    [establishSession],
  )

  // Completes an SSO login: trades the one-time code the backend put in the
  // /sso/callback URL for the app's own tokens. The code is single-use and
  // very short-lived server-side, so this runs once on mount.
  const loginWithSsoCode = useCallback(
    (code: string) => establishSession('/api/v2/auth/sso/token/', { code }),
    [establishSession],
  )

  return (
    <AuthContext.Provider value={{ user, loading, restoring, login, loginWithSsoCode, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>')
  return ctx
}
