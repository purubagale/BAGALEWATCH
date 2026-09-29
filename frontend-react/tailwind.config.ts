import type { Config } from 'tailwindcss'

// nt-frontend skill trial (2026-09-29, "added nt-frontend.skill file...
// lets test this frontend in our application locally first, will decide
// later to use it or not") -- scoped to ONLY src/styleTest/'s own files
// via `content` below, so Tailwind's JIT never scans (and therefore
// never generates utility classes for) the rest of this app's existing
// plain-CSS pages. `preflight: false` is the other half of that
// isolation: preflight resets element defaults (h1/button/input/etc) by
// TAG NAME globally, which would silently change how every other
// existing page's plain HTML renders even though the `content` scan
// restriction already keeps Tailwind's generated utility CLASSES out of
// them.
//
// Design tokens below are a direct port of nt-frontend.skill's own
// Section 3 token table, under a `--nt-` prefixed CSS variable namespace
// (styleTest/tailwind.css) rather than the skill's own bare `--primary`/
// `--background` names -- this app's real App.css already has its own
// `--bg-app`/`--brand-primary`/etc tokens; a bare, unprefixed name here
// risks accidentally colliding with (or shadowing) something the rest of
// the app already relies on, which a scoped test page should never do.
const config: Config = {
  content: ['./src/styleTest/**/*.{ts,tsx}'],
  darkMode: ['class'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--nt-border))',
        input: 'hsl(var(--nt-input))',
        ring: 'hsl(var(--nt-ring))',
        background: 'hsl(var(--nt-background))',
        foreground: 'hsl(var(--nt-foreground))',
        primary: {
          DEFAULT: 'hsl(var(--nt-primary))',
          hover: 'hsl(var(--nt-primary-hover))',
          foreground: 'hsl(var(--nt-primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--nt-secondary))',
          foreground: 'hsl(var(--nt-secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--nt-muted))',
          foreground: 'hsl(var(--nt-muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--nt-accent))',
          foreground: 'hsl(var(--nt-accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--nt-destructive))',
          foreground: 'hsl(var(--nt-destructive-foreground))',
        },
        card: 'hsl(var(--nt-card))',
        sidebar: {
          DEFAULT: 'hsl(var(--nt-sidebar-background))',
          border: 'hsl(var(--nt-sidebar-border))',
          foreground: 'hsl(var(--nt-sidebar-foreground))',
          accent: 'hsl(var(--nt-sidebar-accent))',
          'accent-foreground': 'hsl(var(--nt-sidebar-accent-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--nt-radius)',
        md: 'calc(var(--nt-radius) - 2px)',
        sm: 'calc(var(--nt-radius) - 4px)',
      },
      keyframes: {
        gradientShift: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
      },
      animation: {
        gradientShift: 'gradientShift 15s ease infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
