import { useState } from 'react'
import { useRelocateSite } from '../api/queries'
import { apiErrorMessage } from '../api/client'

// Drag-to-relocate confirmation (2026-07-30 request, "confirm before
// saving" per AskUserQuestion) — a dragged marker's position is NOT
// saved on drop; the caller reverts the marker to `oldLat`/`oldLng`
// immediately and shows this modal instead. Only on explicit Save does
// the new position get persisted (via PATCH — see useRelocateSite's
// comment on why not the existing PUT-based useUpdateSite) and the
// caller move the marker for real. Cancel just closes this with no
// network call at all, since the marker was already reverted visually
// before this modal ever appeared.
export default function RelocateConfirmModal({
  siteId,
  siteName,
  oldLat,
  oldLng,
  newLat,
  newLng,
  onCancel,
  onConfirmed,
}: {
  siteId: string
  siteName: string
  oldLat: number
  oldLng: number
  newLat: number
  newLng: number
  onCancel: () => void
  onConfirmed: (lat: number, lng: number) => void
}) {
  const relocate = useRelocateSite(siteId)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setError(null)
    try {
      await relocate.mutateAsync({ lat: newLat, lng: newLng })
      onConfirmed(newLat, newLng)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the new location.'))
    }
  }

  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 400 }}>
        <div className="modal-hdr">
          <h2>Move {siteName || siteId}?</h2>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="dt-dup-card">
            <div className="dt-dup-card-label">Current Location</div>
            <div className="dt-dup-card-sub">
              {oldLat.toFixed(6)}, {oldLng.toFixed(6)}
            </div>
          </div>
          <div className="dt-dup-card">
            <div className="dt-dup-card-label" style={{ color: '#eab308' }}>New Location</div>
            <div className="dt-dup-card-sub">
              {newLat.toFixed(6)}, {newLng.toFixed(6)}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary btn-small" onClick={onCancel} disabled={relocate.isPending}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-small" onClick={handleSave} disabled={relocate.isPending}>
            {relocate.isPending ? 'Saving…' : 'Save New Location'}
          </button>
        </div>
      </div>
    </div>
  )
}
