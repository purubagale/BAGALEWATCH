import { marked } from 'marked'
import { useMemo, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { fetchSystemDoc } from '../api/queries'
import { useAuth } from '../auth/AuthContext'

// In-app Documentation (2026-10-01, "idea and plan" follow-up to the UTS
// reference screenshots). Content is bundled straight from this repo's
// own docs/ folder via Vite's `?raw` import suffix at BUILD time -- not
// served from a new Django endpoint -- since docs/ is already a static,
// git-committed source of truth with no live-editing requirement. Serving
// arbitrary files off disk through a new API endpoint would mean building
// and maintaining a filename allowlist to avoid a path-traversal footgun,
// for a feature that's purely read-only reference material; a `?raw`
// import has no dynamic-file attack surface at all -- the exact set of
// files is fixed at build time, baked into this page's own lazy chunk.
//
// `marked` (new dependency, this page only) renders the actual markdown --
// src/lib/markdown.ts's existing hand-rolled renderer is deliberately
// scoped to the reporting suite's generated text (headings/bold/tables/
// bullets only, see its own header comment) and doesn't support the code
// fences, links, and nested lists real prose docs like RUNBOOK.md use
// throughout. Output goes through dangerouslySetInnerHTML same as that
// renderer's existing callers -- safe here because every byte rendered is
// our own git-committed markdown, never user input (unlike RF Reports'
// uploaded .docx content, which is never rendered this way).
import runbook from '../../../docs/RUNBOOK.md?raw'
import auditSep2026 from '../../../docs/AUDIT_2026-09-13.md?raw'
import perfAuditAug2026 from '../../../docs/v2_memory_size_perf_audit_2026-08-15.md?raw'
import securityAuditAug2026 from '../../../docs/v2_memory_size_security_audit_2026-08-07.md?raw'
import serverMigration from '../../../docs/SERVER_MIGRATION.md?raw'
import serverMigrationOffline from '../../../docs/SERVER_MIGRATION_OFFLINE.md?raw'
import serverMigrationWindows from '../../../docs/SERVER_MIGRATION_WINDOWS.md?raw'
import telemetryLlmPlan from '../../../docs/TELEMETRY_LLM_IMPLEMENTATION.md?raw'
import telemetryMobileHandoff from '../../../docs/telemetry_pipeline_mobile_handoff.md?raw'
import keycloakSsoDesign from '../../../docs/superpowers/specs/2026-08-23-keycloak-sso-design.md?raw'

interface DocEntry {
  category: string
  title: string
  description: string
  content: string
}

// Categorized by actual content, not force-fit to the reference app's
// exact 5 labels (which don't match what this repo actually has written).
const DOCS: DocEntry[] = [
  { category: 'Architecture & Ops', title: 'Runbook', description: 'Full stack architecture, phase history, ports, and operations reference.', content: runbook },
  { category: 'Audits', title: 'Size, Memory & Performance Audit (2026-09-13)', description: 'Repo size, Docker resource limits, logging audit and roadmap.', content: auditSep2026 },
  { category: 'Audits', title: 'Memory/Size Perf Follow-up (2026-08-15)', description: 'DtCompareMap/map rendering performance fixes.', content: perfAuditAug2026 },
  { category: 'Audits', title: 'Memory, Size & Security Audit (2026-08-07)', description: 'Earliest audit — memory/DOM-node issues and security findings.', content: securityAuditAug2026 },
  { category: 'Deployment & Migration', title: 'Server Migration', description: 'Migrating dtwatch to a LAN server (Linux) — fixed IP, .env, firewall.', content: serverMigration },
  { category: 'Deployment & Migration', title: 'Server Migration — Offline', description: 'Addendum for servers with no internet access.', content: serverMigrationOffline },
  { category: 'Deployment & Migration', title: 'Server Migration — Windows', description: 'Windows variant of the server migration guide (Docker Desktop caveats).', content: serverMigrationWindows },
  { category: 'Developer Docs', title: 'Telemetry LLM Diagnostics — Implementation Plan', description: 'Build plan for a self-hosted LLM diagnosing telemetry.', content: telemetryLlmPlan },
  { category: 'Developer Docs', title: 'Telemetry Pipeline — Mobile Integration Guide', description: 'Developer-facing API handoff for the external mobile telemetry API.', content: telemetryMobileHandoff },
  { category: 'Decision Records', title: 'Keycloak SSO Design', description: 'SSO vs. local login, role mapping, account linking — approved design.', content: keycloakSsoDesign },
]

const CATEGORY_ORDER = ['Architecture & Ops', 'Developer Docs', 'Decision Records', 'Deployment & Migration', 'Audits']

// Generate Current System State (2026-10-01, "prepare documentation of
// only current final state of application... after it is in live also")
// -- unlike every DocEntry above (bundled at build time from docs/*.md,
// historical/narrative), this content comes from GET /api/v2/system-doc/
// (core/system_doc.py), generated fresh server-side on every click by
// introspecting the live model registry/menu tree/roles -- so it stays
// accurate after a production deploy with no manual upkeep, which is the
// whole reason this is a button and not another bundled file.
const GENERATED_CATEGORY = 'Current System State'

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function DocumentationPage() {
  const { user: me } = useAuth()
  const [search, setSearch] = useState('')
  const [openDoc, setOpenDoc] = useState<DocEntry | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const renderedHtml = useMemo(() => (openDoc ? marked.parse(openDoc.content, { async: false }) : ''), [openDoc])

  if (!me) return null

  async function handleGenerate() {
    setGenerateError(null)
    setGenerating(true)
    try {
      const { markdown } = await fetchSystemDoc()
      setOpenDoc({
        category: GENERATED_CATEGORY,
        title: 'Current System State',
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
    if (!openDoc) return
    const blob = new Blob([openDoc.content], { type: 'text/markdown' })
    downloadBlob(blob, `dtwatch_${openDoc.category === GENERATED_CATEGORY ? 'current_system_state' : openDoc.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.md`)
  }

  const q = search.trim().toLowerCase()
  const filtered = DOCS.filter((d) => !q || d.title.toLowerCase().includes(q) || d.category.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))
  const byCategory = CATEGORY_ORDER.map((cat) => ({ cat, docs: filtered.filter((d) => d.category === cat) })).filter((g) => g.docs.length > 0)

  if (openDoc) {
    return (
      <div className="admin-page">
        <div className="admin-page-actions" style={{ marginBottom: 12 }}>
          <button className="btn-secondary btn-small" onClick={() => setOpenDoc(null)}>
            ← Back to Documentation
          </button>
          <button className="btn-secondary btn-small" onClick={handleDownload}>
            ⬇ Download .md
          </button>
        </div>
        <h1>{openDoc.title}</h1>
        <p className="muted">{openDoc.category}</p>
        <div className="md-report" dangerouslySetInnerHTML={{ __html: renderedHtml as string }} />
      </div>
    )
  }

  return (
    <div className="admin-page">
      <h1>Documentation</h1>
      <p className="muted">
        Architecture notes, audits, deployment guides, and decision records already written for this project — now
        browsable without repo access.
      </p>

      <div className="health-card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="health-card-title">{GENERATED_CATEGORY}</div>
          <div className="health-card-sub">
            Unlike the docs below, this is generated fresh right now from the live database — no history, just what
            the application actually is today. Works the same after this is deployed to production.
          </div>
          {generateError && <div className="form-error form-error-inline" style={{ marginTop: 6 }}>{generateError}</div>}
        </div>
        <button className="btn-primary" onClick={handleGenerate} disabled={generating} style={{ whiteSpace: 'nowrap' }}>
          {generating ? 'Generating…' : '⚙ Generate'}
        </button>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search documentation…"
        style={{ marginBottom: 16, width: '100%', maxWidth: 320 }}
      />

      {byCategory.map(({ cat, docs }) => (
        <section key={cat} style={{ marginBottom: 20 }}>
          <h2>{cat} <span className="muted" style={{ fontWeight: 400 }}>({docs.length})</span></h2>
          <div className="health-card-grid">
            {docs.map((d) => (
              <div key={d.title} className="health-card" style={{ cursor: 'pointer' }} onClick={() => setOpenDoc(d)}>
                <div className="health-card-title">{d.title}</div>
                <div className="health-card-sub">{d.description}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {byCategory.length === 0 && <div className="page-status">No documentation matches this search.</div>}
    </div>
  )
}
