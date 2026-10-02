import { marked } from 'marked'
import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { fetchSystemDoc } from '../api/queries'
import { useAuth } from '../auth/AuthContext'

// In-app Documentation (2026-10-01, "idea and plan" follow-up to the UTS
// reference screenshots; narrowed 2026-10-02, "do not include history or
// phase, only display current final state only"). This page used to also
// bundle ~10 hand-written docs/*.md files (RUNBOOK.md, dated audits,
// migration guides) at build time via Vite's `?raw` import -- ALL of
// those are inherently historical/narrative by construction (phase
// history, dated decision logs), which is exactly what was asked to be
// removed from this page. They still exist in the repo's docs/ folder
// (git history is the right place for "how we got here"); this page now
// shows ONLY the generated current-state document (core/system_doc.py),
// since that's the one thing here that is never historical by
// construction -- it's introspected fresh from the live app on every
// click, so it can never drift into "the past" the way a hand-written
// file inevitably does.
//
// `marked` renders the generated markdown -- see this page's own history
// for why a real markdown library is used here instead of
// lib/markdown.ts's minimal renderer (the generated doc has nested lists,
// tables, and fenced code blocks that renderer doesn't support).

interface DocEntry {
  category: string
  title: string
  description: string
  content: string
}

interface TocEntry {
  level: 2 | 3
  text: string
  slug: string
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// Parsed straight off the raw markdown (not the rendered HTML) -- simple
// and reliable for content this page fully controls the shape of
// (core/system_doc.py only ever emits plain `## `/`### ` heading lines).
function extractToc(markdown: string): TocEntry[] {
  const toc: TocEntry[] = []
  const seen = new Map<string, number>()
  for (const rawLine of markdown.split('\n')) {
    const m = /^(#{2,3})\s+(.+)$/.exec(rawLine.trim())
    if (!m) continue
    const level = m[1].length as 2 | 3
    const text = m[2].trim()
    let slug = slugify(text) || 'section'
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    if (count > 0) slug = `${slug}-${count}`
    toc.push({ level, text, slug })
  }
  return toc
}

// marked's own `<h2>`/`<h3>` output has no `id` attribute -- injected here
// by matching each tag to the TOC entries in the SAME order they appear
// (reliable because both come from the same markdown, walked top to
// bottom) so the sidebar's anchor links actually land somewhere.
function injectHeadingIds(html: string, toc: TocEntry[]): string {
  const h2s = toc.filter((t) => t.level === 2)
  const h3s = toc.filter((t) => t.level === 3)
  let i2 = 0
  let i3 = 0
  return html
    .replace(/<h2>/g, () => `<h2 id="${h2s[i2++]?.slug ?? ''}">`)
    .replace(/<h3>/g, () => `<h3 id="${h3s[i3++]?.slug ?? ''}">`)
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function DocumentationPage() {
  const { user: me } = useAuth()
  const [doc, setDoc] = useState<DocEntry | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const toc = useMemo(() => (doc ? extractToc(doc.content) : []), [doc])
  const renderedHtml = useMemo(
    () => (doc ? injectHeadingIds(marked.parse(doc.content, { async: false }) as string, toc) : ''),
    [doc, toc],
  )

  if (!me) return null

  async function handleGenerate() {
    setGenerateError(null)
    setGenerating(true)
    try {
      const { markdown } = await fetchSystemDoc()
      setDoc({
        category: 'Current System State',
        title: 'DT-WATCH BTS v2 — Current System State',
        description: 'Generated just now from the live database schema, menu configuration, and role setup.',
        content: markdown,
      })
    } catch (err) {
      setGenerateError(apiErrorMessage(err, 'Could not generate the current-state document.'))
    } finally {
      setGenerating(false)
    }
  }

  function handleDownload() {
    if (!doc) return
    const blob = new Blob([doc.content], { type: 'text/markdown' })
    downloadBlob(blob, 'dtwatch_current_system_state.md')
  }

  if (doc) {
    return (
      <div className="admin-page">
        <div className="admin-page-actions" style={{ marginBottom: 12 }}>
          <button className="btn-secondary btn-small" onClick={() => setDoc(null)}>
            ← Back
          </button>
          <button className="btn-secondary btn-small" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Regenerating…' : '↻ Regenerate'}
          </button>
          <button className="btn-secondary btn-small" onClick={handleDownload}>
            ⬇ Download .md
          </button>
        </div>
        <div className="doc-detail-layout">
          <div className="md-report doc-detail-main">
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </div>
          <nav className="doc-toc">
            <div className="doc-toc-title">On this page</div>
            <ul>
              {toc.map((t) => (
                <li key={t.slug} className={t.level === 3 ? 'doc-toc-sub' : undefined}>
                  <a href={`#${t.slug}`}>{t.text}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-page">
      <h1>Documentation</h1>
      <p className="muted">
        The current system state, generated on demand — no history, no phase notes, just what the application
        actually is right now. Works the same once this is deployed to production: every click reflects whatever is
        actually running at that moment.
      </p>

      <div className="health-card" style={{ maxWidth: 480 }}>
        <div className="health-card-title">Current System State</div>
        <div className="health-card-sub" style={{ marginBottom: 12 }}>
          Architecture, tech stack, the full data model, every menu item and its access tier, current roles and
          permission counts, and a link to the live API reference.
        </div>
        {generateError && <div className="form-error form-error-inline" style={{ marginBottom: 10 }}>{generateError}</div>}
        <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating…' : '⚙ Generate'}
        </button>
      </div>
    </div>
  )
}
