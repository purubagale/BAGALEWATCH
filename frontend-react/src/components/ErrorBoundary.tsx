import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// Whole-app safety net (2026-08-07) — added after a real user-reported
// browser crash (blank white page) while using Advanced Site Search. The
// actual root cause there was an unbounded results table (see
// AdvancedSiteSearchModal.tsx's RESULTS_RENDER_LIMIT fix), but
// investigating it surfaced a real, separate gap: this app had NO error
// boundary anywhere. Before this, ANY uncaught exception during render —
// from that bug, or any future one, anywhere in the tree — unmounted the
// entire React app with zero recovery UI, which to a user is
// indistinguishable from an actual crash: a blank white page, no error
// message, no way back except guessing to hit reload.
//
// This does NOT fix any specific bug (that's the render-cap fix above).
// It makes the *next* uncaught error recoverable and visible instead of
// silent — a reload button and a real error in the console instead of
// nothing at all.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page-status page-status-error" style={{ padding: 32, maxWidth: 560, margin: '48px auto' }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong.</h2>
          <p>This page hit an unexpected error and couldn't keep rendering. Reloading usually fixes it.</p>
          <button type="button" className="btn-primary btn-small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
