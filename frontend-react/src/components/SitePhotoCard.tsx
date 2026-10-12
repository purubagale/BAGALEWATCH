import { useEffect, useState } from 'react'
import { apiErrorMessage, apiFetch } from '../api/client'
import { useDeleteSitePhoto, useReviewSitePhoto } from '../api/queries'
import type { SitePhoto } from '../api/types'

// One site photo from the mobile app (2026-10-11): the picture, the
// direction the phone pointed, and how far that is from the planned
// azimuth. Used by the site page (approved photos) and the Site Photos
// review page (all of them, with approve / reject / delete).

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export function compassPoint(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

// The picture needs the login token, so it cannot be a plain <img src>.
// The card shows the small copy, fetched once and held as an object URL
// that is released on unmount. The full picture is fetched only when the
// card is clicked, so a page of photos stays light.
export function PhotoImage({ id, alt }: { id: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [opening, setOpening] = useState(false)

  const openFull = async () => {
    if (opening) return
    setOpening(true)
    try {
      const res = await apiFetch(`/api/v2/site-photos/${id}/image/`)
      if (!res.ok) throw new Error('not ok')
      const fullUrl = URL.createObjectURL(await res.blob())
      window.open(fullUrl, '_blank', 'noopener')
      // Long enough for the new tab to load it, then let the memory go.
      window.setTimeout(() => URL.revokeObjectURL(fullUrl), 60_000)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    apiFetch(`/api/v2/site-photos/${id}/image/?size=thumb`)
      .then(async (res) => {
        if (!res.ok) throw new Error('not ok')
        objectUrl = URL.createObjectURL(await res.blob())
        if (cancelled) URL.revokeObjectURL(objectUrl)
        else setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])

  if (failed) return <div className="site-photo-image site-photo-image-empty">Picture not available</div>
  if (!url) return <div className="site-photo-image site-photo-image-empty">Loading…</div>
  return (
    <button type="button" className="site-photo-open" onClick={openFull} title="Open full size">
      <img className="site-photo-image" src={url} alt={alt} />
    </button>
  )
}

function signalText(signal: SitePhoto['signal']): string {
  const parts: string[] = []
  if (signal.network_type) parts.push(String(signal.network_type))
  if (signal.rsrp != null) parts.push(`RSRP ${signal.rsrp} dBm`)
  if (signal.rsrq != null) parts.push(`RSRQ ${signal.rsrq} dB`)
  if (signal.sinr != null) parts.push(`SINR ${signal.sinr} dB`)
  if (signal.pci != null) parts.push(`PCI ${signal.pci}`)
  return parts.join(' · ')
}

export default function SitePhotoCard({
  photo,
  canReview,
  showSite = false,
}: {
  photo: SitePhoto
  canReview: boolean
  showSite?: boolean
}) {
  const review = useReviewSitePhoto()
  const remove = useDeleteSitePhoto()
  const [error, setError] = useState('')
  const busy = review.isPending || remove.isPending

  const run = async (work: () => Promise<unknown>) => {
    setError('')
    try {
      await work()
    } catch (err) {
      setError(apiErrorMessage(err))
    }
  }

  const diff = photo.azimuth_difference
  const flagged = diff != null && diff > photo.azimuth_flag_deg
  const signal = signalText(photo.signal)

  return (
    <div className="site-photo-card">
      <PhotoImage id={photo.id} alt={`Site ${photo.site_id}, facing ${Math.round(photo.bearing_deg)}°`} />
      <div className="site-photo-body">
        {showSite && (
          <div className="site-photo-title">
            {photo.site_id || 'Drive-test photo'}
            {photo.site_name ? ` · ${photo.site_name}` : ''}
          </div>
        )}
        <div className="site-photo-bearing">
          Facing {Math.round(photo.bearing_deg)}° {compassPoint(photo.bearing_deg)}
          {photo.status !== 'approved' && (
            <span className={`site-photo-status site-photo-status-${photo.status}`}>{photo.status}</span>
          )}
        </div>
        {photo.planned_azimuth != null ? (
          <div className={flagged ? 'site-photo-diff site-photo-diff-flag' : 'site-photo-diff'}>
            Planned {Math.round(photo.planned_azimuth)}°
            {photo.sector_label ? ` (${photo.sector_label})` : ''} · difference {diff}°
            {flagged ? ' — check this sector' : ''}
          </div>
        ) : (
          <div className="site-photo-diff">
            {photo.drive_session_id ? 'Taken during a drive test' : 'No planned direction chosen'}
          </div>
        )}
        <div className="muted">
          {new Date(photo.taken_at).toLocaleString()}
          {photo.distance_to_site_m != null ? ` · ${Math.round(photo.distance_to_site_m)} m from site` : ''}
          {photo.altitude_m != null ? ` · altitude ${Math.round(photo.altitude_m)} m` : ''}
        </div>
        <div className="muted">
          {photo.lat.toFixed(6)}, {photo.lng.toFixed(6)}
          {photo.accuracy_m != null ? ` (±${Math.round(photo.accuracy_m)} m)` : ''}
        </div>
        {signal && <div className="muted">{signal}</div>}
        {photo.note && <div className="site-photo-note">{photo.note}</div>}
        {canReview && (
          <>
            <div className="muted">
              Sent from a phone ending {photo.uploader || 'unknown'}
              {photo.reviewed_by ? ` · reviewed by ${photo.reviewed_by}` : ''}
            </div>
            <div className="site-photo-actions">
              {photo.status !== 'approved' && (
                <button
                  type="button"
                  className="btn-primary btn-small"
                  disabled={busy}
                  onClick={() => run(() => review.mutateAsync({ id: photo.id, action: 'approve' }))}
                >
                  Approve
                </button>
              )}
              {photo.status !== 'rejected' && (
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  disabled={busy}
                  onClick={() => run(() => review.mutateAsync({ id: photo.id, action: 'reject' }))}
                >
                  Reject
                </button>
              )}
              <button
                type="button"
                className="btn-danger btn-small"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this photo? This cannot be undone.')) {
                    run(() => remove.mutateAsync(photo.id))
                  }
                }}
              >
                Delete
              </button>
            </div>
          </>
        )}
        {error && <div className="page-status page-status-error">{error}</div>}
      </div>
    </div>
  )
}
