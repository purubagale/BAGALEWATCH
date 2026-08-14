from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import BrandingSettings, DashboardCardConfig, MenuItem, MenuPermission, Sector, Site, User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    # Extends Django's built-in UserAdmin (keeps password-change UI, etc.)
    # with the v1-parity fields.
    fieldsets = DjangoUserAdmin.fieldsets + (
        ('BAGALEWATCH role', {'fields': ('role', 'name', 'dept')}),
    )
    list_display = ('username', 'role', 'name', 'dept', 'is_active', 'last_login')
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
