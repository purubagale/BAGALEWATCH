from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from . import (alarms, api_auth, area_sample, audit, auth_log, backup, call_context, collection, consent, dashboard, device_identity,
               device_lookup, device_trace, drive_test, dt_retention, emergency, environment,
               exports, ip_block, issues, kpi_trend, mfa, password_reset, problem_live, problem_notify, problem_related, problem_report, problem_sites, provisioning, reports, rescue, rf_audit,
               rf_reports, roles, sector_stats, site_import, site_coverage, site_photo, speed_test, sso_views, subscriber_link, subscriber_profile, system_doc,
               telemetry_admin, telemetry_near, views, volte_quality)
from . import cell_kpi
from . import coverage_prediction
from . import problem_oss

router = DefaultRouter()
router.register('sites', views.SiteViewSet, basename='site')
router.register('permissions', views.MenuPermissionViewSet, basename='menu-permission')
router.register('users', views.UserViewSet, basename='user')
router.register('dt-sessions', drive_test.DriveTestSessionViewSet, basename='dt-session')
# Optimization activities (2026-09-12) — groups a set of existing
# DriveTestSession rows into one named before/after-change optimization
# effort. See OptimizationActivityViewSet's docstring in drive_test.py.
router.register('dt-activities', drive_test.OptimizationActivityViewSet, basename='dt-activity')
# Site/Sector issue tracker (2026-09-14) -- see IssueViewSet's docstring
# in core/issues.py.
router.register('issues', issues.IssueViewSet, basename='issue')
# Vendor RNO report importer (2026-09-15) -- see
# RfOptimizationReportViewSet's docstring in core/rf_reports.py.
router.register('rf-reports', rf_reports.RfOptimizationReportViewSet, basename='rf-report')
router.register('menu-items', views.MenuItemViewSet, basename='menu-item')
# Superadmin-only CRUD for custom role definitions (2026-10-01, "full
# parity" RBAC feature) -- see core/roles.py's module docstring.
router.register('roles', roles.RoleViewSet, basename='role')
# Superadmin-only management of external API credentials (2026-08-12) —
# see core/api_auth.py's ApiKeyViewSet docstring. Distinct from the
# API-key-AUTHENTICATED endpoints those keys unlock, which live under
# /api/external/v1/ (core/external_urls.py) — this one is a normal
# JWT-authenticated /api/v2/ admin resource, same as users/menu-items.
router.register('api-keys', api_auth.ApiKeyViewSet, basename='api-key')
# Superadmin-only CRUD for the crowdsourced-telemetry ingest credentials
# (2026-08-31). The keys managed here authenticate the SEPARATE public
# ingest surface at /api/telemetry/v1/ (core/telemetry_urls.py) — same
# split as api-keys above vs /api/external/v1/. See core/telemetry_admin.py.
router.register('telemetry/keys', telemetry_admin.TelemetryIngestKeyViewSet, basename='telemetry-key')

