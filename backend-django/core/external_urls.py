# External data-exchange API (2026-08-12) — mounted at
# /api/external/v1/ by bagalewatch_v2/urls.py, deliberately its own
# urlconf module rather than folded into core/urls.py's router: every
# view here is API-key authenticated (core/api_auth.py), not JWT, and
# keeping them in a visibly separate file makes that split obvious at a
# glance rather than requiring a reader to check each view's
# authentication_classes individually.
from django.urls import path

from . import external_api

urlpatterns = [
    path('sites/', external_api.ExternalSiteListCreateView.as_view(), name='ext-sites'),
    path('sites/<str:site_id>/', external_api.ExternalSiteDetailView.as_view(), name='ext-site-detail'),
    path('dt-sessions/', external_api.ExternalDtSessionListCreateView.as_view(), name='ext-dt-sessions'),
    path('dt-sessions/<int:session_id>/', external_api.ExternalDtSessionDetailView.as_view(), name='ext-dt-session-detail'),
    path('dt-sessions/<int:session_id>/samples/', external_api.ExternalDtSampleListCreateView.as_view(), name='ext-dt-session-samples'),
]
