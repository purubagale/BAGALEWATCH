from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from . import api_auth, backup, dashboard, drive_test, exports, kpi_trend, reports, rf_audit, site_import, views

router = DefaultRouter()
router.register('sites', views.SiteViewSet, basename='site')
router.register('permissions', views.MenuPermissionViewSet, basename='menu-permission')
router.register('users', views.UserViewSet, basename='user')
router.register('dt-sessions', drive_test.DriveTestSessionViewSet, basename='dt-session')
router.register('menu-items', views.MenuItemViewSet, basename='menu-item')
# Superadmin-only management of external API credentials (2026-08-12) —
# see core/api_auth.py's ApiKeyViewSet docstring. Distinct from the
# API-key-AUTHENTICATED endpoints those keys unlock, which live under
# /api/external/v1/ (core/external_urls.py) — this one is a normal
# JWT-authenticated /api/v2/ admin resource, same as users/menu-items.
router.register('api-keys', api_auth.ApiKeyViewSet, basename='api-key')

urlpatterns = [
    path('health/', views.health, name='health'),

    path('auth/login/', views.LoginView.as_view(), name='auth-login'),
    path('auth/logout/', views.LogoutView.as_view(), name='auth-logout'),
    path('auth/me/', views.MeView.as_view(), name='auth-me'),
    path('auth/refresh/', TokenRefreshView.as_view(), name='auth-refresh'),

    # Registered BEFORE the router's `sites/<pk>/` include below —
    # Django matches urlpatterns top-to-bottom, so this literal path must
    # win over the router's dynamic pk pattern (which would otherwise
    # treat "search" itself as a site ID lookup).
    path('sites/search/', views.SiteSearchView.as_view(), name='site-search'),
    path('sites/<str:site_id>/sectors/', views.SiteSectorListView.as_view(), name='site-sectors'),

    # Phase 2 — these match v1's actual /api/v1/thresholds, /tree, and
    # /permissions contracts (flat GET/PUT resources with their own
    # upsert/full-replace semantics, not generic REST collections), so
    # they're plain paths rather than router-registered ViewSets.
    path('thresholds/', views.ThresholdsView.as_view(), name='thresholds'),
    # DELETE-only, beyond-v1-parity addition — see ThresholdDetailView's
    # docstring for why v1 has nothing to mirror here.
    path('thresholds/<str:kpi_key>/', views.ThresholdDetailView.as_view(), name='threshold-detail'),
    path('tree/', views.TreeView.as_view(), name='tree'),
    path('permissions-matrix/', views.PermissionsMatrixView.as_view(), name='permissions-matrix'),
    # 2026-08-05, v2-only (no v1 equivalent) — see DtBandsView's docstring.
    path('dt-bands/', views.DtBandsView.as_view(), name='dt-bands'),
    # Dynamic top-nav (2026-08-08, v2-only) — see MenuTreeView's docstring.
    # Registered before the router's `menu-items/<pk>/` include below for
    # the same reason as sites/search/ above: a literal path must win over
    # the router's dynamic pk pattern.
    path('menu-tree/', views.MenuTreeView.as_view(), name='menu-tree'),
    # Customizable branding — logo + app name (2026-08-08, v2-only) — see
    # BrandingSettingsView's docstring.
    path('branding/', views.BrandingSettingsView.as_view(), name='branding'),
    # Customizable Dashboard home page (2026-08-08, v2-only) — see
    # core/dashboard.py's module docstring.
    path('dashboard/', dashboard.DashboardView.as_view(), name='dashboard'),

    # Backup & Restore (2026-08-05) — see core/backup.py's module docstring.
    path('backup/summary/', backup.BackupSummaryView.as_view(), name='backup-summary'),
    path('backup/export/', backup.BackupExportView.as_view(), name='backup-export'),
    path('backup/import/', backup.BackupImportView.as_view(), name='backup-import'),
    # Add-only site/sector import from an uploaded Excel/CSV file
    # (2026-08-05) — see core/site_import.py's module docstring.
    path('backup/import-sites/', site_import.ImportSitesView.as_view(), name='backup-import-sites'),
    # District/region backfill for sites missing them (2026-08-10) — see
    # site_import.py's BackfillSiteLocationView docstring for why the
    # actual district resolution happens client-side.
    path('backup/backfill-location/', site_import.BackfillSiteLocationView.as_view(), name='backup-backfill-location'),
    # Excel exports (2026-08-05) — see core/exports.py's module docstring.
    path('export/sites.xlsx', exports.SiteExportXlsxView.as_view(), name='export-sites-xlsx'),

    # Phase 3 — reporting suite (read-only aggregation, see core/reports.py).
    path('sla/', reports.SlaReportView.as_view(), name='sla-report'),
    path('nta/', reports.NtaReportView.as_view(), name='nta-report'),
    path('monthly-report/', reports.MonthlyReportView.as_view(), name='monthly-report'),
    path('scatter/', reports.ScatterDataView.as_view(), name='scatter-data'),
    path('kpi-trend/', kpi_trend.KpiTrendView.as_view(), name='kpi-trend'),
    path('rf-audit/data/', rf_audit.RfAuditDataView.as_view(), name='rf-audit-data'),
    path('rf-audit/history/', rf_audit.AuditHistoryListView.as_view(), name='rf-audit-history'),
    path('rf-audit/history/<int:pk>/', rf_audit.AuditHistoryDetailView.as_view(), name='rf-audit-history-detail'),

    path('', include(router.urls)),
]
