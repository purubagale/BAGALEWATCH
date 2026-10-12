import { useState } from 'react'
import { MapContainer, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useSitePhotos } from '../api/queries'
import CurrentLocationMarker from '../components/CurrentLocationMarker'
import SitePhotoCard from '../components/SitePhotoCard'
import SitePhotoLayer from '../components/SitePhotoLayer'

// Site Photos (2026-10-11) -- the review page for photos staff take with
// the mobile app, at sites and along drive tests. A photo is shown on the
// site page and on the maps only after it is approved here. Admin and
// superadmin.
//
// Two views (2026-10-12): the cards, for reviewing, and a map of every
// approved photo with the direction it faces.

type StatusFilter = 'pending' | 'approved' | 'rejected'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

const NEPAL_CENTER: [number, number] = [28.3949, 84.124]

export default function SitePhotosPage() {
  const [view, setView] = useState<'cards' | 'map'>('cards')
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
        Photos taken with the mobile app, at sites and along drive tests. Each one records where the phone was and
        which way it pointed, so the real direction of a sector can be compared with its planned azimuth. A new photo
        is shown on the site's page and on the maps only after it is approved here. A phone compass is usually within
        5 to 15 degrees and can be further off beside a steel tower, so treat the direction as approximate.
      </p>

      <div className="site-photo-view-toggle">
        <button
          type="button"
          className={view === 'cards' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
          onClick={() => setView('cards')}
        >
          Review list
        </button>
        <button
          type="button"
          className={view === 'map' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
          onClick={() => setView('map')}
        >
          Map of approved photos
        </button>
      </div>

      {view === 'map' && (
        <>
          <div className="site-photo-map">
            <MapContainer center={NEPAL_CENTER} zoom={7} style={{ height: '100%', width: '100%' }}>
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <CurrentLocationMarker />
              <SitePhotoLayer />
            </MapContainer>
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Each camera marker is one approved photo; its arrow shows the direction the phone faced. Click a marker
            to see the picture. The map shows the photos in the area on screen.
          </p>
        </>
      )}

      {view === 'cards' && (
        <>
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
        </>
      )}
    </div>
  )
}
