import { useState } from 'react'
import { useCreateSite } from '../api/queries'
import { apiErrorMessage } from '../api/client'
import type { SiteDetail, SiteWrite } from '../api/types'

// Map-based "add missing site" flow (2026-07-30 request) — triggered by
// clicking the map after toggling a page's "+ Add Site" button. Only
// asks for what's actually needed to place a usable pin (id, name,
// coordinates) plus the tree-placement fields (region/district/city) so
// the new site doesn't just fall into "Unassigned" in both trees;
// everything else (KPIs, sectors, type/tech) is left to the full
// SiteDetailPage edit form, same as any other site — this modal is
// explicitly NOT a duplicate of that page, just the fastest path to get
// a real row into the system with correct coordinates.
export default function AddSiteModal({
  lat,
  lng,
  onClose,
  onCreated,
}: {
  lat: number
  lng: number
  onClose: () => void
  onCreated: (site: SiteDetail) => void
}) {
  const createSite = useCreateSite()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [region, setRegion] = useState('')
  const [district, setDistrict] = useState('')
  const [city, setCity] = useState('')
  const [latVal, setLatVal] = useState(String(lat))
  const [lngVal, setLngVal] = useState(String(lng))
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setError(null)
    if (!id.trim()) {
      setError('Site ID is required.')
      return
    }
    if (!name.trim()) {
      setError('Site name is required.')
      return
    }
    const payload: Partial<SiteWrite> = {
      id: id.trim(),
      name: name.trim(),
      region: region.trim(),
      district: district.trim(),
      city: city.trim(),
      lat: Number(latVal),
      lng: Number(lngVal),
    }
    try {
      const site = await createSite.mutateAsync(payload as SiteWrite)
      onCreated(site)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create this site — check the ID isn’t already in use.'))
    }
  }

  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div className="modal-hdr">
          <h2>+ Add Site Here</h2>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="edit-grid">
            <label>
              Site ID
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. CDR9999" autoFocus />
            </label>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name" />
            </label>
            <label>
              Region
              <input value={region} onChange={(e) => setRegion(e.target.value)} />
            </label>
            <label>
              District
              <input value={district} onChange={(e) => setDistrict(e.target.value)} />
            </label>
            <label>
              City
              <input value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
            <label>
              Latitude
              <input type="number" step="any" value={latVal} onChange={(e) => setLatVal(e.target.value)} />
            </label>
            <label>
              Longitude
              <input type="number" step="any" value={lngVal} onChange={(e) => setLngVal(e.target.value)} />
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary btn-small" onClick={onClose} disabled={createSite.isPending}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-small" onClick={handleSave} disabled={createSite.isPending}>
            {createSite.isPending ? 'Saving…' : 'Add Site'}
          </button>
        </div>
      </div>
    </div>
  )
}
