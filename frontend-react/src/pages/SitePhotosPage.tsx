import { useState } from 'react'
import { useSitePhotos } from '../api/queries'
import SitePhotoCard from '../components/SitePhotoCard'

// Site Photos (2026-10-11) -- the review page for photos staff take at
// sites with the mobile app. A photo is shown on its site's page only
// after it is approved here. Admin and superadmin.

type StatusFilter = 'pending' | 'approved' | 'rejected'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

export default function SitePhotosPage() {
  const [status, setStatus] = useState<StatusFilter>('pending')
  const [site, setSite] = useState('')
  // One page at a time, so a long queue never loads every picture at once.
  const [offset, setOffset] = useState(0)
  const { data, isLoading, error } = useSitePhotos({ status, site: site.trim() || undefined, offset })
  const photos = data?.photos ?? []
  const total = data?.total ?? 0
  const pageSize = data?.page_size ?? 60

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Site Photos</h1>
      <p className="muted">
        Photos taken at sites with the mobile app. Each one records where the phone was and which way it pointed, so
        the real direction of a sector can be compared with its planned azimuth. A new photo is shown on the site's
        page only after it is approved here. A phone compass is usually within 5 to 15 degrees and can be further off
        beside a steel tower, so treat the direction as approximate.
      </p>

      <div className="dt-metric-tabs">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`dt-metric-tab${f.key === status ? ' active' : ''}`}
            onClick={() => {
              setStatus(f.key)
              setOffset(0)
            }}
          >
            {f.label}
            {f.key === 'pending' && data?.pending_count ? ` (${data.pending_count})` : ''}
          </button>
        ))}
      </div>

      <div className="edit-grid" style={{ gridTemplateColumns: 'minmax(160px, 260px)', margin: '12px 0' }}>
        <label>
          Site ID
          <input
            value={site}
            onChange={(e) => {
              setSite(e.target.value)
              setOffset(0)
            }}
            placeholder="All sites"
          />
        </label>
      </div>

      {isLoading && <div className="page-status">Loading photos…</div>}
      {error && <div className="page-status page-status-error">Could not load the photos.</div>}
      {!isLoading && !error && photos.length === 0 && (
        <div className="page-status">
          {status === 'pending' ? 'No photos are waiting for review.' : `No ${status} photos.`}
        </div>
      )}
      <div className="site-photo-grid">
        {photos.map((photo) => (
          <SitePhotoCard key={photo.id} photo={photo} canReview showSite />
        ))}
      </div>

      {total > pageSize && (
        <div className="site-photo-actions" style={{ alignItems: 'center' }}>
          <button
            type="button"
            className="btn-secondary btn-small"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Previous
          </button>
          <span className="muted">
            {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
          </span>
          <button
            type="button"
            className="btn-secondary btn-small"
            disabled={offset + pageSize >= total}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
