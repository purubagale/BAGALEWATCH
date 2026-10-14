import { useEffect, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useUpdateDtSessionRetention } from '../api/queries'
import type { DtSessionListItem } from '../api/types'
import { PurposeSelect, purposeLabel } from '../lib/dtPurpose'

// Retention details of one drive-test session (2026-10-14,
// core/dt_retention.py): why it was run, the Keep pin, where its original
// file is kept, and whether old readings were already reduced to 50 m
// squares. Editable by admin and superadmin, like Drive Mode above it.
export default function DtSessionRetentionPanel({ session, canEdit }: { session: DtSessionListItem; canEdit: boolean }) {
  const update = useUpdateDtSessionRetention(session.id)
  const [source, setSource] = useState(session.source_location ?? '')
  useEffect(() => setSource(session.source_location ?? ''), [session.id, session.source_location])

  return (
    <div className="dt-session-remarks">
      <div className="dt-session-remarks-header">
        <h3>Purpose and retention</h3>
      </div>
      {canEdit ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <PurposeSelect value={session.purpose ?? 'other'} onChange={(purpose) => update.mutate({ purpose })} />
          <label title="Old readings of a kept session are never reduced or erased">
            <input
              type="checkbox"
              checked={!!session.keep}
              onChange={(e) => update.mutate({ keep: e.target.checked })}
            />{' '}
            Keep all readings
          </label>
          <input
            type="text"
            value={source}
            placeholder="Where the original file is kept"
            maxLength={255}
            onChange={(e) => setSource(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          {source !== (session.source_location ?? '') && (
            <button type="button" className="btn-primary btn-small" disabled={update.isPending}
              onClick={() => update.mutate({ source_location: source })}>
              Save
            </button>
          )}
        </div>
      ) : (
        <p className="muted">
          {purposeLabel(session.purpose)}{session.keep ? ' · kept' : ''}
          {session.source_location ? ` · original: ${session.source_location}` : ''}
        </p>
      )}
      {!!session.readings_pruned && (
        <p className="muted" style={{ marginTop: 6 }}>
          {session.readings_pruned.toLocaleString()} older readings of this drive were reduced to 50 m squares, where
          newer drives measured the same places. The map shows those squares; the full readings can be restored by
          uploading the original file again.
        </p>
      )}
      {update.isError && <div className="page-status page-status-error">{apiErrorMessage(update.error)}</div>}
    </div>
  )
}
