# v2 Memory / Size / Performance Audit — 2026-08-15

Follow-up to [v2_memory_size_security_audit_2026-08-07.md](./v2_memory_size_security_audit_2026-08-07.md), triggered by a reported memory crash. Everything below was verified against the real current source (not re-asserted from the earlier report) — several hypotheses were checked against actual code before being written up as findings, not guessed.

**Context that changed since the last audit:** the `.trp` binary drive-test upload feature shipped in the 8 days since 2026-08-07, and with it, sessions an order of magnitude larger than anything this app previously had to render — a single real `.trp` batch produced a 363,082-sample session, and even after this same session's earlier decimation fix (≤1 sample/sec at save time), a normal multi-hour capture can still legitimately reach the tens of thousands of points. The 2026-08-07 audit's map/render findings were evaluated against a much smaller real-world scale than exists today.

## High — DtCompareMap unbounded rendering (most likely crash cause)

`components/DtCompareMap.tsx`'s `ScatterPanelPlot` (the default "blank/plots-only" panel every Compare Sessions metric panel starts on) rendered one real SVG `<circle>` DOM node per GPS-tagged sample, with **no cap** — this was a deliberate, explicit decision from the 2026-08-07 audit: a `pointLimit` cap was added, then reverted the same day per direct user feedback ("do not limit to 500, i was confused earlier, need full plot there"), with standing guidance left in the code: *"if this panel type becomes a genuine performance problem at higher point counts, prefer canvas-based rendering... over silently dropping points again."*

