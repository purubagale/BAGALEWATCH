from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import (
    BrandingSettings,
    DashboardCardConfig,
    DriveTestConsentConfig,
    MenuItem,
    MenuPermission,
    RescueConsentPolicy,
    RescueConsentPolicyChangeLog,
    RescueLocationAccessLog,
    Sector,
    Site,
    TelemetryBatch,
    TelemetryCoverageBin,
    TelemetryDriveTestConsent,
    TelemetryDriveTestSession,
    TelemetryIngestKey,
    TelemetryRemoteOptOutRequest,
    TelemetrySample,
    User,
)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    # Extends Django's built-in UserAdmin (keeps password-change UI, etc.)
    # with the v1-parity fields.
    fieldsets = DjangoUserAdmin.fieldsets + (
        # operator_mncs (2026-09-02): a JSON list of MNC codes, e.g.
        # ["02"] for a Nepal-Telecom-only account, [] (the default) for
        # unrestricted NTA/government/superadmin access — see the field's
        # docstring in models.py. No dedicated widget here, just Django
        # admin's default JSON textarea; edit it as a JSON array.
        ('DT-WATCH role', {'fields': ('role', 'name', 'dept', 'operator_mncs')}),
    )
    list_display = ('username', 'role', 'name', 'dept', 'operator_mncs', 'is_active', 'last_login')
    list_filter = ('role', 'is_active')


class SectorInline(admin.TabularInline):
    model = Sector
    extra = 0
    fields = ('cell_name', 'sector', 'tech', 'local_cell_id', 'pci', 'azimuth')


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'region', 'district', 'status', 'kpi_entered')
    list_filter = ('region', 'status')
    search_fields = ('id', 'name', 'district', 'city')
    inlines = [SectorInline]


@admin.register(Sector)
class SectorAdmin(admin.ModelAdmin):
    list_display = ('id', 'site', 'cell_name', 'sector', 'tech', 'pci')
    search_fields = ('cell_name', 'site__id', 'site__name')


@admin.register(MenuPermission)
class MenuPermissionAdmin(admin.ModelAdmin):
    list_display = ('role', 'menu_key', 'action', 'allowed')
    list_filter = ('role', 'action', 'allowed')


@admin.register(MenuItem)
class MenuItemAdmin(admin.ModelAdmin):
    list_display = ('label', 'icon', 'parent', 'path', 'access', 'permission_key', 'order', 'is_active')
    list_filter = ('access', 'is_active')
    ordering = ('order', 'id')


@admin.register(DashboardCardConfig)
class DashboardCardConfigAdmin(admin.ModelAdmin):
    list_display = ('user', 'card_key', 'order', 'visible')
    list_filter = ('visible',)
    search_fields = ('user__username', 'card_key')


@admin.register(BrandingSettings)
class BrandingSettingsAdmin(admin.ModelAdmin):
    list_display = ('app_name', 'logo')


# ── Crowdsourced telemetry (2026-08-31) ───────────────────────────────
# Read-mostly here — the ingest keys are normally minted from the
# Telemetry Admin page / `telemetry_key` command, and the samples table
# is partitioned and high-volume, so it's deliberately NOT registered.

@admin.register(TelemetryIngestKey)
class TelemetryIngestKeyAdmin(admin.ModelAdmin):
    list_display = ('name', 'key_prefix', 'is_active', 'rate_limit_per_min', 'created_at', 'last_used_at', 'expires_at')
    list_filter = ('is_active',)
    search_fields = ('name', 'key_prefix')
    readonly_fields = ('key_prefix', 'key_hash', 'created_at', 'last_used_at')


@admin.register(TelemetryBatch)
class TelemetryBatchAdmin(admin.ModelAdmin):
    list_display = ('batch_hash', 'key_prefix', 'device_count', 'sample_count', 'received_at')
    search_fields = ('batch_hash', 'key_prefix')
    readonly_fields = ('batch_hash', 'key_prefix', 'device_count', 'sample_count', 'received_at')


@admin.register(TelemetryCoverageBin)
class TelemetryCoverageBinAdmin(admin.ModelAdmin):
    list_display = ('geohash', 'network_type', 'mnc', 'region', 'sample_count', 'device_count', 'rsrp_mean', 'last_ts')
    list_filter = ('network_type', 'mnc', 'region')
    search_fields = ('geohash', 'region')


@admin.register(TelemetrySample)
class TelemetrySampleAdmin(admin.ModelAdmin):
    # rssi_dbm added 2026-09-03 -- GSM/UMTS (2G/3G) samples only ever
    # populate this field (see CellSampleCollector.kt's parseCellInfo():
    # rsrp_dbm/rsrq_db/sinr_db are LTE/NR-only and stay null for those
    # RATs by design), so without it here a real 2G/3G reading looked
    # like "no signal data collected" in this list -- the reading was
    # always in the DB, just not one of the columns shown.
    # rx_qual/rscp_dbm/ecio_db added 2026-09-03 -- GSM RxQual and WCDMA
    # RSCP/Ec-Io, the proper RAN-standard 2G/3G metrics (see models.py's
    # TelemetrySample field comment).
    list_display = (
        'device_id', 'ts', 'network_type', 'rsrp_dbm', 'rsrq_db', 'sinr_db',
        'rssi_dbm', 'rx_qual', 'rscp_dbm', 'ecio_db', 'lat', 'lng', 'trigger_reason', 'region',
    )
    list_filter = ('network_type', 'trigger_reason', 'region')
    search_fields = ('device_id', 'region')
    ordering = ('-received_at',)
    date_hierarchy = 'received_at'
    readonly_fields = [f.name for f in TelemetrySample._meta.fields]


