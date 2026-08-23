import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiJson } from './client'
import type {
  AdminUser,
  ApiKeyCreate,
  ApiKeyCreateResponse,
  ApiKeyRow,
  ApiKeyUpdate,
  AuditHistoryCreate,
  AuditHistoryEntry,
  BackupSummary,
  BrandingSettings,
  BrandingSettingsWrite,
  DashboardCard,
  DashboardCardLayoutEntry,
  DtBandsMap,
  DtSample,
  DtSessionCreate,
  DtSessionDetail,
  DtSessionListItem,
  DtTech,
  KpiTrend,
  MenuItem,
  MenuItemWrite,
  MenuTreeNode,
  MonthlyReport,
  NtaReport,
  PermissionsMatrix,
  RfAuditData,
  ScatterData,
  SiteDetail,
  SiteListItem,
  SiteSearchParams,
  SiteSearchResponse,
  SiteWrite,
  SlaReport,
  ThresholdMap,
  TreeState,
  UserWrite,
  HealthInfo,
} from './types'

export function useSites() {
  return useQuery({
    queryKey: ['sites'],
    queryFn: () => apiJson<SiteListItem[]>('/api/v2/sites/'),
    staleTime: 60_000,
  })
}

export function useSite(siteId: string | undefined) {
  return useQuery({
    queryKey: ['site', siteId],
    queryFn: () => apiJson<SiteDetail>(`/api/v2/sites/${siteId}/`),
    enabled: !!siteId,
  })
}

// ── Phase 2: mutations ──────────────────────────────────────────────────
// Every mutation invalidates the query keys its write actually affects —
// deliberately not a blanket invalidateQueries() on everything, so an
// edit on one site doesn't force-refetch the whole 4,700-row sidebar tree.

export function useCreateSite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (site: SiteWrite) => apiJson<SiteDetail>('/api/v2/sites/', { method: 'POST', body: JSON.stringify(site) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  })
}

export function useUpdateSite(siteId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (site: SiteWrite) => apiJson<SiteDetail>(`/api/v2/sites/${siteId}/`, { method: 'PUT', body: JSON.stringify(site) }),
    onSuccess: (data) => {
      qc.setQueryData(['site', siteId], data)
      qc.invalidateQueries({ queryKey: ['sites'] })
    },
  })
}

export function useDeleteSite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (siteId: string) => apiJson<void>(`/api/v2/sites/${siteId}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  })
}

// Drag-to-relocate (2026-07-30, map-based site editing) — deliberately a
// PATCH with just {lat, lng}, NOT useUpdateSite's PUT with a full
// SiteWrite body. SiteWriteSerializer's own docstring warns a PUT that
// omits an optional field clears it to null/blank (v1's same "send your
// complete current state" contract) — reusing PUT here with only
// lat/lng would silently wipe every KPI field and the site's sectors.
// The SiteViewSet already supports partial_update (DRF's standard PATCH
// behavior, gated by the same IsAdminOrSuperadmin permission as PUT/
// POST/DELETE — see core/views.py), so PATCH is the correct, already-
// available partial-update path, not a new backend capability.
export function useRelocateSite(siteId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (coords: { lat: number; lng: number }) =>
      apiJson<SiteDetail>(`/api/v2/sites/${siteId}/`, { method: 'PATCH', body: JSON.stringify(coords) }),
    onSuccess: (data) => {
      qc.setQueryData(['site', siteId], data)
      qc.invalidateQueries({ queryKey: ['sites'] })
    },
  })
}

export function useThresholds() {
  return useQuery({
    queryKey: ['thresholds'],
    queryFn: () => apiJson<ThresholdMap>('/api/v2/thresholds/'),
  })
}

export function useUpdateThresholds() {
  const qc = useQueryClient()
  return useMutation({
    // Body is only the changed keys — matches ThresholdsView's per-key
    // upsert (not full-replace) contract.
    mutationFn: (changed: ThresholdMap) => apiJson<{ ok: true }>('/api/v2/thresholds/', { method: 'PUT', body: JSON.stringify(changed) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['thresholds'] }),
  })
}

// Beyond-v1-parity addition (confirmed with user 2026-07-27) — v1's own
// PUT is upsert-only and can never remove a key, so this is a real
// DELETE endpoint that doesn't exist in v1 at all.
export function useDeleteThreshold() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (kpiKey: string) => apiJson<void>(`/api/v2/thresholds/${encodeURIComponent(kpiKey)}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['thresholds'] }),
  })
}

