import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useDeleteSite, useSite, useUpdateSite } from '../api/queries'
import { isAllowed } from '../api/types'
import type { Sector, SectorWrite, SiteDetail, SiteWrite } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { SITES_PATH } from '../constants/opaqueRoutes'
import { useSearchModal } from '../contexts/SearchModalContext'
import SiteLocationMiniMap from '../components/SiteLocationMiniMap'
import { STATUS_COLOR, STATUS_LABELS } from '../lib/statusColor'

const KPI_FIELDS: [keyof SiteWrite, string][] = [
  ['rrc', 'RRC Setup SR (%)'],
  ['erab', 'E-RAB SR (%)'],
  ['call_setup', 'Call Setup SR (%)'],
  ['call_drop', 'Call Drop Rate (%)'],
  ['svc_drop', 'Service Drop (%)'],
  ['intra_ho', 'Intra-freq HO SR (%)'],
  ['inter_ho', 'Inter-freq HO SR (%)'],
  ['inter_rat', 'Inter-RAT HO SR (%)'],
  ['ip_thru_dl', 'IP Throughput DL (Mbps)'],
  ['ip_thru_ul', 'IP Throughput UL (Mbps)'],
  ['ip_lat', 'IP Latency (ms)'],
  ['prb_dl', 'PRB Utilization DL (%)'],
  ['prb_ul', 'PRB Utilization UL (%)'],
  ['cell_avail', 'Cell Availability (%)'],
  ['volte_setup', 'VoLTE Setup SR (%)'],
  ['csfb', 'CSFB SR (%)'],
]

// 3G/2G field keys + labels — ported from v1's THRESHOLDS_3G/THRESHOLDS_2G
// (bts_monitor.html's Edit Site modal, ~lines 883-908: es3g-*/es2g-* input
// ids). These are the exact JSON keys v1 has always stored inside
// kpi_3g_json/kpi_2g_json — matched here rather than invented, since
// seed_legacy_data.py copies those blobs from the real v1 database as-is
// (see core/models.py's Site.kpi_3g_json/kpi_2g_json comment). v2's
// backend already stores and returns these fields (SiteDetailSerializer
// uses fields = '__all__'); no UI ever read or wrote them until now
// (2026-08-08, "beautiful gui for site details and sector details").
const KPI_3G_FIELDS: [string, string][] = [
  ['rrcSR', 'RRC Setup SR (%)'],
  ['rabSR', 'RAB Setup SR (%)'],
  ['callDropRate', 'CS Call Drop Rate (%)'],
  ['softHoSR', 'Soft HO SR (%)'],
  ['cellAvail', 'Cell Availability (%)'],
  ['psThroughput', 'PS DL Throughput (Mbps)'],
  ['congestion', 'Channel Congestion (%)'],
]

const KPI_2G_FIELDS: [string, string][] = [
  ['sdcchSR', 'SDCCH Success Rate (%)'],
  ['tchSR', 'TCH Assignment SR (%)'],
  ['callDropRate', 'TCH Call Drop Rate (%)'],
  ['hoSR', 'Handover SR (%)'],
  ['tchCongestion', 'TCH Congestion (%)'],
  ['sdcchCongestion', 'SDCCH Congestion (%)'],
  ['cellAvail', 'Cell Availability (%)'],
]

type KpiTech = '4G' | '3G' | '2G'

const SECTOR_COLUMNS: [keyof SectorWrite, string][] = [
  ['cell_name', 'Cell Name'],
  ['sector', 'Sector'],
  ['tech', 'Tech'],
  ['local_cell_id', 'Local Cell ID'],
  ['azimuth', 'Azimuth'],
  ['mech_tilt', 'Mech Tilt'],
  ['elec_tilt', 'Elec Tilt'],
  ['pci', 'PCI'],
  // Optional per-sector GPS override (2026-08-09) — blank means "same
  // location as the site" (the common case); only fill these in for a
  // sector whose equipment genuinely sits at a different real GPS point
  // (e.g. a later expansion cabinet), never a guess. Numeric like every
  // other column here, so normalizeForSave()'s toNum() loop below handles
  // them for free — no special-casing needed there.
  ['lat', 'Lat (optional override)'],
  ['lng', 'Lng (optional override)'],
  // Real columns from the user's own 3G/2G source files (2026-08-09,
  // "need to store all those data also") — plain text, not numeric, so
  // they're also listed in NON_NUMERIC_SECTOR_KEYS below so
  // normalizeForSave() doesn't try to coerce them into a number.
  ['carrier', 'Carrier'],
  ['site_band', 'Site Band'],
  ['cell_active_status', 'Cell Active Status'],
  ['site_existence', 'Site Existence'],
]

