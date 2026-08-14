import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import ErrorBoundary from './components/ErrorBoundary'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Default staleTime (2026-08-05, perf pass) — previously unset,
      // which TanStack Query treats as 0 ("stale immediately"). Combined
      // with refetchOnWindowFocus already being off, the practical effect
      // was still a background refetch every time a query's component
      // remounted (e.g. leaving Thresholds/Tree/Users and coming back).
      // Most of this data (KPI thresholds, tree structure, user list,
      // permission matrix) doesn't change from one admin click to the
      // next within a session; 30s means a page you keep switching back
      // to reuses its cached data instead of re-fetching every time, while
      // still catching a real edit made elsewhere within half a minute.
      // Per-query overrides (e.g. useSites()'s existing 60_000) still win
      // over this default where a specific query already set one.
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