// DT coverage-band colors (2026-08-05, v2-only — see api/types.ts's
// DtBandsMap doc comment). staleTime: 60_000 matches useSites() — every
// DT map on the page reads this, so it's worth not refetching on every
// remount, and a band edit is rare enough that a slightly-stale legend
// for up to a minute is an acceptable trade (the mutation below still
// invalidates immediately on an actual save).
export function useDtBands() {
  return useQuery({
    queryKey: ['dt-bands'],
    queryFn: () => apiJson<DtBandsMap>('/api/v2/dt-bands/'),
    staleTime: 60_000,
  })
}

export function useUpdateDtBands() {
  const qc = useQueryClient()
  return useMutation({
    // Full replace, matching DtBandsView.put()'s contract — the caller
    // always sends every tag's complete current band list, not just the
    // one(s) it changed.
    mutationFn: (bands: DtBandsMap) => apiJson<{ ok: true }>('/api/v2/dt-bands/', { method: 'PUT', body: JSON.stringify(bands) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dt-bands'] }),
  })
}

// Backup & Restore — Complete Project (2026-08-05). Export/Restore/Excel
// export themselves are one-shot actions (trigger a file download or a
// single confirmed write), not cacheable GET state — those call
// apiFetch/apiJson directly from BackupPage.tsx rather than living here
// as useQuery/useMutation hooks, same as the DT template CSV download
// and DtExploreTab's CSV/KML export already do. Only the summary card
// (shown before any action is taken) is a normal cached query.
export function useBackupSummary() {
  return useQuery({
    queryKey: ['backup-summary'],
    queryFn: () => apiJson<BackupSummary>('/api/v2/backup/summary/'),
  })
}

export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: () => apiJson<TreeState>('/api/v2/tree/'),
  })
}

