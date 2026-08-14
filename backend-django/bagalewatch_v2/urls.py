"""
URL configuration for bagalewatch_v2.

Deliberately versioned under /api/v2/ (distinct from the v1 system's
/api/v1/ endpoints in bagalewatch_api.py) so both APIs could theoretically
run reachable at the same time during migration without any path clash —
though in practice they're on entirely different ports/hosts anyway (see
docs/RUNBOOK.md).
"""
from django.conf import settings
from django.contrib import admin
from django.urls import path, include, re_path
from django.views.static import serve as serve_media
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v2/', include('core.urls')),
    path('api/v2/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/v2/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    # External data-exchange API (2026-08-12) — API-key authenticated
    # (core/api_auth.py), NOT the React app's JWT contract above. Its own
    # top-level prefix, distinct from both /api/v2/ (this app) and v1's
    # own /api/v1/ (see this file's own module docstring on why /api/v2/
    # was chosen in the first place) — see core/external_api.py's module
    # docstring for the full feature scope.
    path('api/external/v1/', include('core.external_urls')),
]

# Uploaded branding logo + menu icons (2026-08-08) — CORRECTED same day
# after live testing: the previous comment here assumed "a real deployment
# behind nginx/gunicorn serves /media/ directly," but that's not true for
# this app. docker-compose.yml's `frontend` container's nginx.conf only
# serves the built SPA (no /api/ or /media/ proxy block at all) — the
# React app calls the django container directly via VITE_DJANGO_API_URL
# (http://localhost:8000), matching CORS_ALLOWED_ORIGINS in .env. And
# Django's own static() helper for MEDIA_URL is a no-op whenever
# DEBUG=False — which this app's real .env always sets (DEBUG=0), same
# fact that caused the SECURE_SSL_REDIRECT regression earlier the same
# day. Net effect: nothing was ever serving /media/, in dev OR in the
# Docker Compose stack — confirmed live (uploaded a real menu icon,
# got Django's default DEBUG=False 404 page for its URL). Registered
# unconditionally via django.views.static.serve instead, so it works
# regardless of DEBUG. This is dev-quality serving (single-threaded,
# no caching headers) — fine for this app's actual scale (small internal
# NTC O&M tool), but note uploaded files still live only in the django
# container's writable layer with no volume mount in docker-compose.yml,
# so they won't survive a container rebuild. Worth a volume in a later
# pass if that matters; out of scope for this fix.
urlpatterns += [
    re_path(r'^media/(?P<path>.*)$', serve_media, {'document_root': settings.MEDIA_ROOT}),
]
