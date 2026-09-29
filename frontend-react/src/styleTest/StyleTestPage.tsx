import { useState } from 'react'
import { LogOut, Menu, Moon, Settings, Sun, Users } from 'lucide-react'
import { cn } from './lib/utils'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from './components/ui/dialog'
import './tailwind.css'

// nt-frontend.skill trial page (2026-09-29, "added nt-frontend.skill
// file... lets test this frontend in our application locally first,
// will decide later to use it or not"). Deliberately NOT wired into
// this app's real routing/data — a standalone showcase of the skill's
// own guidelines (design tokens, sidebar nav item states, table styling,
// theme toggle, footer, Section 10's forbidden-pattern list), reachable
// only by navigating to /style-test directly (deliberately not linked
// from the real sidebar/menu) -- see App.tsx's own "nt-frontend skill
// trial" comment for the one lazy import + one <Route> that wires it
// in; removing this trial later is deleting this styleTest/ folder plus
// those same two lines.
//
// This app's real Layout (header/sidebar) still mounts underneath this
// page (React Router has no route-level way to opt OUT of the single
// top-level <Layout> wrapping every route in App.tsx) -- the `fixed
// inset-0 z-[9999]` wrapper below just visually covers it, so what's
// actually on screen is a true full-viewport preview of nt-frontend's
// own look, not a page squeezed into this app's existing chrome.
const NAV_ITEMS = [
  { key: 'sites', label: 'Sites', icon: Users, active: true },
  { key: 'settings', label: 'Settings', icon: Settings, active: false },
] as const

const TABLE_ROWS = [
  { name: 'WDR096_BHUMILCHOWK', date: '2026-09-27' },
  { name: 'KTM200_MAHARAJGUNJ', date: '2026-09-28' },
  { name: 'EDR006_CHHINNAI', date: '2026-09-29' },
]

function SidebarNavItem({
  icon: Icon, label, active, collapsed,
}: {
  icon: typeof Users
  label: string
  active: boolean
  collapsed: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-auto rounded-md transition-all duration-200 group relative overflow-hidden cursor-pointer flex items-center w-full',
        collapsed ? 'py-2 px-0 justify-center' : 'py-2 px-3',
        active ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-primary/10 hover:text-primary font-medium',
      )}
    >
      <span
        className={cn(
          'relative flex items-center justify-center rounded-lg transition-all duration-200',
          collapsed ? 'w-9 h-9' : 'w-5 h-5',
        )}
      >
        <Icon className={cn('flex-shrink-0 transition-transform duration-200 h-5 w-5', active ? 'text-primary' : 'text-foreground')} />
      </span>
      {!collapsed && <span className="whitespace-nowrap truncate text-sm relative z-10 ml-2 flex-1 text-left">{label}</span>}
    </button>
  )
}

function ThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="relative overflow-hidden" onClick={onToggle}>
      <span className={cn('absolute inset-0 flex items-center justify-center transition-all duration-300', isDark ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 rotate-90 scale-50')}>
        <Sun className="h-5 w-5" />
      </span>
      <span className={cn('absolute inset-0 flex items-center justify-center transition-all duration-300', isDark ? 'opacity-0 -rotate-90 scale-50' : 'opacity-100 rotate-0 scale-100')}>
        <Moon className="h-5 w-5" />
      </span>
    </Button>
  )
}

export default function StyleTestPage() {
  const [isDark, setIsDark] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const currentYear = new Date().getFullYear()

  return (
    <div className={cn('nt-style-test fixed inset-0 z-[9999] overflow-y-auto bg-background text-foreground', isDark && 'dark')}>
      <div className="flex min-h-full">
        {/* ── Sidebar (Section 4) ── */}
        <aside
          className={cn(
            'border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex-shrink-0 h-full shadow-sm transition-all duration-200',
            collapsed ? 'w-16 px-2' : 'w-56 px-4',
            'pt-6 pb-6',
          )}
        >
          <div className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <SidebarNavItem key={item.key} icon={item.icon} label={item.label} active={item.active} collapsed={collapsed} />
            ))}
          </div>
          <div className="mt-auto py-3 border-t border-sidebar-border">
            <button type="button" className="flex items-center gap-2 text-sm text-sidebar-foreground hover:text-primary cursor-pointer">
              <LogOut className="h-4 w-4" />
              {!collapsed && 'Sign out'}
            </button>
          </div>
        </aside>

        <div className="flex-1 flex flex-col">
          {/* ── Header w/ collapsible toggle (Section 4C) + theme toggle (Section 8) ── */}
          <header className="bg-primary text-primary-foreground h-[60px] flex items-center justify-between px-4 shadow-sm">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10 active:scale-95 transition-all"
                onClick={() => setCollapsed((c) => !c)}
              >
                <Menu className={cn('h-5 w-5 transition-transform duration-300 ease-in-out', collapsed ? '' : 'rotate-180')} />
              </Button>
              <span className="font-semibold">NT-PMS style trial</span>
              <span className="text-xs text-[#E6B646] font-semibold">nt-frontend.skill</span>
            </div>
            <ThemeToggle isDark={isDark} onToggle={() => setIsDark((d) => !d)} />
          </header>

          <main className="flex-1 p-6 flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>What this page is</CardTitle>
                <CardDescription>
                  A standalone trial of nt-frontend.skill's own guidelines — Tailwind CSS v3 design tokens, a
                  collapsible sidebar, table styling, theme switching, buttons, and a Radix dialog. Not wired into
                  this app's real data or navigation.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button>Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="ghost">Ghost</Button>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="link">Open a dialog</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Radix Dialog</DialogTitle>
                      <DialogDescription>
                        This is @radix-ui/react-dialog wrapped in the shadcn/ui pattern the skill specifies.
                      </DialogDescription>
                    </DialogHeader>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>

            {/* ── Standard table (Section 9) ── */}
            <div className="w-full overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-primary text-primary-foreground dark:bg-card">
                  <tr>
                    <th className="p-4 text-left font-medium">Session</th>
                    <th className="p-4 text-left font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {TABLE_ROWS.map((row) => (
                    <tr key={row.name} className="border-b border-border hover:bg-muted/50 transition-colors">
                      <td className="p-4 font-semibold text-foreground">{row.name}</td>
                      <td className="p-4">{row.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Login gradient background preview (Section 5B) ── */}
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Login gradient preview</CardTitle>
                <CardDescription>Section 5B's sliding animated gradient, forced-light styling.</CardDescription>
              </CardHeader>
              <div className="nt-gradient-background h-32 flex items-center justify-center">
                <span className="text-white font-semibold text-lg">Nepal Telecom</span>
              </div>
            </Card>
          </main>

          {/* ── Footer (Section 6) ── */}
          <footer className="border-t border-border bg-background py-4 w-full">
            <div className="container mx-auto px-6 flex flex-col items-center justify-center gap-1.5 text-sm text-muted-foreground">
              <p className="text-center font-medium">
                &copy; {currentYear} Procurement Management System - Nepal Telecom. All rights reserved.
              </p>
              <p className="text-xs text-center">
                Developed By: <span className="text-primary font-bold">ITD , Software and Security Wing</span>
              </p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