export function useUpdateTree() {
  const qc = useQueryClient()
  return useMutation({
    // Full tree state, every call — matches TreeView's full-replace
    // contract (the client always sends its complete current tree).
    mutationFn: (tree: TreeState) => apiJson<{ ok: true }>('/api/v2/tree/', { method: 'PUT', body: JSON.stringify(tree) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tree'] }),
  })
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiJson<AdminUser[]>('/api/v2/users/'),
  })
}

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (user: UserWrite) => apiJson<AdminUser>('/api/v2/users/', { method: 'POST', body: JSON.stringify(user) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function useUpdateUser(userId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (user: Partial<UserWrite>) => apiJson<AdminUser>(`/api/v2/users/${userId}/`, { method: 'PATCH', body: JSON.stringify(user) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) => apiJson<void>(`/api/v2/users/${userId}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}

// ── External API keys (2026-08-12) ───────────────────────────────────────
// Superadmin-only CRUD over ApiKey, same hook shape as useUsers/
// useCreateUser/etc above. useCreateApiKey's response is the ONE place
// the full plaintext key ever appears (ApiKeyCreateResponse's own
// docstring) — ApiAccessPage.tsx is responsible for showing it exactly
// once and never persisting it anywhere itself.
export function useApiKeys() {
  return useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiJson<ApiKeyRow[]>('/api/v2/api-keys/'),
  })
}

export function useCreateApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ApiKeyCreate) =>
      apiJson<ApiKeyCreateResponse>('/api/v2/api-keys/', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })
}

export function useUpdateApiKey(keyId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ApiKeyUpdate) =>
      apiJson<ApiKeyRow>(`/api/v2/api-keys/${keyId}/`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })
}

export function useDeleteApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (keyId: number) => apiJson<void>(`/api/v2/api-keys/${keyId}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })
}

// ── Dynamic top-nav (2026-08-08) ─────────────────────────────────────────
// Two separate reads, matching the two separate backend endpoints:
// useMenuTree() is what Layout.tsx renders (server-filtered, nested,
// open to any authenticated user); useMenuItems() is the raw flat list
// for MenuAdminPage.tsx's table (superadmin-only on the backend). A
// write to either mutation below invalidates BOTH query keys — editing
// a menu item should update the admin table immediately AND the actual
// header nav next time it's fetched (e.g. after a route change), not
// just one or the other.
// `enabled` defaults to true (every existing authenticated-page caller is
// unaffected) but Layout.tsx — the ONE caller that renders on every route,
// including pre-login — must pass `!!user` here. Found live 2026-08-08:
// without this gate, Layout mounted on /login and fired this query anyway
// (no access token attached), got a 401 from MenuTreeView's IsAuthenticated
// gate, which apiFetch's silent-refresh-then-logout path treated as "your
// session just expired" and force-reloaded to /login — reloading /login
// remounts Layout, which fires the same doomed query again, forever. Looked
// like the login page flickering/reloading in a tight loop. See also the
// matching defense-in-depth fix in client.ts's apiFetch (don't treat "no
// token to begin with" as "session expired").
export function useMenuTree(enabled = true) {
  return useQuery({
    queryKey: ['menu-tree'],
    queryFn: () => apiJson<MenuTreeNode[]>('/api/v2/menu-tree/'),
    staleTime: 60_000,
    enabled,
  })
}

export function useMenuItems() {
  return useQuery({
    queryKey: ['menu-items'],
    queryFn: () => apiJson<MenuItem[]>('/api/v2/menu-items/'),
  })
}

function invalidateMenus(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['menu-items'] })
  qc.invalidateQueries({ queryKey: ['menu-tree'] })
}

export function useCreateMenuItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (item: Partial<MenuItemWrite>) =>
      apiJson<MenuItem>('/api/v2/menu-items/', { method: 'POST', body: JSON.stringify(item) }),
    onSuccess: () => invalidateMenus(qc),
  })
}

export function useUpdateMenuItem(itemId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (item: Partial<MenuItemWrite>) =>
      apiJson<MenuItem>(`/api/v2/menu-items/${itemId}/`, { method: 'PATCH', body: JSON.stringify(item) }),
    onSuccess: () => invalidateMenus(qc),
  })
}

export function useDeleteMenuItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (itemId: number) => apiJson<void>(`/api/v2/menu-items/${itemId}/`, { method: 'DELETE' }),
    onSuccess: () => invalidateMenus(qc),
  })
}

// ── Customizable Dashboard (2026-08-08) ─────────────────────────────────
// Deliberately NOT `staleTime`-cached like most other reads here — the
// user can jump straight from "Customize" (a save) back to the plain
// view, and should see their own just-saved layout immediately rather
// than a stale pre-save snapshot for up to a minute.
export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiJson<DashboardCard[]>('/api/v2/dashboard/'),
  })
}

export function useSaveDashboardLayout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cards: DashboardCardLayoutEntry[]) =>
      apiJson<{ ok: true }>('/api/v2/dashboard/', { method: 'PUT', body: JSON.stringify({ cards }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard'] }),
  })
}

// ── Customizable branding (2026-08-08 follow-up) ────────────────────────
// Read by Layout.tsx (sidebar brand block) and LoginPage.tsx, both of
// which need it before the user has necessarily done anything else, so
// this is fetched unconditionally for any authenticated session (see
// BrandingSettingsView's docstring — GET is IsAuthenticated, not
// superadmin-gated). Cached like most other reads; a superadmin's own
// save invalidates it immediately via useUpdateBranding below.
// Build stamp of the running backend, for AboutPage. Long staleTime: this
// only changes on a redeploy, and a redeploy reloads the page anyway.
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiJson<HealthInfo>('/api/v2/health/'),
    staleTime: 5 * 60_000,
  })
}

