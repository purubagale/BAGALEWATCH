// BAGALEWATCH BTS v2 — API client.
//
// Tokens were originally kept in a module-level variable only (per §5 of
// the migration plan, "stored in memory... to reduce XSS exposure"), which
// meant ANY page refresh (soft or hard) logged the user out — the in-memory
// variable is wiped on every reload regardless of refresh type. Per explicit
// user request 2026-07-30 ("only log out after hard refresh or logout
// button"), tokens are now mirrored into sessionStorage so a normal reload
// (F5, browser back/forward, route change) keeps the session alive; the
// module-level variables below remain the source of truth read on every
// request, sessionStorage just survives the JS-context reset a reload causes.
//
// Important caveat, not fully achievable: there is no web API that
// distinguishes a "hard" refresh (Ctrl+Shift+R / cache-bypass reload) from a
// "soft" one — sessionStorage persists identically across both, and clears
// only when the tab/window is actually closed. So the practical behavior
// this gives you is "stay logged in across ANY refresh, log out only via
// the Logout button, token/refresh-token expiry, or closing the tab" — not
// literally "survive soft refresh, die on hard refresh." Idle-timeout
// enforcement (mirroring v1's 5-minute client-side timer) is layered on top
// in AuthContext, not here.

// 2026-08-10 — defaults to '' (same-origin, i.e. relative to whatever
// host/port the page itself was loaded from) instead of a hardcoded
// 'http://localhost:8000'. Two reasons at once: (1) explicit request to
// stop exposing django's own port to the browser/LAN — nginx now proxies
// /api/ back to django internally (see frontend-react/nginx.conf), so
// the browser only ever needs to reach the ONE port it's already on;
// (2) the hardcoded 'localhost:8000' was a real latent bug for genuine
// multi-user LAN access — "localhost" in a browser always means THAT
// BROWSER's own machine, so it only ever actually worked for whoever's
// browser happened to be running on the same machine as Docker itself.
// VITE_DJANGO_API_URL remains a valid override (e.g. for a locally-run
// `npm run dev` pointed at a Django instance not reachable via the same
// origin/proxy) — see vite.config.ts's dev-server proxy for why that's
// not needed for the common local-dev case either, going forward.
const DJANGO_API_URL = import.meta.env.VITE_DJANGO_API_URL || ''

const ACCESS_KEY = 'bagalewatch_access_token'
const REFRESH_KEY = 'bagalewatch_refresh_token'

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null // sessionStorage can throw in some locked-down/private-browsing contexts
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    // ignore — falls back to in-memory-only behavior for this session
  }
}

let accessToken: string | null = readStorage(ACCESS_KEY)
let refreshToken: string | null = readStorage(REFRESH_KEY)
let onAuthExpired: (() => void) | null = null

export function setTokens(access: string, refresh: string) {
  accessToken = access
  refreshToken = refresh
  writeStorage(ACCESS_KEY, access)
  writeStorage(REFRESH_KEY, refresh)
}

export function clearTokens() {
  accessToken = null
  refreshToken = null
  writeStorage(ACCESS_KEY, null)
  writeStorage(REFRESH_KEY, null)
}

export function getAccessToken() {
  return accessToken
}

export function getRefreshToken() {
  return refreshToken
}

// AuthContext registers a callback here so the client can force a logout
// when refresh itself fails (refresh token expired / revoked), without
// this module needing to import React or the auth store directly.
export function setOnAuthExpired(cb: (() => void) | null) {
  onAuthExpired = cb
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false
  try {
    const res = await fetch(`${DJANGO_API_URL}/api/v2/auth/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken }),
    })
    if (!res.ok) return false
    const data = await res.json()
    accessToken = data.access
    writeStorage(ACCESS_KEY, accessToken)
    if (data.refresh) {
      refreshToken = data.refresh // ROTATE_REFRESH_TOKENS=True issues a new one each time
      writeStorage(REFRESH_KEY, refreshToken)
    }
    return true
  } catch {
    return false
  }
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    super(`API error ${status}`)
    this.status = status
    this.body = body
  }
}

/** Turns a caught error (ideally an ApiError, but anything is accepted) into
 * a human-readable string, so callers can show the *actual* reason a write
 * failed instead of a guessed-at generic message. DRF error bodies are
 * usually `{field: ["msg", ...]}` for validation errors or `{detail: "msg"}`
 * for permission/not-found errors — this flattens either shape. Falls back
 * to a generic string only if the error truly carries no usable detail
 * (e.g. a network failure before any response came back). */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiError) {
    const body = err.body
    if (body && typeof body === 'object') {
      const parts: string[] = []
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        const text = Array.isArray(value) ? value.join(' ') : String(value)
        parts.push(key === 'detail' || key === 'non_field_errors' ? text : `${key}: ${text}`)
      }
      if (parts.length) return parts.join(' ')
    }
    if (typeof body === 'string' && body) return body
    return `${fallback} (HTTP ${err.status})`
  }
  return fallback
}

/** Fetch wrapper: attaches the bearer token, transparently retries once
 * after a silent refresh on a 401, and gives up (triggering logout) if
 * the refresh itself fails — this is the ENTIRE retry policy, deliberately
 * simple for Phase 1 rather than a generic request-queue/interceptor
 * library the app doesn't need yet. */
export async function apiFetch(path: string, init: RequestInit = {}, _retried = false): Promise<Response> {
  const hadToken = !!accessToken
  const headers = new Headers(init.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${DJANGO_API_URL}${path}`, { ...init, headers })

  // Only treat a 401 as "your session just expired" (force logout/reload)
  // when there was actually a session to expire — i.e. an access token was
  // sent and rejected. A 401 on a request that never had a token to begin
  // with just means "this endpoint requires auth and the caller wasn't
  // logged in," which is a normal, expected outcome (e.g. any authenticated
  // query a pre-login page happens to fire) — NOT a reason to force-navigate
  // anywhere. Confirmed live 2026-08-08: without this guard, an
  // unconditional authenticated query firing on the /login page itself
  // triggered onAuthExpired() -> a hard reload back to /login -> the same
  // query firing again -> an infinite reload loop that looked like the
  // login page flickering. The primary fix is gating that query (see
  // useMenuTree() in queries.ts); this is the defense-in-depth backstop so
  // the same mistake elsewhere can't cause the same loop.
  if (res.status === 401 && !_retried && hadToken) {
    const ok = await refreshAccessToken()
    if (ok) return apiFetch(path, init, true)
    clearTokens()
    onAuthExpired?.()
  }
  return res
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export { DJANGO_API_URL }
