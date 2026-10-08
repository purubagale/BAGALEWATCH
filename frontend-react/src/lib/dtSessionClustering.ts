import type { DtSessionListItem } from '../api/types'

// "Latest per area" clustering for DT Session History (2026-09-12 request:
// re-testing the same area over weeks/months buries the one session an
// engineer actually wants under old ones). Groups sessions into "area
// clusters" using union-find over the ~1km nearby-site tagging that's
// already computed server-side at save time (meta.nearby_site_ids -- see
// DtSessionMeta in api/types.ts and _nearby_site_ids() in
// core/serializers.py). Two sessions land in the same cluster whenever
// they share at least one nearby site id, even transitively through a
// third session (A~B via site X, B~C via site Y => A, B, C all one
// cluster) -- which is exactly what union-find gives for free.
//
// Small-N (tens to low hundreds of sessions per the page's existing
// assumption for its client-side search filter) -- plain O(n) union-find
// backed by a couple of Maps, no need for a real disjoint-set library.

// Generic over T (defaulting to the plain DtSessionListItem History uses)
// so callers with a richer row shape -- e.g. DtExploreTab.tsx's
// DtSessionDetail, which adds `samples`/`attachments` -- get clusters
// typed with THEIR element type back, instead of every session getting
// widened to the base DtSessionListItem and losing those extra fields.
export interface DtSessionCluster<T extends DtSessionListItem = DtSessionListItem> {
  /** Stable-ish key for this cluster: the union-find root site id
   * ("site:<id>") for sessions with nearby sites, or "session:<id>" for a
   * standalone session with no nearby-site match (never grouped with
   * anything else -- no basis for comparison). Stable across renders as
   * long as the input session list is, which is all the callers below
   * need it for (React key + expanded-set membership). */
  key: string
  /** All sessions in this cluster, sorted by best-available date
   * descending (real drive-test `date` when present, else `saved_at` --
   * both are ISO-ish strings so a lexical compare is already a
   * chronological one). sessions[0] is the cluster's "latest". */
  sessions: T[]
}

function bestDate(s: DtSessionListItem): string {
  return s.date ?? s.saved_at
}

// The district is not stored on a session; it is only in the auto-generated
// name (`DT_Excel_<date>_<District>_<tech>` / `DT_trp_<date>_<District>_<tech>[_<type>]`,
// see DtUploadPage.tsx). Returns null for a renamed session or an
// "Unknown" district, and the caller falls back to nearby-site grouping.
function sessionDistrict(s: DtSessionListItem): string | null {
  const m = /^DT_[A-Za-z]+_\d{8}_([^_]+)_/.exec(s.name ?? '')
  if (!m) return null
  const district = m[1].toLowerCase()
  return district === 'unknown' ? null : district
}

export function clusterDtSessionsByArea<T extends DtSessionListItem>(
  sessions: T[],
  options?: {
    // sameTech (2026-10-08, see the bucketing comment below for the full
    // reasoning): defaults to false so existing callers that want
    // cross-tech area grouping (e.g. the upload-time "link this to a
    // sibling session's activity" suggestion -- a single RF optimization
    // effort commonly spans 2G/3G/4G measurements at the same site) are
    // completely unaffected. The "Latest only" toggle on both History and
    // Explore passes true.
    sameTech?: boolean
  },
): DtSessionCluster<T>[] {
  const sameTech = options?.sameTech ?? false
  // Union-find over site ids. parent.get(x) === x means x is a root;
  // absent means x hasn't been seen yet (treated as its own root on
  // first touch, via ensure()).
  const parent = new Map<string, string>()
  function ensure(id: string): string {
    if (!parent.has(id)) parent.set(id, id)
    return id
  }
  function find(x: string): string {
    ensure(x)
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    // Path compression so repeated find() calls (once per session below)
    // stay cheap even if a cluster ends up with many distinct site ids.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  function union(a: string, b: string) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Pass 1: union every session's nearby site ids together (against the
  // array's own first id), so any two sessions sharing even one site id
  // end up in the same component regardless of upload order.
  for (const s of sessions) {
    const ids = s.meta?.nearby_site_ids
    if (!ids || ids.length === 0) continue
    const first = ensure(ids[0])
    for (const id of ids) union(first, id)
  }

  // Pass 2: bucket sessions by their cluster's root (plus tech, when
  // `sameTech` is on -- 2026-10-08 fix: "different tech session also hide
  // under another tech session which is not good, hide only for those
  // with same district, with same tech and with old dates." The
  // union-find above only groups by shared AREA (nearby site ids), with
  // no idea what tech a session is; with `sameTech` off, a 2G and a 4G
  // session from the same spot fall into one bucket, so "Latest only"
  // picks whichever is newer and buries the OTHER tech's session
  // entirely, not just its own earlier same-tech runs. With `sameTech`
  // on, an area with 2G, 3G and 4G sessions gets three separate clusters
  // instead, each with its own latest shown and its own "+N earlier
  // here" expander).
  const buckets = new Map<string, T[]>()
  for (const s of sessions) {
    const ids = s.meta?.nearby_site_ids
    // With `sameTech` on, a session whose district is known is bucketed by
    // district + tech alone (2026-10-08: Gulmi 4G was hidden under Palpa 4G
    // because the two routes share sites near the district border).
    const district = sameTech ? sessionDistrict(s) : null
    const key = district
      ? `district:${district}|tech:${s.tech}`
      : ids && ids.length > 0
        ? `site:${find(ids[0])}${sameTech ? `|tech:${s.tech}` : ''}`
        : `session:${s.id}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(s)
    else buckets.set(key, [s])
  }

  const clusters: DtSessionCluster<T>[] = []
  for (const [key, list] of buckets) {
    list.sort((a, b) => {
      const da = bestDate(a)
      const db = bestDate(b)
      if (da === db) return 0
      return da > db ? -1 : 1
    })
    clusters.push({ key, sessions: list })
  }
  return clusters
}