export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: () => apiJson<BrandingSettings>('/api/v2/branding/'),
    staleTime: 60_000,
  })
}

export function useUpdateBranding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: BrandingSettingsWrite) =>
      apiJson<BrandingSettings>('/api/v2/branding/', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branding'] }),
  })
}

// ── Phase 3: reporting suite ─────────────────────────────────────────────

export function useSlaReport(region: string) {
  return useQuery({
    queryKey: ['sla-report', region],
    queryFn: () => apiJson<SlaReport>(`/api/v2/sla/?region=${encodeURIComponent(region)}`),
  })
}

export function useNtaReport(pane: 'all-sites' | 'violations') {
  return useQuery({
    queryKey: ['nta-report', pane],
    queryFn: () => apiJson<NtaReport>(`/api/v2/nta/?pane=${pane}`),
  })
}

export function useMonthlyReport(month: string, style: string, region: string) {
  return useQuery({
    queryKey: ['monthly-report', month, style, region],
    queryFn: () =>
      apiJson<MonthlyReport>(
        `/api/v2/monthly-report/?month=${encodeURIComponent(month)}&style=${style}&region=${encodeURIComponent(region)}`,
      ),
  })
}

export function useScatterData() {
  return useQuery({
    queryKey: ['scatter-data'],
    queryFn: () => apiJson<ScatterData>('/api/v2/scatter/'),
    staleTime: 60_000,
  })
}

export function useKpiTrend(siteId: string | undefined, days: number) {
  return useQuery({
    queryKey: ['kpi-trend', siteId, days],
    queryFn: () => apiJson<KpiTrend>(`/api/v2/kpi-trend/?site=${encodeURIComponent(siteId ?? '')}&days=${days}`),
    enabled: !!siteId,
  })
}

export function useRfAuditData(siteId: string | undefined) {
  return useQuery({
    queryKey: ['rf-audit-data', siteId],
    queryFn: () => apiJson<RfAuditData>(`/api/v2/rf-audit/data/?site=${encodeURIComponent(siteId ?? '')}`),
    enabled: !!siteId,
  })
}

// Admin+ only (matches v1's audit-history gating exactly, see
// AuditHistoryListView's docstring) — a viewer's request 403s, which the
// page treats as "no saved-history panel to show", not an error banner.
export function useAuditHistory(siteId: string | undefined) {
  return useQuery({
    queryKey: ['rf-audit-history', siteId],
    queryFn: () => apiJson<AuditHistoryEntry[]>(`/api/v2/rf-audit/history/?site=${encodeURIComponent(siteId ?? '')}`),
    enabled: !!siteId,
    retry: false,
  })
}

export function useSaveAuditReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entry: AuditHistoryCreate) =>
      apiJson<AuditHistoryEntry>('/api/v2/rf-audit/history/', { method: 'POST', body: JSON.stringify(entry) }),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['rf-audit-history', data.site ?? undefined] }),
  })
}

