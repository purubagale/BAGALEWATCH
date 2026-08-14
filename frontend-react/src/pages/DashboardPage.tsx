import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useDashboard, useSaveDashboardLayout } from '../api/queries'
import type { DashboardCard } from '../api/types'
import { useAuth } from '../auth/AuthContext'

// New default landing page after login (2026-08-08 request: "after
// login, display dashboard should be like this... dashboard should be
// like with some features that can be displayed with style including
// representing image (some may be summary display and some may be link
// to feature). and dashboard display contents also should be
// customizable by individual user by themselves and save for later
// use"). Two card types share one render path (see DashboardCard's
// docstring in api/types.ts): STAT cards show a live number,
// SHORTCUT cards are clickable tiles into another page.

function CardIcon({ card }: { card: DashboardCard }) {
  if (card.icon_image_url) return <img src={card.icon_image_url} alt="" className="dash-card-icon-img" />
  return <>{card.icon || '🔗'}</>
}

function CardTile({ card }: { card: DashboardCard }) {
  const body = (
    <>
      <div className="dash-card-icon"><CardIcon card={card} /></div>
      {card.type === 'stat' ? (
        <>
          <div className="dash-card-value">{card.value ?? '—'}</div>
          <div className="dash-card-label">{card.label}</div>
        </>
      ) : (
        <>
          <div className="dash-card-label">{card.label}</div>
          {card.description && <div className="dash-card-desc">{card.description}</div>}
        </>
      )}
    </>
  )

  if (card.type === 'stat' || !card.path) {
    return <div className="dash-card dash-card-stat">{body}</div>
  }
  if (card.link_type === 'external') {
    return (
      <a href={card.path} target="_blank" rel="noopener noreferrer" className="dash-card dash-card-shortcut">
        {body}
      </a>
    )
  }
  return (
    <Link to={card.path} className="dash-card dash-card-shortcut">
      {body}
    </Link>
  )
}

function CustomizeRow({
  card, isFirst, isLast, onToggle, onMove,
}: {
  card: DashboardCard
  isFirst: boolean
  isLast: boolean
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className="dash-customize-row">
      <span className="dash-card-icon dash-customize-icon"><CardIcon card={card} /></span>
      <span className="dash-customize-label">{card.label}</span>
      <span className="dash-customize-type muted">{card.type === 'stat' ? 'Summary' : 'Shortcut'}</span>
      <div className="dash-customize-controls">
        <button type="button" className="btn-secondary btn-small" onClick={() => onMove(-1)} disabled={isFirst} title="Move up">↑</button>
        <button type="button" className="btn-secondary btn-small" onClick={() => onMove(1)} disabled={isLast} title="Move down">↓</button>
        <label className="inline-checkbox">
          <input type="checkbox" checked={card.visible} onChange={onToggle} /> Visible
        </label>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { user } = useAuth()
  const { data: cards, isLoading, error } = useDashboard()
  const saveLayout = useSaveDashboardLayout()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DashboardCard[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    // Only reseed the draft from fresh server data while NOT actively
    // editing — otherwise a background refetch mid-customize-session
    // (e.g. window refocus) would silently discard in-progress reorder/
    // visibility changes the user hasn't saved yet.
    if (!editing && cards) setDraft(cards)
  }, [cards, editing])

  if (isLoading) return <div className="page-status">Loading dashboard…</div>
  if (error) return <div className="page-status page-status-error">Could not load the dashboard.</div>
  if (!user || !draft) return null

  function startEditing() {
    setSaveError(null)
    setDraft(cards ?? [])
    setEditing(true)
  }

  function toggleVisible(key: string) {
    setDraft((d) => (d ?? []).map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))
  }

  function move(index: number, dir: -1 | 1) {
    setDraft((d) => {
      const list = [...(d ?? [])]
      const target = index + dir
      if (target < 0 || target >= list.length) return list
      ;[list[index], list[target]] = [list[target], list[index]]
      return list
    })
  }

  async function handleSave() {
    setSaveError(null)
    try {
      await saveLayout.mutateAsync(
        (draft ?? []).map((c, i) => ({ card_key: c.key, order: i * 10, visible: c.visible })),
      )
      setEditing(false)
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save your dashboard layout.'))
    }
  }

  const visibleCards = (cards ?? []).filter((c) => c.visible)

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <h1>Welcome, {user.name || user.username}</h1>
          <p className="muted">Your customizable home screen — summary stats and shortcuts.</p>
        </div>
        {!editing && (
          <button type="button" className="btn-secondary" onClick={startEditing}>Customize</button>
        )}
      </div>

      {!editing && (
        <div className="dashboard-grid">
          {visibleCards.length === 0 && (
            <div className="page-status">No cards are visible — click Customize to add some back.</div>
          )}
          {visibleCards.map((c) => <CardTile key={c.key} card={c} />)}
        </div>
      )}

      {editing && (
        <section className="dashboard-customize">
          <p className="muted">
            Reorder or hide cards, then Save. Hidden cards stay in this list so you can bring them back later.
          </p>
          {saveError && <div className="form-error">{saveError}</div>}
          <div className="dash-customize-list">
            {draft.map((c, i) => (
              <CustomizeRow
                key={c.key}
                card={c}
                isFirst={i === 0}
                isLast={i === draft.length - 1}
                onToggle={() => toggleVisible(c.key)}
                onMove={(dir) => move(i, dir)}
              />
            ))}
          </div>
          <div className="admin-page-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)} disabled={saveLayout.isPending}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saveLayout.isPending}>
              {saveLayout.isPending ? 'Saving…' : 'Save layout'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
