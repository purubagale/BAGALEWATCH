import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useRefreshAlarms, useSiteActiveAlarms } from '../api/queries'

// "Active alarms" for one site (2026-10-26, core/alarms.py): a button that
// shows the site's live alarm count once the list is loaded, and a window
// with the alarms from NTC's alarm middleware. Nothing is stored; the server
// keeps the whole list for a minute and Refresh asks the service again.

const SEV_CLASS: Record<string, string> = { Critical: 'crit', Major: 'major', Minor: 'minor', Warning: 'warn' }

export default function ActiveAlarmsButton({ siteId, siteName, small }: { siteId: string; siteName?: string | null; small?: boolean }) {
  const [open, setOpen] = useState(false)
  const q = useSiteActiveAlarms(siteId, true)
  const refresh = useRefreshAlarms()
  const d = q.data
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (d && !d.configured) return null
  const n = d?.alarms.length ?? 0
  return (
    <>
      <button type="button" className={`${small ? 'btn-small ' : ''}${n ? 'btn-alarm-on' : 'btn-secondary'}`}
        onClick={() => setOpen(true)} title="Live alarms from the alarm system">
        🚨 Active alarms{d ? ` (${n})` : ''}
      </button>
      {open && (
        <div className="pdd-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div className="pdd-modal alarm-modal" role="dialog" aria-modal="true" aria-label="Active alarms">
            <div className="pdd-modal-head">
              <div>
                <b>🚨 Active alarms · {siteName && siteName.toUpperCase().startsWith(siteId.toUpperCase()) ? siteName
                  : `${siteId}${siteName ? ` · ${siteName}` : ''}`}</b>
                <div className="muted pdd-small">
                  Live from the alarm system{d?.fetched_at ? ` · fetched ${new Date(d.fetched_at).toLocaleString()}` : ''}
                </div>
              </div>
              <button type="button" className="btn-secondary btn-small" onClick={() => setOpen(false)}>Close</button>
            </div>
            <div className="alarm-modal-body">
              {q.isLoading ? <p className="muted">Asking the alarm system…</p>
                : q.error ? <p className="error">{apiErrorMessage(q.error)}</p>
                  : d?.error ? <p className="error">{d.error}</p>
                    : n === 0 ? <p className="muted">No active alarms on this site.</p> : (
                      <table className="admin-table" data-pager="off">
                        <thead><tr><th>Severity</th><th>Alarm</th><th>Device</th><th>NE type</th><th>Occurred</th></tr></thead>
                        <tbody>
                          {d!.alarms.map((a) => (
                            <tr key={`${a.id}-${a.csn}`}>
                              <td><span className={`alarm-sev alarm-sev-${SEV_CLASS[a.severity] ?? 'other'}`}>{a.severity || '-'}</span></td>
                              <td>{a.alarm}</td>
                              <td className="mono">{a.device}</td>
                              <td>{a.ne_type || '-'}</td>
                              <td>{a.occurred_at ? new Date(a.occurred_at).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
              {refresh.error && <p className="error">{apiErrorMessage(refresh.error)}</p>}
            </div>
            <div className="alarm-modal-foot">
              <span className="muted pdd-small">{n} active alarm{n === 1 ? '' : 's'}</span>
              <button type="button" className="btn-secondary btn-small" disabled={refresh.isPending} onClick={() => refresh.mutate(siteId)}>
                {refresh.isPending ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