export function useDeleteAuditReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiJson<void>(`/api/v2/rf-audit/history/${id}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rf-audit-history'] }),
  })
}

// ── Drive-Test Data Manager (Phase 4) ───────────────────────────────────

export function useDtSessions() {
  return useQuery({
    queryKey: ['dt-sessions'],
    queryFn: () => apiJson<DtSessionListItem[]>('/api/v2/dt-sessions/'),
  })
}

// gcTime shortened from the default 5 minutes (2026-08-15 memory audit) —
// a single session's `samples` array can now legitimately hold hundreds
// of thousands of real rows (a `.trp`-derived session; see
// DtUploadPage.tsx's decimation comment for why even a decimated one can
// still be sizeable). The default 5-minute cache meant every large
// session a user opened while browsing Session History — or every
// session picked for Compare Sessions below — stayed fully resident in
// memory for 5 minutes after the component using it unmounted, so
// clicking through several big sessions in a row could accumulate
// multiple full sample arrays at once even after navigating away from
// each. 60s is enough to make "go back and forth between two sessions"
// still feel instant, without that multi-minute pileup.
export const DT_SESSION_GC_TIME = 60_000

export function useDtSession(id: number | undefined) {
  return useQuery({
    queryKey: ['dt-session', id],
    queryFn: () => apiJson<DtSessionDetail>(`/api/v2/dt-sessions/${id}/`),
    enabled: id !== undefined,
    gcTime: DT_SESSION_GC_TIME,
  })
}

export function useCreateDtSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (session: DtSessionCreate) =>
      apiJson<DtSessionDetail>('/api/v2/dt-sessions/', { method: 'POST', body: JSON.stringify(session) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dt-sessions'] }),
  })
}

export function useDeleteDtSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiJson<void>(`/api/v2/dt-sessions/${id}/`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dt-sessions'] }),
  })
}

// Companion to useCreateDtSession for large sessions (2026-08-14 fix — a
// real 363,082-sample .trp upload hit "Could not save this session (HTTP
// 413)" sending everything in one POST). DtUploadPage.tsx's
// saveSessionChunked() creates the session with an empty/small samples
// list, then calls this repeatedly with bounded batches — see
// DT_SAMPLES_BATCH_SIZE's comment in the backend's serializers.py. No
// per-call cache invalidation here on purpose: a large session can mean
// dozens of sequential batch calls, and invalidating ['dt-sessions'] on
// every one would refetch the whole list that many times for no benefit
// — the caller invalidates once after the full batch sequence finishes.
export function useAppendDtSamples() {
  return useMutation({
    mutationFn: ({ id, samples }: { id: number; samples: DtSample[] }) =>
      apiJson<{ appended: number }>(`/api/v2/dt-sessions/${id}/samples/`, { method: 'POST', body: JSON.stringify({ samples }) }),
  })
}

// Phase 4d — Explore-by-coordinate. Response shape is identical to
// DtSessionDetail (metadata + samples), just with `samples` trimmed
// server-side to only the readings inside the searched radius — see
// DriveTestSessionNearSerializer's docstring in serializers.py.
export function useDtSessionsNear(point: { lat: number; lng: number } | null, radiusKm: number, techs: DtTech[]) {
  return useQuery({
    queryKey: ['dt-sessions-near', point?.lat, point?.lng, radiusKm, techs.join(',')],
    queryFn: () =>
      apiJson<DtSessionDetail[]>(
        `/api/v2/dt-sessions/near/?lat=${point!.lat}&lng=${point!.lng}&radius_km=${radiusKm}&tech=${techs.join(',')}`,
      ),
    enabled: point !== null && techs.length > 0,
  })
}

export function usePermissionsMatrix() {
  return useQuery({
    queryKey: ['permissions-matrix'],
    queryFn: () => apiJson<PermissionsMatrix>('/api/v2/permissions-matrix/'),
  })
}

export function useUpdatePermissionsMatrix() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (changed: Partial<PermissionsMatrix>) =>
      apiJson<{ ok: true }>('/api/v2/permissions-matrix/', { method: 'PUT', body: JSON.stringify(changed) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions-matrix'] }),
  })
}

// ── Advanced Site Search (2026-08-06) ───────────────────────────────────
// A mutation rather than a query — the modal fires a search on demand
// (Search button / Enter), not automatically on every keystroke across
// 12 fields, so there's no stable queryKey that should drive an
// auto-refetching useQuery here. See SiteSearchParams' docstring in
// types.ts for what each field means.
export function useSiteSearch() {
  return useMutation({
    mutationFn: (params: SiteSearchParams) => {
      const qs = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') qs.set(key, value)
      }
      const suffix = qs.toString()
      return apiJson<SiteSearchResponse>(`/api/v2/sites/search/${suffix ? `?${suffix}` : ''}`)
    },
  })
}