const NON_NUMERIC_SECTOR_KEYS: (keyof SectorWrite)[] = [
  'cell_name', 'sector', 'tech', 'kpi_date',
  'carrier', 'site_band', 'cell_active_status', 'site_existence',
]

function toNum(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const emptySector: SectorWrite = {
  cell_name: '', sector: '', tech: '', local_cell_id: null,
  height: null, azimuth: null, mech_tilt: null, elec_tilt: null,
  pci: null, scrambling_code: null, bcch: null, bsic: null,
  kpi_json: null, kpi_date: '', lat: null, lng: null,
  carrier: '', site_band: '', cell_active_status: '', site_existence: '',
}

function siteToWrite(site: SiteDetail): SiteWrite {
  const { sectors, updated_at: _updated_at, ...rest } = site
  return { ...rest, sectors: sectors.map(({ id: _id, ...s }) => s) }
}

// Tech badge color class — mirrors v1's _techBadge() (bts_monitor.html
// ~3664): 2G and 3G get their own color, everything else (4G, 5G, blank)
// falls back to the same green as 4G. Sector.tech is free text (not an
// enum) in this schema, so this is intentionally permissive rather than
// only recognizing an exact "4G" match.
function techBadgeClass(tech: string): string {
  const t = (tech || '').toUpperCase()
  if (t === '2G') return 'tech-2g'
  if (t === '3G') return 'tech-3g'
  return 'tech-4g'
}

// Which identifier a sector's Tech actually uses — 4G identifies a cell
// by PCI, 3G by Scrambling Code, 2G by BCCH+BSIC. Ported from v1's
// _sectorIdLabel() (bts_monitor.html ~3672) so the sector table shows
// whichever one actually applies instead of a single PCI-only column.
// Sidebar "Sectors" quick-stat, e.g. "2× 4G, 1× 3G" — plain tech-name
// tally, no fabricated data, just a count of what's already in
// site.sectors grouped by their own tech field.
function summarizeSectorTechs(sectors: Sector[]): string {
  const counts = new Map<string, number>()
  for (const s of sectors) {
    const t = (s.tech || '4G').toUpperCase()
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()].map(([t, n]) => `${n}× ${t}`).join(', ')
}

function sectorIdLabel(sec: Sector | SectorWrite): string {
  const tech = (sec.tech || '4G').toUpperCase()
  if (tech === '2G') {
    const bcch = sec.bcch != null ? `BCCH ${sec.bcch}` : null
    const bsic = sec.bsic != null ? `BSIC ${sec.bsic}` : null
    return [bcch, bsic].filter(Boolean).join(' / ') || '—'
  }
  if (tech === '3G') return sec.scrambling_code != null ? `SC ${sec.scrambling_code}` : '—'
  return sec.pci != null ? `PCI ${sec.pci}` : '—'
}

/** One [label / input-or-value] card, shared by the Site Identity grid
 * and every KPI tab — matches v1's `.f-group` (label above field).
 * `hint` (2026-08-26) is shown only in the readOnly+editing state — used
 * by the Live Site Directory-managed identity fields below to explain
 * WHY they're locked, not just that they are (see SITE_ID's own "Site
 * ID" readOnly usage, which needed no explanation since a primary key
 * being immutable is self-evident; these fields aren't). */
function FieldCard({
  label, editing, value, onChange, readOnly, type = 'text', hint,
}: {
  label: string
  editing: boolean
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  type?: 'text' | 'number'
  hint?: string
}) {
  return (
    <div className="site-form-group">
      <span className="site-form-label">{label}</span>
      {editing && !readOnly ? (
        <input
          type={type}
          step={type === 'number' ? 'any' : undefined}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : editing && readOnly ? (
        <>
          <input type={type} value={value} readOnly title={hint} />
          {hint && <span className="muted" style={{ fontSize: 10, display: 'block', marginTop: 2 }}>{hint}</span>}
        </>
      ) : (
        <span className="site-form-value">{value === '' ? '—' : value}</span>
      )}
    </div>
  )
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { openSearch } = useSearchModal()
  const [searchParams, setSearchParams] = useSearchParams()
  // Set by AdvancedSiteSearchModal's openSite() when a result row is
  // clicked (2026-08-07 request: "when click on back to site ... it
  // redirects to the previous page from where it was opened"). A URL
  // param rather than router location.state so it survives a refresh —
  // same convention this page already uses for `?edit=1`/`?addSector=1`
  // below. Deliberately NOT stripped after use (unlike those two): it's
  // harmless to keep showing "← Back to search results" for as long as
  // this tab is on this exact site URL, and stripping it would mean a
  // page refresh silently reverting to "← Back to sites" instead.
  const fromSearch = searchParams.get('fromSearch') === '1'
  const { data: site, isLoading, error } = useSite(id)
  const updateSite = useUpdateSite(id || '')
  const deleteSite = useDeleteSite()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<SiteWrite | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [kpiTech, setKpiTech] = useState<KpiTech>('4G')
  const sectorsSectionRef = useRef<HTMLElement>(null)

  // Tree row shortcut icons (2026-07-30, Sites page) navigate here with
  // ?edit=1 or ?addSector=1 instead of duplicating this page's own
  // edit/add-sector UI as a second implementation inline in the tree —
  // this just auto-triggers the equivalent of clicking Edit (and, for
  // add-sector, also pre-appending one empty sector row + scrolling to
  // it) once the site has loaded, then strips the param so a refresh or
  // back-navigation doesn't re-trigger it. Above the early returns below
  // deliberately — hooks must run unconditionally on every render.
  useEffect(() => {
    if (!site || editing) return
    const wantsEdit = searchParams.get('edit') === '1'
    const wantsAddSector = searchParams.get('addSector') === '1'
    if (!wantsEdit && !wantsAddSector) return

    const base = siteToWrite(site)
    setDraft(wantsAddSector ? { ...base, sectors: [...base.sectors, { ...emptySector }] } : base)
    setSaveError(null)
    setEditing(true)

    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    next.delete('addSector')
    setSearchParams(next, { replace: true })

    if (wantsAddSector) {
      requestAnimationFrame(() => sectorsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
    // Deliberately omitting `editing`/`setSearchParams` from deps — this
    // should only re-evaluate when the site loads or the URL's query
    // actually changes, not on every edit-mode toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, searchParams])

  if (isLoading) return <div className="page-status">Loading site…</div>
  if (error) return <div className="page-status page-status-error">Could not load this site.</div>
  if (!site) return null

  // 'sites' is a CRUD_MENUS entry (see core/serializers.py) — 'update'
  // and 'delete' are tracked as separate grants, so the Edit and Delete
  // buttons are gated independently rather than both hiding behind one
  // combined "canWrite" check.
  const canUpdate = !!user && isAllowed(user.role, user.permissions.sites, 'update')
  const canDelete = !!user && isAllowed(user.role, user.permissions.sites, 'delete')

  function startEdit() {
    if (!site) return
    setDraft(siteToWrite(site))
    setSaveError(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setDraft(null)
    setSaveError(null)
  }

  function setField<K extends keyof SiteWrite>(key: K, value: SiteWrite[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
  }

  // Separate from setField() deliberately: the KPI fields are iterated
  // from an array (KPI_FIELDS), so their key's specific literal type is
  // erased to the union `keyof SiteDetail` — trying to route that through
  // setField()'s generic would need an `as` escape hatch at the call site
  // to satisfy SiteWrite[K].
  //
  // Stores the RAW STRING, not Number(raw) — found live 2026-07-27:
  // coercing to a number on every keystroke breaks typing any decimal.
  // An in-progress value like "0." parses to 0, and re-rendering the
  // controlled input with value=0 immediately strips the trailing "."
  // before the next digit can land, so "0.6" always ended up as "06" ->
  // 6. The string sits in the (mistyped-as-number) draft field until
  // handleSave() runs it through toNum() right before the API call.
  function setNumberField(key: keyof SiteWrite, raw: string) {
    setDraft((d) => (d ? { ...d, [key]: raw as unknown as SiteWrite[typeof key] } : d))
  }

  // Same raw-string-until-save pattern as setNumberField, for the 3G/2G
  // JSON-blob fields — draft.kpi_3g_json/kpi_2g_json hold plain strings
  // while editing (normalizeForSave converts to numbers at save time).
  function setTechKpiField(tech: '3g' | '2g', key: string, raw: string) {
    setDraft((d) => {
      if (!d) return d
      const field = tech === '3g' ? 'kpi_3g_json' : 'kpi_2g_json'
      const current = (d[field] as Record<string, unknown> | null) ?? {}
      return { ...d, [field]: { ...current, [key]: raw } }
    })
  }

  function setSectorField(index: number, key: keyof SectorWrite, raw: string) {
    setDraft((d) => {
      if (!d) return d
      const sectors = [...d.sectors]
      // Same raw-string-until-save fix as setNumberField above, for the
      // same reason (numeric sector columns: local_cell_id, azimuth,
      // mech_tilt, elec_tilt, pci — mech/elec tilt are the ones that
      // actually take decimals, which is what surfaced this).
      sectors[index] = { ...sectors[index], [key]: raw as unknown as SectorWrite[typeof key] }
      return { ...d, sectors }
    })
  }

  function addSector() {
    setDraft((d) => (d ? { ...d, sectors: [...d.sectors, { ...emptySector }] } : d))
  }

  function removeSector(index: number) {
    setDraft((d) => (d ? { ...d, sectors: d.sectors.filter((_, i) => i !== index) } : d))
  }

  // Runs once at save time — converts the raw strings setNumberField()/
  // setTechKpiField()/setSectorField() stashed in these fields (see their
  // comments) into actual numbers (or null), so the payload sent to the
  // API matches SiteWrite's real shape. Also computes kpi_entered/
  // kpi_entered_2g/kpi_entered_3g the same way v1's saveEditSite() does
  // (bts_monitor.html ~4402): true if this save just entered a real value
  // OR it was already true — never flips back to false just because this
  // particular save didn't touch that tech's fields.
  function normalizeForSave(d: SiteWrite): SiteWrite {
    const normalized: SiteWrite = { ...d, lat: toNum(d.lat), lng: toNum(d.lng) }
    let any4g = false
    for (const [key] of KPI_FIELDS) {
      const v = toNum((d as Record<string, unknown>)[key])
      ;(normalized as Record<string, unknown>)[key] = v
      if (v !== null) any4g = true
    }
    normalized.kpi_entered = any4g || d.kpi_entered

    function normalizeTechJson(fields: [string, string][], raw: Record<string, unknown> | null | undefined) {
      const out: Record<string, number> = {}
      let any = false
      for (const [key] of fields) {
        const v = toNum(raw?.[key])
        if (v !== null) { out[key] = v; any = true }
      }
      return { json: Object.keys(out).length ? out : null, any }
    }

    const g3 = normalizeTechJson(KPI_3G_FIELDS, d.kpi_3g_json)
    normalized.kpi_3g_json = g3.json
    normalized.kpi_entered_3g = g3.any || d.kpi_entered_3g

    const g2 = normalizeTechJson(KPI_2G_FIELDS, d.kpi_2g_json)
    normalized.kpi_2g_json = g2.json
    normalized.kpi_entered_2g = g2.any || d.kpi_entered_2g

    normalized.sectors = d.sectors.map((sec) => {
      const normalizedSec = { ...sec }
      for (const [key] of SECTOR_COLUMNS) {
        if (NON_NUMERIC_SECTOR_KEYS.includes(key)) continue
        ;(normalizedSec as Record<string, unknown>)[key] = toNum((sec as Record<string, unknown>)[key])
      }
      return normalizedSec
    })
    return normalized
  }

  async function handleSave() {
    if (!draft) return
    setSaveError(null)
    try {
      await updateSite.mutateAsync(normalizeForSave(draft))
      setEditing(false)
      setDraft(null)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save changes.'))
    }
  }

  async function handleDelete() {
    if (!site) return
    if (!window.confirm(`Delete site ${site.id}? This also deletes its ${site.sectors.length} sector(s). This cannot be undone.`)) return
    await deleteSite.mutateAsync(site.id)
    navigate(SITES_PATH)
  }

  const identitySource = editing && draft ? draft : site
  const realSectors = (editing ? draft?.sectors : site.sectors) ?? []

  return (
    <div className="site-detail-page">
      {fromSearch ? (
        <button
          type="button"
          className="back-link back-link-btn"
          onClick={() => {
            // 2026-08-08 fix: this used to only call openSearch(), which
            // re-shows the modal but leaves this exact detail page
            // mounted underneath it (reported live: "opened site details
            // page dont get closed"). Navigating to /sites first closes
            // the detail view properly; openSearch() then re-opens the
            // modal on top of it. Both land in the same 'sites' section
            // as this page (Layout's canonicalSection() maps this page's
            // literal /sites/:id and the alias below back to the same
            // 'sites' name), so the reset-on-section-change effect
            // doesn't fire and the preserved search results survive.
            navigate(SITES_PATH)
            openSearch()
          }}
        >
          ← Back to search results
        </button>
      ) : (
        <Link to={SITES_PATH} className="back-link">
          ← Back to sites
        </Link>
      )}

      <div className="site-detail-header">
        <div>
          {editing ? (
            <input
              className="site-title-input"
              value={draft?.name ?? ''}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Site name"
            />
          ) : (
            <h1>{site.name || site.id}</h1>
          )}
          <div className="site-detail-meta">
            {site.id} · {site.district}, {site.region} · {site.type} · {site.tech}
          </div>
        </div>
        {(canUpdate || canDelete) && (
          <div className="site-detail-actions">
            {editing ? (
              <>
                <button className="btn-secondary" onClick={cancelEdit} disabled={updateSite.isPending}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={handleSave} disabled={updateSite.isPending}>
                  {updateSite.isPending ? 'Saving…' : 'Save Changes'}
                </button>
              </>
            ) : (
              <>
                {canDelete && (
                  <button className="btn-secondary" onClick={handleDelete} disabled={deleteSite.isPending}>
                    Delete site
                  </button>
                )}
                {canUpdate && (
                  <button className="btn-primary" onClick={startEdit}>
                    Edit
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {saveError && <div className="form-error">{saveError}</div>}

      {/* Two-column layout (2026-08-09, "right part have sufficient space
          but not utilized") — Identity + KPI tabs in the main column,
          a sticky Quick Stats card + location mini-map filling what used
          to be unused width on a wide screen. Sectors is deliberately
          OUTSIDE this grid (see below) — it's a data table that wants
          full width, not a column sharing space with a 320px sidebar. */}
      <div className="site-detail-layout">
      <div className="site-detail-main">

      {/* ── Site Identity ──────────────────────────────────────────── */}
      <div className="site-form-section">Site Identity</div>
      <div className="site-form-row cols-2">
        <FieldCard label="Site ID" editing={editing} readOnly value={site.id} />
        <FieldCard
          label="Site Name"
          editing={editing}
          readOnly={editing}
          hint="Synced from the Live Site Directory"
          value={identitySource.name ?? ''}
          onChange={(v) => setField('name', v)}
        />
      </div>
      <div className="site-form-row cols-3">
        <FieldCard
          label="Region" editing={editing} readOnly={editing} hint="Synced from the Live Site Directory"
          value={identitySource.region ?? ''} onChange={(v) => setField('region', v)}
        />
        <FieldCard label="City" editing={editing} value={identitySource.city ?? ''} onChange={(v) => setField('city', v)} />
        <FieldCard
          label="District" editing={editing} readOnly={editing} hint="Synced from the Live Site Directory"
          value={identitySource.district ?? ''} onChange={(v) => setField('district', v)}
        />
      </div>
      <div className="site-form-row cols-3">
        <FieldCard label="Site Type" editing={editing} value={identitySource.type ?? ''} onChange={(v) => setField('type', v)} />
        <FieldCard label="Technology" editing={editing} value={identitySource.tech ?? ''} onChange={(v) => setField('tech', v)} />
        <FieldCard label="Status" editing={editing} value={identitySource.status ?? ''} onChange={(v) => setField('status', v)} />
      </div>
      <div className="site-form-row cols-2">
        <FieldCard
          label="Latitude" editing={editing} type="number" readOnly={editing} hint="Synced from the Live Site Directory"
          value={String((editing ? draft?.lat : site.lat) ?? '')}
          onChange={(v) => setNumberField('lat', v)}
        />
        <FieldCard
          label="Longitude" editing={editing} type="number" readOnly={editing} hint="Synced from the Live Site Directory"
          value={String((editing ? draft?.lng : site.lng) ?? '')}
          onChange={(v) => setNumberField('lng', v)}
        />
      </div>

      {/* ── KPI Values — tabbed 4G LTE / 3G UMTS / 2G GSM ───────────── */}
      <div className="site-form-section">
        KPI Values
        <span className="site-form-section-hint">
          {site.kpi_date ? `as of ${site.kpi_date}` : 'site-level averages per technology'}
        </span>
      </div>
      <div className="kpi-tabs">
        {(['4G', '3G', '2G'] as KpiTech[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`kpi-tab${kpiTech === t ? ' active' : ''}`}
            onClick={() => setKpiTech(t)}
          >
            {t === '4G' ? '4G LTE' : t === '3G' ? '3G UMTS' : '2G GSM'}
          </button>
        ))}
      </div>

      {kpiTech === '4G' && (
        site.kpi_entered || editing ? (
          <div className="site-form-row cols-4">
            {KPI_FIELDS.map(([key, label]) => (
              <FieldCard
                key={String(key)}
                label={label}
                editing={editing}
                type="number"
                value={String((editing ? draft?.[key] : site[key]) ?? '')}
                onChange={(v) => setNumberField(key, v)}
              />
            ))}
          </div>
        ) : (
          <div className="kpi-pane-empty">No 4G KPI data entered for this site yet.</div>
        )
      )}

      {kpiTech === '3G' && (
        site.kpi_entered_3g || editing ? (
          <div className="site-form-row cols-4">
            {KPI_3G_FIELDS.map(([key, label]) => {
              const source = (editing ? draft?.kpi_3g_json : site.kpi_3g_json) as Record<string, unknown> | null
              const raw = source?.[key]
              return (
                <FieldCard
                  key={key}
                  label={label}
                  editing={editing}
                  type="number"
                  value={raw === undefined || raw === null ? '' : String(raw)}
                  onChange={(v) => setTechKpiField('3g', key, v)}
                />
              )
            })}
          </div>
        ) : (
          <div className="kpi-pane-empty">No 3G KPI data entered for this site yet.</div>
        )
      )}

      {kpiTech === '2G' && (
        site.kpi_entered_2g || editing ? (
          <div className="site-form-row cols-4">
            {KPI_2G_FIELDS.map(([key, label]) => {
              const source = (editing ? draft?.kpi_2g_json : site.kpi_2g_json) as Record<string, unknown> | null
              const raw = source?.[key]
              return (
                <FieldCard
                  key={key}
                  label={label}
                  editing={editing}
                  type="number"
                  value={raw === undefined || raw === null ? '' : String(raw)}
                  onChange={(v) => setTechKpiField('2g', key, v)}
                />
              )
            })}
          </div>
        ) : (
          <div className="kpi-pane-empty">No 2G KPI data entered for this site yet.</div>
        )
      )}

      </div>

      <aside className="site-detail-sidebar">
        <div className="site-sidebar-card">
          <div className="site-sidebar-card-title">Quick Stats</div>
          <div className="site-stat-row">
            <span className="site-stat-label">Status</span>
            <span className="site-status-badge" style={{ background: STATUS_COLOR[site.status] ?? STATUS_COLOR.nodata }}>
              {STATUS_LABELS[site.status] ?? site.status ?? 'Unknown'}
            </span>
          </div>
          <div className="site-stat-row">
            <span className="site-stat-label">Sectors</span>
            <span className="site-stat-value">
              {site.sectors.length}
              {site.sectors.length > 0 ? ` (${summarizeSectorTechs(site.sectors)})` : ''}
            </span>
          </div>
          <div className="site-stat-row">
            <span className="site-stat-label">KPI Coverage</span>
            <span className="site-tech-flags">
              <span className={`site-tech-flag${site.kpi_entered ? ' entered' : ''}`}>4G</span>
              <span className={`site-tech-flag${site.kpi_entered_3g ? ' entered' : ''}`}>3G</span>
              <span className={`site-tech-flag${site.kpi_entered_2g ? ' entered' : ''}`}>2G</span>
            </span>
          </div>
          <div className="site-stat-row">
            <span className="site-stat-label">Last Updated</span>
            <span className="site-stat-value">{site.updated_at ? new Date(site.updated_at).toLocaleDateString() : '—'}</span>
          </div>
        </div>

        <div className="site-sidebar-card site-sidebar-card-grow">
          <div className="site-sidebar-card-title">Location</div>
          <SiteLocationMiniMap lat={site.lat} lng={site.lng} status={site.status} sectors={site.sectors} />
        </div>
      </aside>

      </div>

      {/* ── Sectors ──────────────────────────────────────────────────── */}
      <section ref={sectorsSectionRef}>
        <div className="site-form-section">
          Sectors ({realSectors.length})
          {editing && (
            <button className="btn-secondary btn-small" onClick={addSector} style={{ marginLeft: 12 }}>
              + Add sector
            </button>
          )}
        </div>

        {editing && draft ? (
          <div className="sectors-table-wrap">
            <table className="sectors-table">
              <thead>
                <tr>
                  {SECTOR_COLUMNS.map(([, label]) => (
                    <th key={label}>{label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.sectors.map((sec, i) => (
                  <tr key={i}>
                    {SECTOR_COLUMNS.map(([key]) => (
                      <td key={String(key)}>
                        <input
                          className="sector-cell-input"
                          value={(sec[key] as string | number | null) ?? ''}
                          onChange={(e) => setSectorField(i, key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="sector-cell-actions">
                      <button className="btn-secondary btn-small" onClick={() => removeSector(i)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : site.sectors.length > 0 ? (
          <>
            <div className="sectors-table-wrap">
              <table className="sectors-table">
                <thead>
                  <tr>
                    <th>Cell Name</th>
                    <th>Tech</th>
                    <th>Sector</th>
                    <th>Local Cell ID</th>
                    <th>Height (m)</th>
                    <th>Azimuth (°)</th>
                    <th>Mech Tilt (°)</th>
                    <th>Elec Tilt (°)</th>
                    <th>Cell ID</th>
                    <th>Location</th>
                    {/* Real columns from the user's own 3G/2G source files
                        (2026-08-09, "need to store all those data also")
                        — see Sector.carrier/site_band/cell_active_status/
                        site_existence's docstring in models.py. */}
                    <th>Carrier</th>
                    <th>Site Band</th>
                    <th>Cell Active Status</th>
                    <th>Site Existence</th>
                  </tr>
                </thead>
                <tbody>
                  {site.sectors.map((sec) => (
                    <tr key={sec.id}>
                      <td className="sector-cell-name">{sec.cell_name || '—'}</td>
                      <td>
                        <span className={`sector-tech-badge ${techBadgeClass(sec.tech)}`}>{sec.tech || '4G'}</span>
                      </td>
                      <td className="sector-cell-accent">{sec.sector || '—'}</td>
                      <td>{sec.local_cell_id ?? '—'}</td>
                      <td className="sector-cell-num">{sec.height ?? '—'}</td>
                      <td className="sector-cell-num">{sec.azimuth !== null ? `${sec.azimuth}°` : '—'}</td>
                      <td className="sector-cell-num">{sec.mech_tilt !== null ? `${sec.mech_tilt}°` : '—'}</td>
                      <td className="sector-cell-num">{sec.elec_tilt !== null ? `${sec.elec_tilt}°` : '—'}</td>
                      <td className="sector-cell-num">{sectorIdLabel(sec)}</td>
                      <td className="sector-cell-num">
                        {/* Optional per-sector GPS override (2026-08-09) —
                            blank/"(site)" is the common case, meaning this
                            sector is physically at the site's own lat/lng.
                            Only shows real coordinates when a superadmin
                            explicitly set them (sector-table edit mode),
                            e.g. for a later expansion cabinet at a genuinely
                            different spot — never fabricated here. */}
                        {sec.lat != null && sec.lng != null ? (
                          <span className="sector-location-override" title="This sector has its own GPS location, different from the site's">
                            {sec.lat.toFixed(5)}, {sec.lng.toFixed(5)}
                          </span>
                        ) : (
                          <span className="sector-location-inherited" title="Same location as the site">(site)</span>
                        )}
                      </td>
                      <td>{sec.carrier || '—'}</td>
                      <td>{sec.site_band || '—'}</td>
                      <td>{sec.cell_active_status || '—'}</td>
                      <td>{sec.site_existence || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="sector-azimuth-heading">Sector Azimuth Layout</div>
            <div className="sector-azimuth-grid">
              {site.sectors.map((sec) => (
                <div key={sec.id} className="sector-azimuth-card">
                  <div className="sector-azimuth-card-icon">📡</div>
                  <div className="sector-azimuth-card-label">{sec.sector || '—'}</div>
                  <div className="sector-azimuth-card-deg">{sec.azimuth !== null ? `${sec.azimuth}°` : '—'}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="kpi-pane-empty">No sectors recorded for this site yet.</div>
        )}
      </section>
    </div>
  )
}
