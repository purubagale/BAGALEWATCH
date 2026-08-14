import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// 2026-08-07 NTC branding pass — user-selectable dark/light theme, per
// explicit request ("keep both theme and allow user to change theme with
// selection by themselves"). The actual color values live entirely in
// App.css as CSS custom properties (`:root` = dark, `:root[data-theme=
// 'light']` = light) — this context's only job is deciding WHICH one
// applies right now and remembering that choice, by setting
// `document.documentElement.dataset.theme` and mirroring it to
// localStorage. Plain `useState` + `useEffect` rather than a state
// library, matching this app's existing "small, boring tooling" bias
// (see App.css's own opening comment).
export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'bagalewatch_theme'

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return stored === 'light' ? 'light' : 'dark'
}

export interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
  setTheme: (t: Theme) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  // Dark stays the implicit default (no `data-theme` attribute at all)
  // so existing users' first load after this ships is pixel-identical to
  // before — only setting `data-theme="light"` changes anything visually.
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.dataset.theme = 'light'
    } else {
      delete document.documentElement.dataset.theme
    }
    window.localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  function setTheme(t: Theme) {
    setThemeState(t)
  }
  function toggleTheme() {
    setThemeState((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>{children}</ThemeContext.Provider>
}

// Same fail-safe pattern as useSearchModal (SearchModalContext.tsx) — a
// missing provider should never crash a page, just fall back to dark.
const noopTheme: ThemeContextValue = { theme: 'dark', toggleTheme: () => {}, setTheme: () => {} }

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? noopTheme
}
