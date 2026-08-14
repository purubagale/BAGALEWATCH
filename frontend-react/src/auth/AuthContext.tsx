import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { apiJson, clearTokens, getAccessToken, setOnAuthExpired, setTokens } from '../api/client'
import type { Me } from '../api/types'

// Idle-timeout mirrors v1's client-side 5-minute inactivity logout
// (SESSION_LIFETIME_SECS in bagalewatch_api.py) — a deliberate UX-parity
// choice, not the JWT access-token lifetime (15 min, see settings.py),
// which only bounds how long a stolen token stays valid.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

interface AuthState {
  user: Me | null
  loading: boolean
  restoring: boolean
  login: (username: string, password: string) => Promise<void>
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

  const logout = useCallback(() => {
    clearTokens()
    if (idleTimer.current) clearTimeout(idleTimer.current)
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
    window.location.href = '/login'
  }, [])

  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(logout, IDLE_TIMEOUT_MS)
  }, [logout])

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

  const login = useCallback(async (username: string, password: string) => {
    setLoading(true)
    try {
      const data = await apiJson<Me & { access: string; refresh: string }>('/api/v2/auth/login/', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setTokens(data.access, data.refresh)
      const { access: _a, refresh: _r, ...me } = data
      setUser(me)
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, restoring, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>')
  return ctx
}
