import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on 5180 — part of the isolated port range for the v2 stack
// (Django 8000, Node 8090, Go 8070, this on 5180, Postgres 5432, Redis
// 6379), chosen so the whole new system can run alongside the untouched
// v1 system (ports 8080/8081) without any conflict. See ../docs/RUNBOOK.md.
// `server.proxy` (2026-08-10) — mirrors nginx.conf's own /api//media/
// proxy blocks for local `npm run dev` (non-Docker), so local dev also
// defaults to same-origin requests instead of needing
// VITE_DJANGO_API_URL pointed at a separate port. Targets `localhost`
// here (not `django`, nginx.conf's Docker-network service name) since
// this only ever runs on a developer's own machine against a locally-run
// `manage.py runserver`/docker-composed django with 8000 published —
// same-origin in the BROWSER either way, this is just how Vite's dev
// server reaches django to fulfill that same-origin illusion.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8000',
      '/media': 'http://localhost:8000',
      '/admin': 'http://localhost:8000',
    },
  },
  preview: {
    port: 5180,
    strictPort: true,
  },
})