@admin.register(TelemetryDriveTestSession)
class TelemetryDriveTestSessionAdmin(admin.ModelAdmin):
    list_display = ('name', 'status', 'require_consent', 'started_at', 'ended_at', 'created_by')
    list_filter = ('status', 'require_consent')
    search_fields = ('name',)
    readonly_fields = ('started_at',)


# ── Drive-test participation consent (2026-09-02) ──────────────────────
# Read-only here, same reasoning as RescueLocationAccessLog below: this
# flag is only ever meant to reflect what the DEVICE itself told
# core/consent.py's DriveTestConsentView. Letting Django admin staff edit
# it directly would let someone flip a subscriber's consent state by hand
# with no device action behind it — exactly the kind of silent bypass the
# rescue-audit design next to this one already guards against.

@admin.register(TelemetryDriveTestConsent)
class TelemetryDriveTestConsentAdmin(admin.ModelAdmin):
    list_display = ('device_id', 'consent', 'consented_at', 'updated_at')
    list_filter = ('consent',)
    search_fields = ('device_id',)
    readonly_fields = [f.name for f in TelemetryDriveTestConsent._meta.fields]

    def has_add_permission(self, request):
        return False  # consent state is only ever set by the device itself, via DriveTestConsentView

    def has_change_permission(self, request, obj=None):
        return False  # never editable from Django admin — see this section's header comment


# Drive-test consent MESSAGE (2026-09-02) — the copy shown before a
# subscriber answers the above, not the answer itself. Read-only here too,
# so it only ever changes through DriveTestConsentMessageAdminView (kept
# consistent with the rest of this admin surface, even though — per
# DriveTestConsentConfig's own docstring — this one isn't a privacy/access
# decision, just wording).

@admin.register(DriveTestConsentConfig)
class DriveTestConsentConfigAdmin(admin.ModelAdmin):
    list_display = ('message', 'updated_by', 'updated_at')
    readonly_fields = [f.name for f in DriveTestConsentConfig._meta.fields]

    def has_add_permission(self, request):
        return False  # singleton, created lazily by DriveTestConsentMessageView/AdminView's get_or_create

    def has_change_permission(self, request, obj=None):
        return False  # change ONLY through DriveTestConsentMessageAdminView


# ── Rescue-location beacon (2026-09-01) ───────────────────────────────
# ONLY the audit log is registered here, deliberately. SubscriberLastLocation
# (msisdn + live position) is NOT — Django admin access is gated by
# is_staff/is_superuser, a completely different permission surface from
# this app's own IsRescueOperator role check, and putting it here would
# let any Django staff account read subscriber locations with no
# case_reference and no entry in RescueLocationAccessLog, defeating the
# entire audit design in core/rescue.py. The ONLY sanctioned read path is
# RescueLookupView. If a superadmin genuinely needs to inspect the raw
# table (debugging, a data-subject request), use `manage.py shell` — a
# deliberately un-paved path, not a UI shortcut.

@admin.register(RescueLocationAccessLog)
class RescueLocationAccessLogAdmin(admin.ModelAdmin):
    list_display = ('queried_at', 'looked_up_by', 'msisdn_queried', 'case_reference', 'found', 'policy_mode')
    list_filter = ('found', 'policy_mode')
    search_fields = ('msisdn_queried', 'case_reference', 'looked_up_by__username')
    ordering = ('-queried_at',)
    readonly_fields = [f.name for f in RescueLocationAccessLog._meta.fields]

    def has_add_permission(self, request):
        return False  # audit rows are only ever created by RescueLookupView

    def has_change_permission(self, request, obj=None):
        return False  # append-only ledger — never editable, even by superadmin


# ── Rescue-consent policy (2026-09-02) ─────────────────────────────────
# Read-only here too, and for a sharper reason than the other read-only
# admins above: RescueConsentPolicyView (core/rescue.py) is the ONLY
# sanctioned way to change this, because that view is what writes
# RescueConsentPolicyChangeLog. A Django-admin edit would flip a
# system-wide emergency switch with zero audit trail — exactly the "no
# silent capability change" failure mode every other governance decision
# in this file exists to prevent.

@admin.register(RescueConsentPolicy)
class RescueConsentPolicyAdmin(admin.ModelAdmin):
    list_display = ('mode', 'reason', 'active_until', 'changed_by', 'updated_at')
    readonly_fields = [f.name for f in RescueConsentPolicy._meta.fields]

    def has_add_permission(self, request):
        return False  # singleton, created lazily by RescueConsentPolicyView's get_or_create

    def has_change_permission(self, request, obj=None):
        return False  # change ONLY through RescueConsentPolicyView -- see this section's header comment


@admin.register(RescueConsentPolicyChangeLog)
class RescueConsentPolicyChangeLogAdmin(admin.ModelAdmin):
    list_display = ('changed_at', 'changed_by', 'mode', 'reason', 'active_until')
    list_filter = ('mode',)
    ordering = ('-changed_at',)
    readonly_fields = [f.name for f in RescueConsentPolicyChangeLog._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False  # append-only ledger


# ── Remote opt-out requests (2026-09-02) ───────────────────────────────
# Read-only for the same reason as TelemetryDriveTestConsent above: a
# request is meaningful only when it's actually delivered to (and applied
# by) the device on its next upload, which happens through
# TelemetryIngestView, not by a row appearing in this table. Create these
# through TelemetryDriveTestSessionEndView's `request_opt_out` action, not
# here.

@admin.register(TelemetryRemoteOptOutRequest)
class TelemetryRemoteOptOutRequestAdmin(admin.ModelAdmin):
    list_display = ('device_id', 'requested_by', 'requested_at', 'reason', 'fulfilled_at')
    search_fields = ('device_id',)
    ordering = ('-requested_at',)
    readonly_fields = [f.name for f in TelemetryRemoteOptOutRequest._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

