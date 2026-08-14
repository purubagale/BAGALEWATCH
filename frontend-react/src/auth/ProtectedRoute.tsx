import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

/** Route-level guard driven by whether a user is logged in. Per-menu
 * permission gating (via Me.permissions, in the same shape the v1 client
 * already uses — see api/types.ts's isAllowed()) is applied inside
 * individual pages/nav items rather than here, since "not permitted"
 * and "not logged in" should read differently to the user. */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, restoring } = useAuth()
  // While a post-reload session restore is in flight (see AuthContext's
  // /api/v2/auth/me/ check), `user` is still null on the very first render —
  // don't redirect to /login yet or every refresh would bounce a valid
  // session back to the login screen before the restore call resolves.
  if (restoring) return null
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}
