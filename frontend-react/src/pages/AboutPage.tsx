import { useHealth } from '../api/queries'
import { APP_VERSION, BUILD_TAG, GIT_SHA } from '../lib/version'

/**
 * About / build info (2026-08-23, "show version it in DT Watch BTS" + "may be
 * we put about page too").
 *
 * Deliberately behind ProtectedRoute rather than public: a version number is
 * mild, but a git SHA plus an exact build tag tells an unauthenticated visitor
 * precisely which commit is deployed, which is a free head start for anyone
 * matching it against known issues. The login page therefore shows only the
 * version as plain text, and just the in-app sidebar chip links here.
 *
 * Frontend and backend versions come from two different mechanisms on purpose
 * — Vite inlines the frontend's at build time, Django reads its own from the
 * environment at runtime — so a mismatch is real information: it means one
 * image was redeployed without the other, which is exactly the state that
 * makes bug reports confusing.
 */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="about-row">
      <span className="about-label">{label}</span>
      <span className={mono ? 'about-value about-value-mono' : 'about-value'}>{value || '—'}</span>
    </div>
  )
}

export default function AboutPage() {
  const { data: health, isLoading, error } = useHealth()

  const backendVersion = health?.version || ''
  // Only claim a mismatch when BOTH sides reported something. A missing
  // backend version means "not deployed with one yet", not "they disagree" —
  // warning on an unknown would train people to ignore the warning.
  const versionsKnown = APP_VERSION !== 'dev' && !!backendVersion
  const mismatch = versionsKnown && APP_VERSION !== backendVersion

  return (
    <div className="admin-page about-page">
      <h1>About</h1>
      <p className="muted">
        DT-WATCH BTS v2 — Nepal Telecom 4G RAN operations &amp; maintenance.
      </p>

      {mismatch && (
        <div className="about-warn">
          Frontend and backend are running different versions ({APP_VERSION} vs{' '}
          {backendVersion}). One service was likely redeployed without the other.
        </div>
      )}

      <h2>This build</h2>
      <div className="about-card">
        <Row label="Frontend version" value={APP_VERSION} mono />
        <Row label="Build tag" value={BUILD_TAG} mono />
        <Row label="Git commit" value={GIT_SHA} mono />
      </div>

      <h2>Backend</h2>
      <div className="about-card">
        {isLoading && <div className="about-value">Checking…</div>}
        {error && <div className="about-warn">Could not reach the API to read its version.</div>}
        {health && (
          <>
            <Row label="Backend version" value={backendVersion} mono />
            <Row label="Build tag" value={health.build_tag || ''} mono />
            <Row label="Git commit" value={health.git_sha || ''} mono />
            <Row label="Service" value={health.service} mono />
            <Row label="Status" value={health.status} />
            <Row label="Database" value={health.database} />
          </>
        )}
      </div>

      {APP_VERSION === 'dev' && (
        <p className="muted about-dev-note">
          This bundle reports <code>dev</code>, meaning it was built with a plain{' '}
          <code>docker compose build</code> rather than through <code>build-push.sh</code>,
          so it carries no release version.
        </p>
      )}
    </div>
  )
}
