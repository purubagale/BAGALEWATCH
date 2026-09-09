import { useEffect, useRef, useState } from 'react'

// Searchable dropdown standing in for a plain <select> (2026-09-08,
// "add search option also in filter in map") -- Region has 7 provinces
// (fine as a plain select) but District has ~77 entries once a province
// narrows it, and scrolling a native <select> that long is painful. This
// swaps in a text-filterable list instead, matching the reference's own
// "click the field, a search box + filtered list appears below it" UX.
// Deliberately its own small component rather than inlined in
// SitesPage.tsx -- both Region and District need the exact same
// open/search/click-outside behavior, just different option lists.
interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder: string
  searchPlaceholder: string
  ariaLabel: string
}

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on an outside click -- same pattern as any other dropdown/menu
  // in this app (checked against the root wrapper, not just the panel,
  // so a click on the trigger button itself while open is handled by its
  // own onClick toggle rather than being treated as "outside").
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  // Fresh search box + auto-focus every time the panel opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options

  function choose(v: string) {
    onChange(v)
    setOpen(false)
  }

  return (
    <div className="searchable-select" ref={rootRef}>
      <button
        type="button"
        className="searchable-select-trigger"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? '' : 'searchable-select-placeholder'}>{value || placeholder}</span>
        <span className="searchable-select-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="searchable-select-panel">
          <input
            ref={inputRef}
            type="text"
            className="searchable-select-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
          />
          <div className="searchable-select-list" role="listbox">
            <button
              type="button"
              className={`searchable-select-option${value === '' ? ' active' : ''}`}
              onClick={() => choose('')}
            >
              {placeholder}
            </button>
            {filtered.map((o) => (
              <button
                key={o}
                type="button"
                className={`searchable-select-option${value === o ? ' active' : ''}`}
                onClick={() => choose(o)}
              >
                {o}
              </button>
            ))}
            {filtered.length === 0 && <div className="searchable-select-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  )
}