That point has now been reached for real. Compare Sessions fetches up to `MAX_COMPARE = 4` full sessions at once (`DtSessionHistoryPage.tsx`'s `compareQueries`, a parallel `useQueries` over `GET /dt-sessions/<id>/` — no pagination, returns every sample), and renders one panel per (metric, session) pair — a comparison involving two 4G sessions alone is already 6 panels. Comparing even two `.trp`-derived sessions (tens of thousands of points each) means hundreds of thousands of real SVG DOM nodes across the panel grid simultaneously — this is the same failure mode already fixed once in `DtCoverageMap.tsx` on 2026-08-14, just multiplied by up to 4 sessions and however many metric panels are visible.

The real Leaflet map mode (`CompareDots`, loaded per-panel on demand via each panel's own "🗺️ Map" button) has the identical unbounded `L.circleMarker`-per-sample shape — lower likelihood of being hit by accident since it requires a click, but a real risk if clicked for a large session.

**Fixed, following the standing guidance in the code exactly (canvas, not a cap):**
- `ScatterPanelPlot` rewritten to draw on `<canvas>` (same technique as `ScatterPlotPage.tsx`) instead of one SVG `<circle>` per point. **Every real sample is still plotted — nothing is dropped or subsampled**, matching the explicit prior user preference; only the rendering target changed from DOM nodes to canvas pixels. Hover tooltips still work via a coarse spatial grid (bucketed by a fixed pixel cell, built in the same pass as drawing) for O(1) hit-testing on `mousemove`, instead of an O(n) scan that would otherwise make the cursor visibly lag at high point counts. Canvas now also resizes responsively with the panel's own drag-resize handle (via `ResizeObserver`), matching the old SVG's `width:100%/height:100%` behavior.
- `CompareDots` (real map mode) now runs each session's samples through the same `subsampleForMap()` (≤15,000 dots, evenly strided, visible note) that `DtCoverageMap.tsx` already uses — `fitBounds` still uses the full, un-subsampled point set so the map still frames the true route extent.

## High — `DtExploreTab.tsx`'s `NearSamplesLayer`, same unbounded shape

Same one-`L.circleMarker`-per-sample pattern, populated from the backend `near()` endpoint (`drive_test.py`), which has **no row cap of its own** — only a radius bound (max 50km). A wide-radius search that happens to sweep across a long `.trp`-derived session's route can still return a large sample set. Fixed the same way: `subsampleForMap()` applied before rendering.

## Medium — `GET /api/v2/dt-sessions/<id>/` returns every sample, unbounded, every time

`DriveTestSessionDetailSerializer` (`core/serializers.py`) has no pagination or row cap — confirmed by reading the serializer directly. For the frontend's OWN client-side rendering this is now largely mitigated (every map component that draws samples caps what it draws, see above), but the full JSON payload — 363,082 rows for the known large session — is still fetched over the network and held in memory (as `sessionDetail.samples` / each `compareQueries[i].data.samples`) every single time that session is opened, regardless of what gets drawn. This is real, current cost on both the network and the JS heap, independent of the rendering fixes above.

**Not fixed this pass — flagged for a decision, not silently changed:**
- New `.trp` uploads already avoid this going forward (this same session's earlier decimation fix caps new sessions at ≤1 sample/sec at save time).
- Already-saved large sessions (like the known 363,082-point one) still hold their full original row count in Postgres. A server-side decimation/backfill (permanently reducing the stored `DriveTestSample` rows for old sessions) would fix this retroactively, but that means deleting real recorded measurement rows — this needs the user's explicit go-ahead first, not an automatic cleanup, and ideally a preview of exactly how many rows would be affected per session before running it.
- A lighter-weight alternative worth considering instead: a server-side "decimated" query param on the retrieve endpoint (e.g. `?max_samples=15000`, returning an evenly-strided subset with a header/field noting how many were dropped) so the frontend doesn't have to download the full row set just to then subsample it client-side. Not implemented — would need its own round of design/verification, flagged as a follow-up.

## Medium (companion, unchanged from 2026-08-07) — React Query cache lifetime for large sessions

Confirmed: no query in this app previously overrode `gcTime`, so every `useDtSession(id)`/Compare Sessions query used TanStack Query's default 5-minute cache lifetime. For an ordinary small session this is harmless; for a large `.trp`-derived one it meant every session a user opened while browsing Session History (or picked for comparison) stayed FULLY resident in memory for 5 minutes after the component using it unmounted — clicking through several large sessions in a row could accumulate multiple full sample arrays simultaneously even after navigating away from each.

**Fixed:** `useDtSession()` and the Compare Sessions `useQueries` block both now set `gcTime: 60_000` (`DT_SESSION_GC_TIME`, exported from `api/queries.ts`) — short enough to make "go back and forth between two sessions" still feel instant, without the multi-minute pileup.

## Confirmed SAFE / re-checked, not re-flagged

- **Gunicorn worker config** (`backend-django/gunicorn.conf.py`): already has `max_requests = 1000` + jitter (periodic worker recycling, explicit insurance against slow memory growth from long-running XLSX/TRP parsing processes) and a 120s timeout. No change needed.
- **`TreeFolderSerializer`'s per-folder query** (serializers.py): a real, self-documented N+1 (`children.all()` issues one query per folder), but explicitly scoped and accepted at this dataset's size (a handful of folders, not thousands) — not re-flagged without new evidence this has grown.
- **Sites list / backup export**: both already use `prefetch_related('sectors')` — no N+1 found here.
- **`NearSitesLayer`** (DtExploreTab.tsx): renders real BTS sites within a search radius, not raw DT samples — inherently small/bounded (real sites are a few thousand total, radius-filtered further), not the same risk class as the per-sample layers above.
- Bundle size: `index-*.js` (531 kB / gzip 158.7 kB) and the lazy-loaded `TrpAnalysisPage` chunk (303 kB / gzip 100.6 kB) both still trigger Vite's own ">500kB chunk" warning, same as noted informally earlier this session — not a new regression, and route-level code-splitting (2026-08-05 perf pass) already keeps `TrpAnalysisPage`'s own weight out of the main bundle. Not chased further this pass; diminishing returns without a real reported slow-*load* (as opposed to slow-*render*) complaint to justify it.

## Verification

Manual code review only this pass — the sandbox (`mcp__workspace__bash`) was unavailable for the entire audit ("VM service not running"), so `tsc -b` / `vite build` could not be re-run to confirm the DtCompareMap/DtExploreTab/queries.ts changes compile clean. Every new construct used (`ResizeObserver`, canvas 2D context, `gcTime`, `subsampleForMap`) already has a working precedent elsewhere in this exact codebase (`useMapInvalidateOnResize.ts`, `ScatterPlotPage.tsx`, `DtCoverageMap.tsx`), reviewed line-by-line against those originals for type-shape consistency. **Recommend running `tsc -b` and `vite build` as the first next step once the sandbox is back**, before considering this pass fully verified — flagging this explicitly rather than asserting clean compilation without having actually run it.
