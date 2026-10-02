import { Link } from 'react-router-dom'
import { useLiveSiteSources, useSystemHealth } from '../api/queries'
import { useAuth } from '../auth/AuthContext'
import { OPAQUE_PATHS } from '../constants/opaqueRoutes'

// System Health (2026-10-01, "idea and plan" follow-up to the UTS
// reference screenshots). dtwatch is a monolith, not a microservice mesh
// -- see SystemHealthView's docstring (core/views.py) for why this only
// reports on things Django can itself observe (its own DB connection, the
// Redis instance it already talks to, disk headroom, the one background
// loop with DB-backed state) rather than a literal per-container up/down
// grid like UTS's own page. Live Site Sync's per-source detail is pulled
// from the EXISTING useLiveSiteSources() hook, not duplicated server-side
// here -- that page remains the source of truth for per-source detail,
// this just rolls it up.
//
// A low-disk-space threshold below which the banner reads degraded even
// though nothing is literally "down" yet -- gives early warning before a
// DT/RF-report upload actually fails on a full disk, not just after.
const LOW_DISK_FREE_RATIO = 0.1

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function formatBytes(n: number): string {
  const gb = n / (1024 * 1024 * 1024)
  return `${gb.toFixed(1)} GB`
}

export default function SystemHealthPage() {
  const { user: me } = useAuth()
  const { data: health, isLoading, error, dataUpdatedAt, refetch, isFetching } = useSystemHealth()
  const { data: sources } = useLiveSiteSources()

  if (isLoading) return <div className="page-status">Loading…</div>
  if (error) return <div className="page-status page-status-error">Could not load system health.</div>
  if (!me) return null
  if (me.role !== 'superadmin') {
    return <div className="page-status page-status-error">Only superadmin can view system health.</div>
  }
  if (!health) return null

  const diskUsedRatio = health.disk ? health.disk.used_bytes / health.disk.total_bytes : 0
  const diskLow = health.disk ? health.disk.free_bytes / health.disk.total_bytes < LOW_DISK_FREE_RATIO : false
  const enabledSources = (sources ?? []).filter((s) => s.enabled)
  const failingSources = enabledSources.filter((s) => s.last_error)
  const overallOk = health.database.status === 'ok' && health.redis.status === 'ok' && !diskLow && failingSources.length === 0

  return (
    <div className="admin-page">
      <h1>System Health</h1>
      <p className="muted">
        Live diagnostic snapshot, refreshed every 15 seconds. This app is a single Django service, not a cluster of
        microservices, so this reports on what Django itself can observe — not a per-container uptime grid.
      </p>

      <div className={overallOk ? 'form-success' : 'form-error'} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          Overall status: <strong>{overallOk ? 'Healthy' : 'Degraded'}</strong>
        </span>
        <span style={{ fontSize: 11 }}>
          Checked {formatDate(health.checked_at)}
          {' '}
          <button className="btn-secondary btn-small" onClick={() => refetch()} disabled={isFetching} style={{ marginLeft: 8 }}>
            {isFetching ? 'Refreshing…' : 'Refresh now'}
          </button>
        </span>
      </div>

      <div className="health-card-grid" style={{ marginTop: 16 }}>
        <div className="health-card">
          <div className="health-card-title">Database</div>
          <div className="health-card-value">
            <span className={`report-badge ${health.database.status === 'ok' ? 'report-badge-pass' : 'report-badge-fail'}`}>
              {health.database.status === 'ok' ? 'OK' : 'DOWN'}
            </span>
          </div>
          {health.database.error && <div className="health-card-sub">{health.database.error}</div>}
        </div>

        <div className="health-card">
          <div className="health-card-title">Redis</div>
          <div className="health-card-value">
            <span className={`report-badge ${health.redis.status === 'ok' ? 'report-badge-pass' : 'report-badge-fail'}`}>
              {health.redis.status === 'ok' ? 'OK' : 'DOWN'}
            </span>
          </div>
          {health.redis.error && <div className="health-card-sub">{health.redis.error}</div>}
        </div>

        <div className="health-card">
          <div className="health-card-title">Disk</div>
          {health.disk ? (
            <>
              <div className="health-card-value">{formatBytes(health.disk.free_bytes)} free</div>
              <div className="health-card-sub">{formatBytes(health.disk.used_bytes)} of {formatBytes(health.disk.total_bytes)} used</div>
              <div className="health-disk-bar">
                <div
                  className="health-disk-bar-fill"
                  style={{ width: `${Math.min(100, diskUsedRatio * 100)}%`, background: diskLow ? 'var(--status-danger)' : undefined }}
                />
              </div>
            </>
          ) : (
            <div className="health-card-sub">{health.disk_error ?? 'Unavailable'}</div>
          )}
        </div>

        <div className="health-card">
          <div className="health-card-title">Telemetry roll-up</div>
          <div className="health-card-value" style={{ fontSize: 14 }}>
            {formatDate(health.telemetry_bin_roller.last_rolled_at)}
          </div>
          <div className="health-card-sub">Last coverage-bin roll</div>
        </div>

        <div className="health-card">
          <div className="health-card-title">Version</div>
          <div className="health-card-value" style={{ fontSize: 14 }}>{health.version || '—'}</div>
          <div className="health-card-sub">
            {health.build_tag && <span>{health.build_tag} · </span>}
            {health.git_sha ? health.git_sha.slice(0, 10) : 'no git SHA'}
          </div>
        </div>
      </div>

      <h2>Live Site Sync</h2>
      <div className="health-card">
        {enabledSources.length === 0 ? (
          <span className="muted">No sources configured.</span>
        ) : (
          <>
            <span className={`report-badge ${failingSources.length === 0 ? 'report-badge-pass' : 'report-badge-warn'}`}>
              {enabledSources.length - failingSources.length}/{enabledSources.length} sources healthy
            </span>
            {failingSources.length > 0 && (
              <ul style={{ marginTop: 10, fontSize: 12 }}>
                {failingSources.map((s) => (
                  <li key={s.id}>
                    <strong>{s.name}</strong>: {s.last_error}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div style={{ marginTop: 10 }}>
          <Link to={OPAQUE_PATHS['/live-site-sync']} className="role-assign-link">View Live Site Sync detail →</Link>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 11, marginTop: 20 }}>
        The telemetry-maintenance background loop (monthly partition rollover/retention) has no status model yet and
        isn't represented above.
      </p>
      <p className="muted" style={{ fontSize: 10 }}>Last fetched: {new Date(dataUpdatedAt).toLocaleTimeString()}</p>
    </div>
  )
}
