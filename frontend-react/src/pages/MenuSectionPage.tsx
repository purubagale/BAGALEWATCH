import { Link } from 'react-router-dom'
import type { MenuTreeNode } from '../api/types'
import { DASHBOARD_PATH } from '../constants/opaqueRoutes'

// Deliberately visually DISTINCT from DashboardPage.tsx (2026-08-08
// follow-up: "initial dashboard after login and menu-submenu dashboard
// after header menu click should be different") — the two pages were
// originally styled identically (same `.dash-card`/`.dashboard-grid`
// classes) since both are "a grid of cards," but sharing the exact same
// look made them read as the same page, which is confusing: Dashboard is
// "your home," this is "you drilled into one section." Distinguishing
// choices: a colored banner header (not a plain heading), an explicit
// "Back to Dashboard" link (Dashboard has no such link — it has nothing
// to go "back" to), and accent-bordered cards (`.section-card`) instead
// of Dashboard's plain hover-lift `.dash-card-shortcut` tiles. Still
// reuses the underlying card ICON logic (image-over-emoji precedence)
// since that rule is genuinely shared, not a look-and-feel choice.
function SectionCardIcon({ node }: { node: MenuTreeNode }) {
  if (node.icon_image_url) return <img src={node.icon_image_url} alt="" className="dash-card-icon-img" />
  return <>{node.icon || '🔗'}</>
}

function SectionCard({ node }: { node: MenuTreeNode }) {
  const body = (
    <>
      <div className="dash-card-icon"><SectionCardIcon node={node} /></div>
      <div className="dash-card-label">{node.label}</div>
      {node.description && <div className="dash-card-desc">{node.description}</div>}
    </>
  )
  if (node.link_type === 'external') {
    return (
      <a href={node.path} target="_blank" rel="noopener noreferrer" className="dash-card section-card">
        {body}
      </a>
    )
  }
  return (
    <Link to={node.path} className="dash-card section-card">
      {body}
    </Link>
  )
}

/** Auto-generated landing page for a top-level menu item that has
 * submenu children (2026-08-08 request: "if top menu is clicked then
 * display all the inside submenu items in its dashboard page with icon
 * and details"). Rendered by `MenuSectionGate` INSTEAD OF the item's own
 * dedicated page component whenever `node.children` is non-empty — see
 * that file for exactly when this kicks in. Deliberately only shows
 * `node`'s DIRECT children (one level) — a grandchild is reached by
 * clicking through its own parent card, same as browsing the sidebar. */
export default function MenuSectionPage({ node }: { node: MenuTreeNode }) {
  return (
    <div className="menu-section-page">
      <div className="menu-section-banner">
        <span className="menu-section-banner-icon"><SectionCardIcon node={node} /></span>
        <div>
          <h1>{node.label}</h1>
          {node.description && <p>{node.description}</p>}
        </div>
      </div>
      <Link to={DASHBOARD_PATH} className="menu-section-back-link">← Back to Dashboard</Link>
      <div className="dashboard-grid">
        {node.children.map((child) => <SectionCard key={child.id} node={child} />)}
      </div>
    </div>
  )
}