urlpatterns = [
    path('health/', views.health, name='health'),
    path('system-health/', views.SystemHealthView.as_view(), name='system-health'),

    path('auth/login/', views.LoginView.as_view(), name='auth-login'),
    path('auth/logout/', views.LogoutView.as_view(), name='auth-logout'),
    path('auth/me/', views.MeView.as_view(), name='auth-me'),
    path('auth/refresh/', TokenRefreshView.as_view(), name='auth-refresh'),

    # Forgot/change password (2026-10-02) -- see core/password_reset.py's
    # module docstring for why these are two independent flows in one file.
    path('auth/password-reset/', password_reset.PasswordResetRequestView.as_view(), name='auth-password-reset'),
    path('auth/password-reset/confirm/', password_reset.PasswordResetConfirmView.as_view(), name='auth-password-reset-confirm'),
    path('auth/change-password/', password_reset.ChangePasswordView.as_view(), name='auth-change-password'),

    # MFA / TOTP (2026-10-02, Phase C) -- see core/mfa.py's module
    # docstring. /status, /enroll/start, /enroll/confirm, /disable are all
    # IsAuthenticated (voluntary self-service, any time); /verify is
    # AllowAny -- it's reached mid-login, before the user has a JWT, using
    # the short-lived ticket /auth/login/ hands back instead.
    path('auth/mfa/status/', mfa.MFAStatusView.as_view(), name='auth-mfa-status'),
    path('auth/mfa/enroll/start/', mfa.MFAEnrollStartView.as_view(), name='auth-mfa-enroll-start'),
    path('auth/mfa/enroll/confirm/', mfa.MFAEnrollConfirmView.as_view(), name='auth-mfa-enroll-confirm'),
    path('auth/mfa/disable/', mfa.MFADisableView.as_view(), name='auth-mfa-disable'),
    path('auth/mfa/verify/', mfa.MFAVerifyView.as_view(), name='auth-mfa-verify'),

    # Keycloak SSO (2026-08-23). Additive: /auth/login/ above is untouched,
    # and `POST auth/sso/token/` returns the SAME payload shape it does, so
    # the frontend's existing login path handles both identically.
    path('auth/sso/login/', sso_views.SSOLoginView.as_view(), name='auth-sso-login'),
    path('auth/sso/callback/', sso_views.SSOCallbackView.as_view(), name='auth-sso-callback'),
    path('auth/sso/token/', sso_views.SSOTokenExchangeView.as_view(), name='auth-sso-token'),

    # Login/access audit trail (2026-10-01) -- see core/auth_log.py's
    # module docstring. Superadmin-only read of every sign-in attempt,
    # local or SSO, successful or not.
    path('auth-events/', auth_log.AuthEventLogListView.as_view(), name='auth-event-log'),

    # Unified Audit Log (2026-10-01) -- merges AuthEventLog (access events,
    # above) with the new AuditEvent (data-change events) into one
    # searchable, exportable feed. See core/audit.py's module docstring.
    # Replaces AccessLogPage.tsx's old narrower view (the underlying
    # /auth-events/ endpoint above stays, just no longer linked from the
    # frontend's nav).
    path('audit-log/', audit.AuditLogListView.as_view(), name='audit-log'),
    path('audit-log/export.csv', audit.AuditLogExportView.as_view(), name='audit-log-export'),

    # Active IP blocking (2026-10-02, Phase E2) -- escalates the Audit
    # Log's own suspicious-burst detection into actual enforcement. See
    # core/ip_block.py's module docstring.
    # Crowd and staff identity, collection sessions, emergency switch (2026-10-05).
    path('device-identities/', device_identity.DeviceIdentityLookupView.as_view(), name='device-identities'),
    path('collection-sessions/', collection.CollectionSessionListView.as_view(), name='collection-sessions'),
    path('collection-sessions/<uuid:pk>/samples/', collection.CollectionSessionSamplesView.as_view(),
         name='collection-session-samples'),
    # Readings per serving sector (2026-10-19) -- see core/sector_stats.py.
    path('collection-sessions/<uuid:pk>/sectors/', sector_stats.CollectionSessionSectorsView.as_view(),
         name='collection-session-sectors'),
    path('dt-sessions/<int:pk>/sectors/', sector_stats.DriveTestSessionSectorsView.as_view(), name='dt-session-sectors'),
    path('emergency/', emergency.EmergencyStatusView.as_view(), name='emergency-status'),
    path('emergency/declare/', emergency.EmergencyDeclareView.as_view(), name='emergency-declare'),
    path('emergency/end/', emergency.EmergencyEndView.as_view(), name='emergency-end'),
    path('blocked-ips/', ip_block.BlockedIPListView.as_view(), name='blocked-ips-list'),
    path('blocked-ips/<str:ip>/unblock/', ip_block.BlockedIPUnblockView.as_view(), name='blocked-ips-unblock'),

    # Registered BEFORE the router's `sites/<pk>/` include below —
    # Django matches urlpatterns top-to-bottom, so this literal path must
    # win over the router's dynamic pk pattern (which would otherwise
    # treat "search" itself as a site ID lookup).
    path('sites/search/', views.SiteSearchView.as_view(), name='site-search'),
    path('sites/<str:site_id>/sectors/', views.SiteSectorListView.as_view(), name='site-sectors'),
    # Live Site Directory multi-source sync admin (2026-09-08 — see
    # LiveSiteSource's docstring in core/models.py). Registered before the
    # router's `sites/<pk>/` include below for the same reason as
    # sites/search/ above: `sites/sync-live/...` must win over the
    # router's dynamic `sites/<pk>/` pattern. The nested `/sources/...`
    # paths are naturally safe from that same collision on their own
    # (DRF's default pk-capture regex excludes '/'), but are kept
    # alongside the others here for readability.
    path(
        'sites/sync-live/sources/', site_import.LiveSiteSourceListView.as_view(),
        name='sites-sync-live-sources',
    ),
    path(
        'sites/sync-live/sources/<int:pk>/', site_import.LiveSiteSourceDetailView.as_view(),
        name='sites-sync-live-source-detail',
    ),
    path(
        'sites/sync-live/sources/<int:pk>/sync/', site_import.LiveSiteSourceSyncView.as_view(),
        name='sites-sync-live-source-sync',
    ),

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
    # Per-role sidebar-visibility overrides (2026-10-01, "full parity" RBAC
    # feature, Menu Visibility page) -- see MenuItemRoleVisibilityView's
    # own docstring in views.py.
    path('menu-visibility/', views.MenuItemRoleVisibilityView.as_view(), name='menu-visibility'),
    # One user's full role set (2026-10-01, Assign Roles page) -- see
    # UserRolesView's own docstring in core/roles.py. Registered before the
    # router's `users/<pk>/` include below, same reason as sites/search/
    # above: this literal suffix must win over the router's dynamic pk
    # pattern.
    path('users/<int:pk>/roles/', roles.UserRolesView.as_view(), name='user-roles'),
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
    # Superadmin-controlled MFA-mandatory toggle (2026-10-02, Phase C) --
    # see SecuritySettingsView's docstring.
    path('security-settings/', views.SecuritySettingsView.as_view(), name='security-settings'),
    path('security-settings/sms-test/', views.SmsTestView.as_view(), name='security-sms-test'),
    path('security-settings/alert-test/', views.AlertTestView.as_view(), name='security-alert-test'),
    # Customizable Dashboard home page (2026-08-08, v2-only) — see
    # core/dashboard.py's module docstring.
    path('dashboard/', dashboard.DashboardView.as_view(), name='dashboard'),

    # Backup & Restore (2026-08-05) — see core/backup.py's module docstring.
    path('backup/summary/', backup.BackupSummaryView.as_view(), name='backup-summary'),
    path('backup/export/', backup.BackupExportView.as_view(), name='backup-export'),
    path('backup/import/', backup.BackupImportView.as_view(), name='backup-import'),
    # Reset-for-live-sync (2026-09-10) -- erases all Site/Sector/KPI-
    # snapshot/tree-assignment data (the UI counterpart of
    # `manage.py clear_sites`) so the app can be repopulated cleanly
    # from the Live Site Directory sync. See SiteDataResetView's
    # docstring in core/backup.py.
    path('backup/reset-sites/', backup.SiteDataResetView.as_view(), name='backup-reset-sites'),
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
    # Generate Current-State System Documentation (2026-10-01) -- see
    # core/system_doc.py's module docstring. Backs the "Generate" button
    # on DocumentationPage.tsx.
    path('system-doc/', system_doc.SystemDocView.as_view(), name='system-doc'),
    path('scatter/', reports.ScatterDataView.as_view(), name='scatter-data'),
    path('kpi-trend/', kpi_trend.KpiTrendView.as_view(), name='kpi-trend'),
    path('rf-audit/data/', rf_audit.RfAuditDataView.as_view(), name='rf-audit-data'),
    path('rf-audit/history/', rf_audit.AuditHistoryListView.as_view(), name='rf-audit-history'),
    path('rf-audit/history/<int:pk>/', rf_audit.AuditHistoryDetailView.as_view(), name='rf-audit-history-detail'),

    # Crowdsourced-telemetry admin surface (2026-08-31) — overview numbers
    # and coverage-map data for the two new sidebar pages. The ingest-key
    # CRUD is router-registered above; these two are plain read endpoints.
    # See core/telemetry_admin.py.
    path('telemetry/stats/', telemetry_admin.TelemetryStatsView.as_view(), name='telemetry-stats'),
    path('telemetry/coverage/', telemetry_admin.TelemetryCoverageView.as_view(), name='telemetry-coverage'),
    path('telemetry/live-samples/', telemetry_admin.TelemetryLiveSamplesView.as_view(), name='telemetry-live-samples'),
    # The phone's speed tests, beside Live Samples (2026-10-15).
    path('telemetry/speed-results/', telemetry_admin.TelemetrySpeedResultsView.as_view(), name='telemetry-speed-results'),
    # VoLTE/VoNR call-quality dev/pilot list view (2026-10-02) -- see
    # core/volte_quality.py's VolteQualityListView docstring. Same
    # superadmin-only, no-MenuItem posture as live-samples above.
    path('telemetry/volte-samples/', volte_quality.VolteQualityListView.as_view(), name='telemetry-volte-samples'),
    # Calls from phones without quality figures (2026-10-14) -- see core/call_context.py.
    path('telemetry/call-samples/', call_context.CallContextListView.as_view(), name='telemetry-call-samples'),
    # Scoped drive-test sessions over the live telemetry pipeline
    # (2026-09-01) — see core/telemetry_admin.py's TelemetryDriveTestSession*
    # views for why these replace TelemetryLiveSamplesView as the
    # promotable, consent-scoped path.
    # Site photos from the mobile app (2026-10-11) -- see core/site_photo.py.
    # Where a site's sectors were actually received (2026-10-13) -- see core/site_coverage.py.
    path('sites/<str:site_id>/measured-coverage/', site_coverage.SiteMeasuredCoverageView.as_view(),
         name='site-measured-coverage'),
    # Problem reports from the app or entered from complaints (2026-10-14) -- see core/problem_report.py.
    path('problem-reports/', problem_report.ProblemReportListView.as_view(), name='problem-reports'),
    path('problem-reports/dashboard/', problem_report.ProblemDashboardView.as_view(), name='problem-dashboard'),
    # The sites around a report, for its full diagnostics (2026-10-19) -- see core/problem_sites.py.
    path('problem-reports/<int:pk>/nearby-sites/', problem_sites.ProblemReportNearbySitesView.as_view(),
         name='problem-report-nearby-sites'),
    path('problem-reports/<int:pk>/notify/', problem_notify.ProblemReportNotifyView.as_view(), name='problem-report-notify'),
    # Live readings for a complaint: around the spot, or from the customer's phone (2026-10-24).
    path('problem-reports/<int:pk>/live/', problem_live.ProblemLiveView.as_view(), name='problem-live'),
    # Active alarms from the alarm middleware, read live (2026-10-26) -- see core/alarms.py.
    path('alarms/active/', alarms.SiteActiveAlarmsView.as_view(), name='alarms-active'),
    path('alarms/sites/', alarms.SitesActiveAlarmsView.as_view(), name='alarms-sites'),  # 2026-10-28, Sites Topology column
    path('alarms/summary/', alarms.AlarmSummaryView.as_view(), name='alarms-summary'),
    path('alarms/source/', alarms.AlarmSourceView.as_view(), name='alarms-source'),
    # Per-cell network KPIs from the KPI team (2026-10-28) -- see core/cell_kpi.py.
    path('cell-kpis/source/', cell_kpi.CellKpiSourceView.as_view(), name='cell-kpi-source'),
    path('cell-kpis/source/fetch/', cell_kpi.CellKpiFetchView.as_view(), name='cell-kpi-fetch'),
    path('sites/<str:site_id>/cell-kpis/', cell_kpi.SiteCellKpiView.as_view(), name='site-cell-kpis'),
    # Radio values for the predicted coverage on the site map (2026-10-28).
    path('coverage-prediction/settings/', coverage_prediction.CoveragePredictionSettingsView.as_view(),
         name='coverage-prediction-settings'),
    # Where phones run the speed test (2026-10-26) -- see core/speed_test.py.
    path('speedtest/settings/', speed_test.SpeedTestSettingsView.as_view(), name='speedtest-settings'),
    # Everything stored that relates to a complaint, for a chosen time range (2026-10-26).
    path('problem-reports/<int:pk>/related/', problem_related.ProblemRelatedView.as_view(), name='problem-related'),
    # Network KPIs of the sites related to a complaint (2026-10-29) -- see core/problem_oss.py.
    path('problem-reports/<int:pk>/oss-kpi/', problem_oss.ProblemOssKpiView.as_view(), name='problem-oss-kpi'),
    path('problem-reports/<int:pk>/live/area/', problem_live.ProblemLiveAreaView.as_view(), name='problem-live-area'),
    path('problem-reports/<int:pk>/live/area/<int:req_id>/', problem_live.ProblemLiveAreaResultsView.as_view(),
         name='problem-live-area-results'),
    path('problem-reports/<int:pk>/live/phone/', problem_live.ProblemLivePhoneView.as_view(), name='problem-live-phone'),
    path('problem-reports/<int:pk>/live/phone/<uuid:trace_id>/', problem_live.ProblemLivePhoneFixesView.as_view(),
         name='problem-live-phone-fixes'),
    path('problem-reports/<int:pk>/live/phone/<uuid:trace_id>/cancel/', problem_live.ProblemLivePhoneCancelView.as_view(),
         name='problem-live-phone-cancel'),
    # Linked systems and their status updates (2026-10-15) -- see core/problem_notify.py.
    path('linked-systems/', problem_notify.LinkedSystemListView.as_view(), name='linked-systems'),
    path('linked-systems/<int:pk>/', problem_notify.LinkedSystemDetailView.as_view(), name='linked-system-detail'),
    path('linked-systems/<int:pk>/secret/', problem_notify.LinkedSystemSecretView.as_view(), name='linked-system-secret'),
    path('linked-systems/<int:pk>/test/', problem_notify.LinkedSystemTestView.as_view(), name='linked-system-test'),
    path('problem-notifications/', problem_notify.ProblemNotificationListView.as_view(), name='problem-notifications'),
    path('problem-notifications/<int:pk>/retry/', problem_notify.ProblemNotificationRetryView.as_view(),
         name='problem-notification-retry'),
    # Everything stored about one mobile number, superadmin (2026-10-15) -- see core/subscriber_profile.py.
    path('subscriber-profile/', subscriber_profile.SubscriberProfileView.as_view(), name='subscriber-profile'),
    # Its signal history by range, session and technology (2026-10-16).
    path('subscriber-profile/signal/', subscriber_profile.SubscriberSignalView.as_view(), name='subscriber-profile-signal'),
    # What the network provisioned, from NTC's ticketing system (2026-10-16) -- see core/provisioning.py.
    path('subscriber-profile/provisioning/', provisioning.SubscriberProvisioningView.as_view(), name='subscriber-profile-provisioning'),
    # Linking a phone's earlier readings by hand (2026-10-15) -- see core/subscriber_link.py.
    path('subscriber-profile/link-candidates/', subscriber_link.LinkCandidatesView.as_view(), name='subscriber-link-candidates'),
    path('subscriber-profile/link-device/', subscriber_link.LinkDeviceView.as_view(), name='subscriber-link-device'),
    path('problem-reports/<int:pk>/', problem_report.ProblemReportDetailView.as_view(), name='problem-report-detail'),
    # Drive-test retention, superadmin (2026-10-14) -- see core/dt_retention.py.
    path('dt-retention/settings/', dt_retention.RetentionSettingsView.as_view(), name='dt-retention-settings'),
    path('dt-retention/runs/', dt_retention.RetentionRunListView.as_view(), name='dt-retention-runs'),
    path('dt-retention/runs/<int:pk>/', dt_retention.RetentionRunDetailView.as_view(), name='dt-retention-run'),
    path('dt-retention/runs/<int:pk>/approve/', dt_retention.RetentionRunApproveView.as_view(), name='dt-retention-approve'),
    path('dt-retention/runs/<int:pk>/discard/', dt_retention.RetentionRunDiscardView.as_view(), name='dt-retention-discard'),
    path('site-photos/', site_photo.SitePhotoListView.as_view(), name='site-photos'),
    path('site-photos/<int:pk>/', site_photo.SitePhotoDetailView.as_view(), name='site-photo-detail'),
    path('site-photos/<int:pk>/image/', site_photo.SitePhotoImageView.as_view(), name='site-photo-image'),
    path('site-photos/<int:pk>/review/', site_photo.SitePhotoReviewView.as_view(), name='site-photo-review'),
    # On-demand area sample (2026-10-08) -- see core/area_sample.py.
    path('telemetry/area-samples/', area_sample.AreaSampleRequestListCreateView.as_view(), name='telemetry-area-samples'),
    # Outdoors / indoors / in a vehicle for a stretch of a session, set afterwards (2026-10-26).
    path('telemetry/environment/', environment.EnvironmentEditView.as_view(), name='telemetry-environment'),
    path('telemetry/area-samples/<int:pk>/samples/', area_sample.AreaSampleRequestSamplesView.as_view(),
         name='telemetry-area-sample-results'),
    # Telemetry sessions around a point, for DT Explore (2026-10-12) -- see core/telemetry_near.py.
    path('telemetry/sessions-near/', telemetry_near.TelemetrySessionsNearView.as_view(), name='telemetry-sessions-near'),
    path('telemetry/dt-sessions/', telemetry_admin.TelemetryDriveTestSessionListCreateView.as_view(), name='telemetry-dt-sessions'),
    path('telemetry/dt-sessions/<int:pk>/', telemetry_admin.TelemetryDriveTestSessionDetailView.as_view(), name='telemetry-dt-session-detail'),
    path('telemetry/dt-sessions/<int:pk>/end/', telemetry_admin.TelemetryDriveTestSessionEndView.as_view(), name='telemetry-dt-session-end'),
    path('telemetry/dt-sessions/<int:pk>/samples/', telemetry_admin.TelemetryDriveTestSessionSamplesView.as_view(), name='telemetry-dt-session-samples'),
    path('telemetry/dt-sessions/<int:pk>/sectors/', sector_stats.TelemetryDriveTestSessionSectorsView.as_view(), name='telemetry-dt-session-sectors'),

    # Rescue-location lookup (2026-09-01) — IsRescueOperator-gated, every
    # call audited. See core/rescue.py.
    path('rescue/lookup/', rescue.RescueLookupView.as_view(), name='rescue-lookup'),
    # Bulk counterpart (2026-09-04) -- checks a whole list of numbers (e.g.
    # an HLR/VLR area extract obtained some other way) against this app's
    # own enrolled-subscriber records in one request. See
    # core/rescue.py's RescueBulkLookupView.
    path('rescue/lookup/bulk/', rescue.RescueBulkLookupView.as_view(), name='rescue-lookup-bulk'),
    # Superadmin-only mandatory/optional consent-policy control (2026-09-02)
    # for the rescue lane — see core/rescue.py's RescueConsentPolicyView.
    path('rescue/policy/', rescue.RescueConsentPolicyView.as_view(), name='rescue-consent-policy'),
    path('rescue/enrolled/', rescue.RescueEnrolledListView.as_view(), name='rescue-enrolled'),
    path('device-location-trace/', device_lookup.DeviceLocationTraceView.as_view(), name='device-location-trace'),
    path('registered-devices/', device_trace.RegisteredDeviceListView.as_view(), name='registered-devices'),
    # Device-bound consent-gated tracing, operator side (2026-10-04) --
    # IsRescueOperator-gated. See core/device_trace.py's docstring.
    path('trace-requests/', device_trace.TraceRequestListCreateView.as_view(), name='trace-requests'),
    path('trace-requests/<uuid:trace_id>/', device_trace.TraceRequestDetailView.as_view(), name='trace-request-detail'),
    path('trace-requests/<uuid:trace_id>/samples/', device_trace.TraceSamplesView.as_view(), name='trace-request-samples'),
    path('trace-requests/<uuid:trace_id>/complete/', device_trace.TraceRequestCompleteView.as_view(), name='trace-request-complete'),
    path('trace-requests/<uuid:trace_id>/phone-consent/', device_trace.TraceRequestPhoneConsentView.as_view(), name='trace-request-phone-consent'),
    path('trace-requests/<uuid:trace_id>/cancel/', device_trace.TraceRequestCancelView.as_view(), name='trace-request-cancel'),
    # Superadmin-editable copy for the drive-test consent prompt
    # (2026-09-02) — see core/consent.py's DriveTestConsentMessageAdminView.
    path('telemetry/consent-message/', consent.DriveTestConsentMessageAdminView.as_view(), name='telemetry-consent-message'),

    # Flat (not router-nested) delete endpoint for one DT session
    # attachment (2026-09-07) — see DriveTestSessionAttachmentDetailView's
    # own docstring in drive_test.py for why this isn't a second @action
    # on DriveTestSessionViewSet.
    path(
        'dt-sessions/<int:session_id>/attachments/<int:attachment_id>/',
        drive_test.DriveTestSessionAttachmentDetailView.as_view(),
        name='dt-session-attachment-detail',
    ),
    # Flat (not router-nested) delete endpoint for one optimization
    # activity <-> session link (2026-09-12) -- see
    # OptimizationActivitySessionDetailView's own docstring in
    # drive_test.py for why this isn't a second @action on
    # OptimizationActivityViewSet.
    path(
        'dt-activities/<int:activity_id>/sessions/<int:link_id>/',
        drive_test.OptimizationActivitySessionDetailView.as_view(),
        name='dt-activity-session-detail',
    ),

    # Vendor RNO report importer (2026-09-15) -- registered BEFORE the
    # router's `rf-reports/<pk>/` include below, same reason as
    # sites/search/ above: this literal path must win over the router's
    # dynamic pk pattern (which would otherwise treat "parse-preview"
    # itself as an rf-report id lookup). See RfReportParsePreviewView's
    # docstring in core/rf_reports.py.
    path('rf-reports/parse-preview/', rf_reports.RfReportParsePreviewView.as_view(), name='rf-report-parse-preview'),

    # Flat (not router-nested) download endpoint for one RF report
    # attachment (2026-09-15) -- see RfReportAttachmentDetailView's own
    # docstring in rf_reports.py for why this isn't a second @action on
    # RfOptimizationReportViewSet (same reasoning as
    # DriveTestSessionAttachmentDetailView above).
    path(
        'rf-reports/<int:report_id>/attachments/<int:attachment_id>/download/',
        rf_reports.RfReportAttachmentDetailView.as_view(),
        name='rf-report-attachment-download',
    ),

    path('', include(router.urls)),
]

