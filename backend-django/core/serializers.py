import io
import math

from django.contrib.auth import get_user_model, password_validation
from django.contrib.gis.geos import MultiPoint, Point
from django.contrib.gis.measure import D
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from django.db import connection
from django.utils import timezone
from rest_framework import serializers

from .dt_serving_cell import attach_serving_cells
from .imageutils import DataUrlImageError, decode_data_url_image
from .models import (
    AuditHistory,
    BrandingSettings,
    DriveTestSample,
    DriveTestSession,
    KpiThreshold,
    MenuItem,
    MenuPermission,
    Sector,
    Site,
    TreeFolder,
)

User = get_user_model()

# Menu keys that use the full {read, write, update, delete} permission
# shape rather than a plain bool — kept in sync with CRUD_MENUS in the
# v1 bagalewatch_api.py by hand for now (small, stable list). If this
# drifts from v1's list before cutover, that's a real parity bug to fix,
# not just a cosmetic mismatch — it changes what the React UI gates.
CRUD_MENUS = {'sites', 'rsrpmgr', 'tree', 'thresholds', 'datasource', 'backup', 'kpireports'}


class SectorSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sector
        fields = [
            'id', 'cell_name', 'sector', 'tech', 'local_cell_id',
            'height', 'azimuth', 'mech_tilt', 'elec_tilt',
            'pci', 'scrambling_code', 'bcch', 'bsic',
            'kpi_json', 'kpi_date',
            # Optional per-sector GPS override (2026-08-09) — see
            # Sector.lat/Sector.lng's docstring in models.py. Both null
            # (the default) means "same location as the parent site";
            # callers must fall back to the site's own lat/lng, not treat
            # null as 0,0.
            'lat', 'lng',
            # Real columns from the user's own 3G/2G source files
            # (2026-08-09, "need to store all those data also") — see
            # Sector.carrier/site_band/cell_active_status/site_existence's
            # docstring in models.py.
            'carrier', 'site_band', 'cell_active_status', 'site_existence',
        ]


class SiteListSerializer(serializers.ModelSerializer):
    """Lightweight — this backs the ~4,700-row sidebar tree and map, so it
    deliberately excludes the ~20 flat KPI columns and sector list that
    SiteDetailSerializer includes.

    `techs` (2026-08-10, "in site tree, also display available tech type
    in site, and also make top search bar of site tree searchable
    according to tech type also") — the union of this site's own `tech`
    field and every DISTINCT `Sector.tech` recorded against it. Real
    2G/3G data (from the per-tech Sector Data imports, see
    site_import.py) lives almost entirely on sector rows, not `Site.tech`
    — same reasoning SiteSearchView's own `tech` filter already applies
    (matches Site.tech OR any sector's tech). Populated from
    `context['techs_by_site']`, precomputed ONCE per request by
    SiteViewSet.list() via a single lightweight `(site_id, tech)` query —
    not a per-site N+1, and not a full sector prefetch (this serializer
    stays deliberately lean, per the docstring above)."""

    techs = serializers.SerializerMethodField()

    class Meta:
        model = Site
        fields = [
            'id', 'name', 'region', 'city', 'district', 'lat', 'lng',
            'type', 'tech', 'status', 'status_2g', 'status_3g', 'kpi_entered',
            'techs',
        ]

    def get_techs(self, obj):
        techs = set()
        if obj.tech:
            techs.add(obj.tech.strip().upper())
        for t in self.context.get('techs_by_site', {}).get(obj.id, ()):
            if t:
                techs.add(t)
        return sorted(techs)


class SiteScatterSerializer(serializers.ModelSerializer):
    """Backs the Scatter Plot report (core/reports.py's ScatterDataView) —
    a third shape alongside SiteListSerializer (sidebar/map) and
    SiteDetailSerializer (single-site edit form). Deliberately its own
    serializer rather than widening SiteListSerializer: Scatter Plot needs
    12 KPI columns across all ~4,700 sites at once (matching v1's
    SCATTER_KPIS, bts_monitor.html ~12785-12792, which reads straight off
    the same in-memory SITES[] array everything else uses — v1 has no
    separate lightweight/full split at all), but the sidebar/map tree
    should stay lean and not carry KPI payload it never renders."""

    class Meta:
        model = Site
        fields = [
            'id', 'name', 'region', 'status',
            'rrc', 'erab', 'call_drop', 'intra_ho', 'ip_thru', 'ip_lat',
            'prb', 'cell_avail', 'rssi', 'load', 'bearer_util', 'lic_util',
        ]


class SiteDetailSerializer(serializers.ModelSerializer):
    sectors = SectorSerializer(many=True, read_only=True)

    class Meta:
        model = Site
        fields = '__all__'


class MenuPermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = MenuPermission
        fields = ['role', 'menu_key', 'action', 'allowed']


MAX_MENU_ICON_BYTES = 2 * 1024 * 1024  # smaller than the org logo's 5MB — this is a tiny rail icon


class MenuItemSerializer(serializers.ModelSerializer):
    """CRUD serializer for the Menu admin page (2026-08-08) — see
    MenuItem's docstring in models.py for what each field means. Not used
    for rendering the actual header nav (MenuTreeView in views.py builds
    a filtered, nested tree shape instead); this is the flat, unfiltered
    read/write shape for MenuAdminPage.tsx's table.

    `icon_image_url`/`icon_image_data_url`/`remove_icon_image` (2026-08-08
    follow-up: a user tried to use a downloaded icon file and found there
    was no way to) mirror the exact same read/write split
    BrandingSettingsSerializer already uses for the org logo — a
    write-only base64 data URL in, an absolute URL out, plus an explicit
    remove flag. Handled in create()/update() rather than left to the
    default ModelSerializer behavior, since `icon_image` itself (the real
    ImageField) is deliberately NOT a serializer field at all — nothing
    ever reads or writes it directly except through the data-URL pair,
    same reasoning as BrandingSettingsSerializer's write-only `logo`."""

    icon_image_url = serializers.SerializerMethodField()
    icon_image_data_url = serializers.CharField(write_only=True, required=False, allow_null=True, allow_blank=True)
    remove_icon_image = serializers.BooleanField(write_only=True, required=False, default=False)

    class Meta:
        model = MenuItem
        fields = [
            'id', 'label', 'link_type', 'path', 'parent', 'order', 'access', 'permission_key', 'is_active',
            'icon', 'icon_image_url', 'icon_image_data_url', 'remove_icon_image', 'description',
        ]

    def get_icon_image_url(self, obj):
        if not obj.icon_image:
            return None
        request = self.context.get('request')
        return request.build_absolute_uri(obj.icon_image.url) if request else obj.icon_image.url

    def _apply_icon_image(self, instance, remove_icon_image, icon_image_data_url):
        # Explicit reset-to-emoji, checked BEFORE a new upload — same
        # "remove wins if somehow both are sent" convention as
        # BrandingSettingsView.put(). Neither flag present at all (the
        # common case: editing a row's label/order/etc without touching
        # its icon) leaves `icon_image` completely untouched.
        if remove_icon_image:
            if instance.icon_image:
                instance.icon_image.delete(save=False)
            instance.icon_image = None
        elif icon_image_data_url:
            try:
                raw, ext = decode_data_url_image(icon_image_data_url, MAX_MENU_ICON_BYTES)
            except DataUrlImageError as exc:
                raise serializers.ValidationError({'icon_image_data_url': [str(exc)]})
            if instance.icon_image:
                instance.icon_image.delete(save=False)
            instance.icon_image.save(f'icon.{ext}', ContentFile(raw), save=False)

    def create(self, validated_data):
        remove_icon_image = validated_data.pop('remove_icon_image', False)
        icon_image_data_url = validated_data.pop('icon_image_data_url', None)
        instance = MenuItem(**validated_data)
        self._apply_icon_image(instance, remove_icon_image, icon_image_data_url)
        instance.save()
        return instance

    def update(self, instance, validated_data):
        remove_icon_image = validated_data.pop('remove_icon_image', False)
        icon_image_data_url = validated_data.pop('icon_image_data_url', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        self._apply_icon_image(instance, remove_icon_image, icon_image_data_url)
        instance.save()
        return instance

    def validate(self, attrs):
        instance = self.instance
        parent = attrs.get('parent', instance.parent if instance else None)
        if parent is not None and instance is not None:
            if parent.id == instance.id:
                raise serializers.ValidationError({'parent': 'An item cannot be its own parent.'})
            # Multi-level submenus (2026-08-08) — arbitrary depth is fine,
            # the only real structural rule is "no cycles." Walk up the
            # PROPOSED parent's own ancestry: if that walk ever reaches
            # `instance` itself, saving this would make instance an
            # ancestor of its own parent — a loop. A `seen` set guards
            # against looping forever if the DB somehow already has a
            # cycle in it (e.g. from a direct Django-admin edit, which
            # bypasses this serializer).
            ancestor = parent
            seen = set()
            while ancestor is not None and ancestor.id not in seen:
                if ancestor.id == instance.id:
                    raise serializers.ValidationError(
                        {'parent': 'That would create a loop — it is already a descendant of the item being edited.'}
                    )
                seen.add(ancestor.id)
                ancestor = ancestor.parent

        access = attrs.get('access', instance.access if instance else MenuItem.ACCESS_ALL)
        permission_key = attrs.get('permission_key', instance.permission_key if instance else '')
        if access == MenuItem.ACCESS_PERMISSION and not permission_key:
            raise serializers.ValidationError(
                {'permission_key': 'Required when access is "Governed by Permissions matrix".'}
            )

        path = attrs.get('path', instance.path if instance else '')
        link_type = attrs.get('link_type', instance.link_type if instance else MenuItem.LINK_ROUTE)
        if not path:
            raise serializers.ValidationError({'path': 'Required.'})
        if link_type == MenuItem.LINK_ROUTE and not path.startswith('/'):
            raise serializers.ValidationError({'path': 'Internal routes must start with "/".'})
        if link_type == MenuItem.LINK_EXTERNAL and not (path.startswith('http://') or path.startswith('https://')):
            raise serializers.ValidationError({'path': 'External URLs must start with http:// or https://.'})
        return attrs


class BrandingSettingsSerializer(serializers.ModelSerializer):
    """Read shape includes `logo_url` (an absolute URL any client can
    drop straight into an <img src>) alongside the write-only `logo`
    upload field — mirrors how DtSessionDetail-style read/write splits
    already work elsewhere in this app, just for a single file instead
    of a nested collection."""
    logo_url = serializers.SerializerMethodField()

    class Meta:
        model = BrandingSettings
        fields = [
            'app_name', 'logo', 'logo_url',
            'login_subtitle', 'login_username_label', 'login_password_label', 'login_button_text',
            'login_disclaimer', 'idle_timeout_minutes',
        ]
        extra_kwargs = {'logo': {'write_only': True, 'required': False}}

    def get_logo_url(self, obj):
        if not obj.logo:
            return None
        request = self.context.get('request')
        return request.build_absolute_uri(obj.logo.url) if request else obj.logo.url


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        # `auth_source` is exposed read-only (2026-08-23) so UsersPage can
        # show an SSO-backed user's role as managed elsewhere. Without it an
        # admin edits the role, Keycloak re-applies the mapped one at that
        # person's next login, and the edit looks like a bug in this app.
        # `sso_subject` is deliberately NOT exposed: it is an internal
        # identity-provider identifier with no use in the UI.
        fields = ['id', 'username', 'role', 'name', 'dept', 'is_active',
                  'last_login', 'date_joined', 'auth_source', 'operator_mncs']
        read_only_fields = ['auth_source']


class MeSerializer(UserSerializer):
    """Adds the current user's resolved permission map, in the same shape
    the v1 client already expects (plain bool for simple menus, a
    {read,write,update,delete} dict for CRUD menus) — see
    CRUD_MENUS/DEFAULT_PERMS handling in bagalewatch_api.py's own
    /api/v1/permissions endpoint, mirrored here so the React route guards
    (§5 of the migration plan) can reuse the exact same permission shape
    without a frontend-side remap."""

    permissions = serializers.SerializerMethodField()

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ['permissions']

    def get_permissions(self, obj):
        rows = MenuPermission.objects.filter(role=obj.role)
        out = {}
        for r in rows:
            if r.menu_key in CRUD_MENUS:
                out.setdefault(r.menu_key, {})[r.action] = r.allowed
            else:
                out[r.menu_key] = r.allowed
        return out


# ── Phase 2: writable serializers ───────────────────────────────────────

class UserWriteSerializer(serializers.ModelSerializer):
    """Create/update, matching v1's /users POST (username+password+role
    required) / PUT (only provided fields touched, password optional —
    only re-hashed if sent). Uses Django's own set_password(), which goes
    through PASSWORD_HASHERS[0] (Django's native PBKDF2, not the Legacy*
    hashers reserved for imported v1 accounts) — correct for brand-new v2
    accounts, no legacy-format rewrite needed for those."""
    password = serializers.CharField(write_only=True, required=False, allow_blank=False)

    class Meta:
        model = User
        fields = ['id', 'username', 'password', 'role', 'name', 'dept', 'is_active', 'operator_mncs']

    def validate(self, attrs):
        # Matches v1: username/password/role are required on create, but
        # PUT only touches whatever fields are actually sent.
        if self.instance is None:
            for required in ('username', 'password', 'role'):
                if not attrs.get(required):
                    raise serializers.ValidationError({required: 'This field is required.'})

        # 2026-08-07 security-audit fix: AUTH_PASSWORD_VALIDATORS is
        # configured in settings.py (minimum length, common-password
        # check, etc.) but create()/update() below only ever called
        # set_password() directly, which does NOT run Django's validators
        # on its own — verified live during the audit that a user could be
        # created with the password "1". Runs whenever a password is being
        # set (create, or an update that includes one), never on a PUT
        # that leaves the password untouched.
        password = attrs.get('password')
        if password:
            # UserAttributeSimilarityValidator compares against user
            # fields (username/name/dept) — pass the real instance on
            # update, or a throwaway unsaved one built from the submitted
            # fields on create, so that check has something real to run
            # against instead of silently skipping.
            check_user = self.instance or User(
                username=attrs.get('username', ''),
                name=attrs.get('name', ''),
                dept=attrs.get('dept', ''),
            )
            try:
                password_validation.validate_password(password, user=check_user)
            except DjangoValidationError as exc:
                raise serializers.ValidationError({'password': list(exc.messages)})

        return attrs

    def create(self, validated_data):
        password = validated_data.pop('password')
        role = validated_data.get('role', 'viewer')
        user = User(**validated_data)
        user.is_staff = role in ('superadmin', 'admin')
        user.is_superuser = role == 'superadmin'
        user.set_password(password)
        user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        # Same reasoning as SiteWriteSerializer.update(): the URL's pk
        # decides which user is being edited, not a stray 'id' in the body.
        validated_data.pop('id', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if 'role' in validated_data:
            instance.is_staff = instance.role in ('superadmin', 'admin')
            instance.is_superuser = instance.role == 'superadmin'
        if password:
            instance.set_password(password)
        instance.save()
        return instance


class SectorWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sector
        fields = [
            'cell_name', 'sector', 'tech', 'local_cell_id',
            'height', 'azimuth', 'mech_tilt', 'elec_tilt',
            'pci', 'scrambling_code', 'bcch', 'bsic',
            'kpi_json', 'kpi_date',
            'lat', 'lng',
            'carrier', 'site_band', 'cell_active_status', 'site_existence',
        ]


class SiteWriteSerializer(serializers.ModelSerializer):
    """Create/update a site + its full sector list in one call, matching
    v1's _upsert_site exactly: sectors are always fully replaced (delete
    all for this site, recreate from the payload), never diffed/patched —
    same "client always sends its complete current state" contract as
    tree/permissions, just scoped to one site instead of the whole tree.
    A PUT that omits an optional field clears it to null/blank, same as
    v1's site.get(key) defaulting to None for anything not in the body —
    this is intentionally NOT a partial update.

    Everything besides KPI/sector/type-tech-status data — this is what
    AddSiteModal.tsx/SiteDetailPage.tsx's edit form actually manage."""
    sectors = SectorWriteSerializer(many=True, required=False)

    # 2026-08-26 — see this method's own comment in update() below and
    # LIVE_MANAGED_FIELDS' docstring for the full reasoning.
    LIVE_MANAGED_FIELDS = (
        'name', 'region', 'district', 'sitename1', 'palika', 'palika_type',
        'ward_no', 'lat', 'lng', 'deployment_status', 'operational_technologies',
    )

    class Meta:
        model = Site
        # Explicit list, NOT '__all__' (2026-08-26 — was '__all__' until
        # this change). Two things dropped, both deliberate:
        #  - `location`: the PostGIS point Site.save() auto-derives from
        #    lat/lng (see models.py) — never a real input, and DRF's
        #    ModelSerializer has no proper field type for GeoDjango's
        #    PointField anyway (it silently falls back to a generic
        #    ModelField, which is not something to actually rely on for
        #    writes).
        #  - `live_site_updated_at`/`live_last_updated_at`/`live_synced_at`/
        #    `live_raw`: the Live Site Directory sync's own internal
        #    bookkeeping (core/live_sites.py) — no manual write path should
        #    ever set these directly.
        # LIVE_MANAGED_FIELDS above (name/region/district/etc.) STAY listed
        # here — AddSiteModal.tsx still needs them to create a genuinely
        # new site — but are stripped out of validated_data in update()
        # below, so editing an EXISTING site silently ignores them.
        fields = [
            'id', 'sectors', 'name', 'region', 'city', 'district', 'lat', 'lng',
            'sitename1', 'palika', 'palika_type', 'ward_no', 'deployment_status',
            'operational_technologies',
            'type', 'tech', 'status', 'status_2g', 'status_3g', 'rssi', 'load',
            'kpi_entered', 'kpi_entered_2g', 'kpi_entered_3g', 'kpi_date',
            'rrc', 'erab', 'call_setup', 'call_drop', 'svc_drop', 'intra_ho', 'inter_ho',
            'inter_rat', 'ip_thru', 'ip_thru_dl', 'ip_thru_ul', 'ip_lat', 'prb', 'prb_dl',
            'prb_ul', 'bearer_util', 'lic_util', 'cell_avail', 'volte_setup', 'csfb',
            'kpi_2g_json', 'kpi_3g_json', 'updated_at', 'updated_by',
        ]
        extra_kwargs = {'updated_by': {'required': False}}

    def _replace_sectors(self, site, sectors_data):
        Sector.objects.filter(site=site).delete()
        Sector.objects.bulk_create([Sector(site=site, **s) for s in sectors_data])

    def create(self, validated_data):
        sectors_data = validated_data.pop('sectors', [])
        validated_data['updated_at'] = timezone.now()
        site = Site.objects.create(**validated_data)
        self._replace_sectors(site, sectors_data)
        return site

    def update(self, instance, validated_data):
        sectors_data = validated_data.pop('sectors', None)
        # 'id' is the primary key — the URL, not the body, determines which
        # site is being updated (matches v1's PUT /sites/<id>, which
        # explicitly does `site['id'] = sub_id` to force this). Mutating a
        # Django model instance's pk and calling save() does NOT rename the
        # row; it silently updates the wrong (or no) row, so this must be
        # dropped rather than applied even if the client's PUT body
        # happens to include an 'id' field.
        validated_data.pop('id', None)
        # 2026-08-26, confirmed via AskUserQuestion: "during site edit, no
        # need to update for api retrieved data, allow other details if
        # needed." Identity/location fields are the Live Site Directory
        # sync's job now (core/live_sites.py) — a manual edit silently
        # ignoring them (not erroring) matches this codebase's existing
        # "a value the client didn't really mean to send never overwrites
        # what's already stored" convention (see site_import.py's
        # _apply_sectors docstring for the same rule elsewhere). Only
        # applies here, in update() — create() is untouched, since
        # AddSiteModal.tsx still needs to set these when adding a
        # genuinely new site manually.
        for field in self.LIVE_MANAGED_FIELDS:
            validated_data.pop(field, None)
        validated_data['updated_at'] = timezone.now()
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if sectors_data is not None:
            self._replace_sectors(instance, sectors_data)
        return instance


class KpiThresholdSerializer(serializers.ModelSerializer):
    class Meta:
        model = KpiThreshold
        fields = ['kpi_key', 'warn', 'crit', 'hi', 'max', 'unit']


class TreeFolderSerializer(serializers.ModelSerializer):
    # Recursive by construction — TreeFolder.parent is self-referencing
    # (arbitrary depth, added 2026-07-27 to replace v1's fixed 2-level
    # folder/subfolder split; see the model's docstring). children.all()
    # issues one query per folder rather than a single prefetched tree
    # query, which is fine at this dataset's size (a handful of folders,
    # not thousands) — worth revisiting with prefetch_related /
    # django-mptt only if this ever needs to scale past hand-built trees.
    children = serializers.SerializerMethodField()

    class Meta:
        model = TreeFolder
        fields = ['id', 'name', 'icon', 'lat', 'lng', 'children']

    def get_children(self, obj):
        return TreeFolderSerializer(obj.children.all().order_by('name'), many=True).data


class AuditHistorySerializer(serializers.ModelSerializer):
    """Backs RF Audit's saved-report history (core/rf_audit.py). `site_name`
    is written once at create time (see AuditHistoryView.post) from the
    live Site, then never touched again — same point-in-time-snapshot
    reasoning as models.AuditHistory's docstring: it has to keep meaning
    something after the site it was taken against is edited or deleted."""
    site_name = serializers.CharField(read_only=True)
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = AuditHistory
        fields = ['id', 'site', 'site_name', 'content', 'score', 'created_at', 'created_by_name']
        read_only_fields = ['id', 'site_name', 'created_at', 'created_by_name']

    def get_created_by_name(self, obj):
        if not obj.created_by_id:
            return None
        return obj.created_by.name or obj.created_by.username


# ── Drive-Test Data Manager (Phase 4a) ──────────────────────────────────
# Field lists match v1's real dt_sessions/dt_records server tables — see
# DriveTestSession's docstring in models.py for why that's the source of
# truth, not the migration plan's own sketch.

class DriveTestSampleSerializer(serializers.ModelSerializer):
    class Meta:
        model = DriveTestSample
        fields = [
            'ts', 'date', 'lat', 'lng', 'rsrp', 'rsrq', 'sinr', 'dl', 'pci',
            'serving_site_id', 'serving_site_name', 'serving_sector', 'serving_cell_name',
            'serving_local_cell_id', 'serving_dist_km', 'cell_role', 'rx_qual',
            'bcch', 'bsic', 'rscp', 'ecno', 'scrambling_code',
        ]


_DT_SAMPLE_FLOAT_FIELDS = (
    'lat', 'lng', 'rsrp', 'rsrq', 'sinr', 'dl', 'serving_dist_km', 'rx_qual', 'rscp', 'ecno',
)
_DT_SAMPLE_INT_FIELDS = ('pci', 'serving_local_cell_id', 'bcch', 'bsic', 'scrambling_code')
# name -> (max_length, nullable) — mirrors the model's CharField columns.
_DT_SAMPLE_STR_FIELDS = {
    'ts': (32, False), 'date': (16, False),
    'serving_site_id': (64, True), 'serving_site_name': (255, True),
    'serving_sector': (20, True), 'serving_cell_name': (100, True),
    'cell_role': (10, False),
}
# The only fields a malformed/absent value should 400 on (matching what
# DRF's FloatField already did) — they are what a coverage plot needs.
# Everything else becomes NULL rather than failing a 5000-row batch.
_DT_SAMPLE_REQUIRED_NUMERIC = frozenset(('lat', 'lng', 'rsrp'))


def _coerce_dt_sample(raw):
    """Fast per-sample coercion for the two INTERNAL DT bulk-write paths
    (DriveTestSessionWriteSerializer.create + DriveTestSessionViewSet.
    samples). Replaces a ``DriveTestSampleSerializer(many=True).is_valid()``
    pass measured at ~420 ms per 5000-sample batch — the dominant cost of
    a session save, ~8x the ~50 ms this takes (DRF builds a child
    serializer and runs every field validator per item; the bulk_create
    itself is comparatively cheap). The sample shape is fixed and every
    field is a plain float / int / short string, so a direct coercion
    stores byte-identical values for the well-formed input the client
    always sends.

    Faithful to the model + the old serializer's effect: an unparseable
    lat/lng/rsrp raises 400 exactly as DRF's FloatField did; a
    missing/null one stays NULL (the columns are null=True); any other
    bad/absent value becomes NULL rather than failing the whole batch;
    strings are clamped to their column length; a blank cell_role
    defaults to 'serving' (the model default). The public external API
    (ExternalDtSessionCreateSerializer) deliberately keeps the full DRF
    serializer — it is lower volume and wants the stricter contract.
    """
    if not isinstance(raw, dict):
        raise serializers.ValidationError('Each sample must be a JSON object.')
    out = {}
    for f in _DT_SAMPLE_FLOAT_FIELDS:
        v = raw.get(f)
        if v is None or v == '':
            out[f] = None
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            fv = None
        if fv is None or not math.isfinite(fv):
            if f in _DT_SAMPLE_REQUIRED_NUMERIC:
                raise serializers.ValidationError(f'Sample field "{f}" is not a finite number: {v!r}')
            out[f] = None
        else:
            out[f] = fv
    for f in _DT_SAMPLE_INT_FIELDS:
        v = raw.get(f)
        if v is None or v == '':
            out[f] = None
            continue
        try:
            out[f] = int(float(v))
        except (TypeError, ValueError):
            out[f] = None
    for f, (maxlen, nullable) in _DT_SAMPLE_STR_FIELDS.items():
        v = raw.get(f)
        if v is None or v == '':
            out[f] = None if nullable else ''
        else:
            out[f] = str(v)[:maxlen]
    if not out['cell_role']:
        out['cell_role'] = 'serving'
    return out


# Every insertable column of v2_dt_samples, in a fixed order — `id` is the
# serial PK (DB default), everything else is written from a coerced sample
# dict (+ session_id + the derived location).
_DT_COPY_COLUMNS = (
    'session_id', 'ts', 'date', 'lat', 'lng', 'location',
    'rsrp', 'rsrq', 'sinr', 'dl', 'pci',
    'serving_site_id', 'serving_site_name', 'serving_sector', 'serving_cell_name',
    'serving_local_cell_id', 'serving_dist_km', 'cell_role', 'rx_qual',
    'bcch', 'bsic', 'rscp', 'ecno', 'scrambling_code',
)
_DT_COPY_SQL = (
    'COPY v2_dt_samples (' + ', '.join(_DT_COPY_COLUMNS) + ') FROM STDIN WITH (FORMAT text)'
)


def _copy_field(v):
    """One value for a Postgres text-format COPY stream: NULL as ``\\N``,
    strings with the four text-format metacharacters escaped, numbers as
    their plain repr (``_coerce_dt_sample`` has already ruled out NaN/inf
    and non-finite values)."""
    if v is None:
        return r'\N'
    if isinstance(v, str):
        return (
            v.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n').replace('\r', '\\r')
        )
    return str(v)


def _bulk_insert_dt_samples(session_id, rows):
    """COPY-based bulk insert for coerced DT sample dicts. ~3x faster than
    a ``bulk_create`` of the same geography rows (measured ~1.0s vs ~3.1s
    per 5000) — and a session-wide upload is 10+ such batches, so the geo
    INSERT was by far the dominant save cost. `rows` must already be
    ``_coerce_dt_sample()`` output (fixed keys, plain scalars). `location`
    is emitted as EWKT for PostGIS to parse directly — the same value
    GeoSyncQuerySet.bulk_create would derive from lat/lng, so this write
    path stays equivalent without going through that override."""
    if not rows:
        return
    buf = io.StringIO()
    for r in rows:
        lat, lng = r['lat'], r['lng']
        loc = f'SRID=4326;POINT({lng} {lat})' if (lat is not None and lng is not None) else None
        buf.write('\t'.join((
            str(session_id),
            _copy_field(r['ts']), _copy_field(r['date']),
            _copy_field(lat), _copy_field(lng), _copy_field(loc),
            _copy_field(r['rsrp']), _copy_field(r['rsrq']), _copy_field(r['sinr']),
            _copy_field(r['dl']), _copy_field(r['pci']),
            _copy_field(r['serving_site_id']), _copy_field(r['serving_site_name']),
            _copy_field(r['serving_sector']), _copy_field(r['serving_cell_name']),
            _copy_field(r['serving_local_cell_id']), _copy_field(r['serving_dist_km']),
            _copy_field(r['cell_role']), _copy_field(r['rx_qual']),
            _copy_field(r['bcch']), _copy_field(r['bsic']),
            _copy_field(r['rscp']), _copy_field(r['ecno']),
            _copy_field(r['scrambling_code']),
        )) + '\n')
    buf.seek(0)
    with connection.cursor() as cur:
        cur.copy_expert(_DT_COPY_SQL, buf)


class DriveTestSamplePlotSerializer(serializers.ModelSerializer):
    """Read-only, lean projection of DriveTestSample for the session
    detail / coverage-plot fetch — exactly the fields the coverage map,
    Explore, Compare and the CSV/KML export actually read. Drops six
    serving-cell columns (serving_site_id / serving_sector /
    serving_cell_name / serving_local_cell_id / serving_dist_km +
    cell_role) that BOTH upload paths (.trp and CSV/XLSX) always write as
    null / 'serving' — v1's per-sample nearest-serving-cell matching was
    never ported — and that nothing on the client reads. Shrinks the
    GET /api/v2/dt-sessions/<id>/ body by ~6 columns x up-to-50k rows
    with no visible change to any plot, tooltip or export.

    `serving_site_name` IS kept: it's the one serving_* field the client
    still references (an optional tooltip / CSV / KML suffix). It is null
    for every session today, so keeping it changes nothing now, but a
    future port of site matching then needs no serializer change.

    The full DriveTestSampleSerializer above stays the WRITE contract
    (create() + the /samples/ append action) so a future site-matching
    port can populate those columns without a serializer change either.
    """

    class Meta:
        model = DriveTestSample
        fields = [
            'ts', 'date', 'lat', 'lng', 'rsrp', 'rsrq', 'sinr', 'dl', 'pci',
            'serving_site_name', 'rx_qual', 'bcch', 'bsic', 'rscp', 'ecno', 'scrambling_code',
            # serving-cell attribution (dt_serving_cell.py): serving_site_id
            # keys the per-session /serving-cells/ lookup that the coverage
            # map's hover connector reads; serving_dist_km is per-point so
            # the popup shows THIS sample's distance to its serving site.
            'serving_site_id', 'serving_dist_km',
        ]


class DriveTestSessionListSerializer(serializers.ModelSerializer):
    """Metadata only, matching v1's GET (list) contract exactly — session
    records/samples can run into the tens of thousands per session (see
    §7 of the migration plan), so the History tab list never has to
    download every session's full trace, only when a specific one is
    opened (DriveTestSessionDetailSerializer)."""
    uploaded_by_name = serializers.SerializerMethodField()
    sample_count = serializers.IntegerField(read_only=True)  # annotated in the view's queryset

    class Meta:
        model = DriveTestSession
        fields = [
            'id', 'name', 'tech', 'date', 'uploaded_date', 'saved_at',
            'uploaded_by_name', 'meta', 'size_bytes', 'sample_count',
        ]

    def get_uploaded_by_name(self, obj):
        if not obj.uploaded_by_id:
            return None
        return obj.uploaded_by.name or obj.uploaded_by.username


# Keep in sync with the frontend's dtBands.MAX_MAP_DOTS. Every DT map
# (coverage / compare / explore) thins its point set to this many before
# drawing, so returning more than this from the detail endpoint is pure
# waste — serialized, transferred and parsed only to be dropped on arrival.
DT_PLOT_MAX_POINTS = 15000


class DriveTestSessionDetailSerializer(DriveTestSessionListSerializer):
    """`samples` is capped at DT_PLOT_MAX_POINTS with an even stride — the
    same reduction the coverage map already does on the client, moved to
    the server so a 50k+-row session isn't serialized and shipped in full
    just to be thinned on arrival (measured on a real 50k session:
    ~5.5s -> ~1.7s serialize, ~16 MB -> ~5 MB JSON). The stride matches
    lib/dtBands.ts's subsampleForMap(), so the plotted point set is
    equivalent and the client's own subsampleForMap() call becomes a
    no-op. `?full=1` returns every stored sample (for a future full
    export); the radius-filtered Explore endpoint (near()) is unchanged
    and still returns its full in-radius density."""
    samples = serializers.SerializerMethodField()

    class Meta(DriveTestSessionListSerializer.Meta):
        fields = DriveTestSessionListSerializer.Meta.fields + ['samples']

    def get_samples(self, obj):
        # `location` is not in DriveTestSamplePlotSerializer's fields — don't
        # SELECT it (it's the widest column in the row).
        qs = obj.samples.order_by('id').defer('location')
        request = self.context.get('request')
        # request.GET works whether `request` is a DRF Request or a plain
        # Django one (DRF's Request delegates unknown attrs to it).
        if request is not None and request.GET.get('full') in ('1', 'true'):
            return DriveTestSamplePlotSerializer(qs, many=True).data
        # One cheap pass for the ids, then fetch ONLY the strided subset —
        # the DB does the row selection by pk, so Python never instantiates
        # (or the ORM never GIS-parses) the 35k rows that get dropped.
        pks = list(qs.values_list('pk', flat=True))
        if len(pks) <= DT_PLOT_MAX_POINTS:
            return DriveTestSamplePlotSerializer(qs, many=True).data
        stride = len(pks) / DT_PLOT_MAX_POINTS
        keep = {pks[int(i * stride)] for i in range(DT_PLOT_MAX_POINTS)}
        subset = obj.samples.filter(pk__in=keep).order_by('id').defer('location')
        return DriveTestSamplePlotSerializer(subset, many=True).data


class DriveTestSessionNearSerializer(DriveTestSessionListSerializer):
    """Phase 4d — Explore-by-coordinate. Same metadata as the list
    serializer, but `samples` here is only the subset of this session's
    readings that actually fall inside the searched radius, not the
    full session (set as `.filtered_samples` on each instance by
    `DriveTestSessionViewSet.near()` before serializing — this is a
    plain Python attribute, not a real queryset, hence `source=`).
    Keeps the combined coverage-map response lightweight even when a
    matched session has thousands of points outside the radius; the
    shape is otherwise identical to DriveTestSessionDetailSerializer
    so the frontend can reuse the same `DtSessionDetail` type."""
    samples = DriveTestSamplePlotSerializer(many=True, read_only=True, source='filtered_samples')

    class Meta(DriveTestSessionListSerializer.Meta):
        fields = DriveTestSessionListSerializer.Meta.fields + ['samples']


# ~1km nearby-site tagging (2026-07-30 request) — "through this tag, it
# will be easier for future search also". Kept as a free function here
# (not in drive_test.py) because drive_test.py imports from this module —
# importing back the other way would be circular.
NEARBY_SITE_RADIUS_KM = 1.0


def _nearby_site_ids(sample_points, radius_km=NEARBY_SITE_RADIUS_KM):
    """Every Site within radius_km of AT LEAST ONE sample point — the
    plural counterpart to the single nearest-site match v1 already
    computes into meta (siteId/siteName/siteDistKm — see
    DriveTestSession's docstring). Used both at upload time
    (DriveTestSessionWriteSerializer.create below) and by the
    backfill_nearby_sites management command for existing sessions.

    sample_points: iterable of (lat, lng) tuples (None-safe — filtered
    below). Deduped to a coarse ~100m grid first: a session can have tens
    of thousands of samples, and there's no need to ask PostGIS to
    evaluate distance to the same route point a thousand times over.

    2026-08-25, PostGIS adoption: this used to be a bounding-box prefilter
    (Site.objects.filter(lat__gte=..., ...)) followed by an exact
    haversine check in Python for every (candidate site, sample point)
    pair. Now it's a single indexed `ST_DWithin(Site.location, route,
    radius)` query — `route` is every deduped sample point collapsed into
    one MultiPoint, so PostGIS itself finds every site within radius_km of
    the NEAREST point in that cloud, in one query using the GiST index on
    `location` instead of an unindexed Python distance loop.
    """
    points = {
        (round(lat, 3), round(lng, 3))
        for lat, lng in sample_points
        if lat is not None and lng is not None
    }
    if not points:
        return []

    route = MultiPoint(*(Point(lng, lat, srid=4326) for lat, lng in points), srid=4326)
    # .order_by('id') — an unordered queryset's row order isn't guaranteed
    # stable across runs, and backfill_nearby_sites.py compares this
    # return value against a previously-stored list to decide "did
    # anything change"; a deterministic order makes that comparison mean
    # something instead of flapping on re-runs with no real change.
    return list(
        Site.objects.filter(location__distance_lte=(route, D(km=radius_km)))
        .order_by('id')
        .values_list('id', flat=True)
    )


# Max samples accepted in ONE request, for both create() (the `samples`
# field below) and DriveTestSessionViewSet.samples() (core/drive_test.py's
# batch-append action). 2026-08-14 fix: a real 25-file .trp upload
# produced a 363,082-sample session and hit "Could not save this session
# (HTTP 413)" — nginx's default 1MB body cap rejected the single giant
# JSON POST before Django even saw it. Raising the body-size limits
# (nginx.conf's client_max_body_size, settings.py's
# DATA_UPLOAD_MAX_MEMORY_SIZE) fixes the immediate error, but a single
# 300k+-item nested-serializer validation pass is also slow (DRF's
# per-item Python validation, not the bulk_create itself, dominates) and
# risks the request just timing out instead of 413ing. The real fix is
# this cap: DtUploadPage.tsx's saveSessionChunked() now creates the
# session with an empty/small samples list, then POSTs the rest in
# DT_SAMPLES_BATCH_SIZE-sized batches to the append action — this
# constant is enforced on BOTH paths so a non-UI caller (a script, the
# DRF browsable API) can't bypass it by hitting create() directly with
# everything inline.
DT_SAMPLES_BATCH_SIZE = 5000


class DriveTestSessionWriteSerializer(serializers.ModelSerializer):
    """POST /api/v2/dt-sessions/ — creates a session and its samples in
    one call. No update/upsert-by-id path (unlike v1's PUT, which
    delete-then-inserts records for an existing client-generated id):
    Phase 4a's ids are server-assigned on create, so the duplicate-
    upload dialog's "Replace Old" action is just DELETE-old +
    POST-new from the client, not a special server-side upsert. Simpler
    than v1's contract, same end-user behavior.

    `samples` here is capped at DT_SAMPLES_BATCH_SIZE (see that
    constant's own comment) — a session with more than that is expected
    to be created with 0 (or a small first batch of) samples, then filled
    in via repeated calls to DriveTestSessionViewSet.samples().

    `samples` is a plain ListField, NOT a nested DriveTestSampleSerializer:
    per-item DRF validation of up to 5000 fixed-shape rows was the
    dominant save cost (~420 ms/batch). Each row is coerced by
    `_coerce_dt_sample()` in create() instead — see its docstring."""
    samples = serializers.ListField(
        child=serializers.DictField(), write_only=True, required=False
    )

    class Meta:
        model = DriveTestSession
        fields = ['id', 'name', 'tech', 'date', 'uploaded_date', 'meta', 'samples']
        read_only_fields = ['id']

    def validate_samples(self, value):
        if len(value) > DT_SAMPLES_BATCH_SIZE:
            raise serializers.ValidationError(
                f'Max {DT_SAMPLES_BATCH_SIZE} samples per request — create the session with fewer/no '
                f'samples, then POST the rest in batches to /api/v2/dt-sessions/<id>/samples/.'
            )
        return value

    def create(self, validated_data):
        samples_data = [_coerce_dt_sample(s) for s in validated_data.pop('samples', [])]
        # Serving-cell -> site attribution (v1's _rsrpMatchServingCell) —
        # stamps serving_site_id/cell_name/sector/local_cell_id/dist_km
        # onto each sample whose PCI (4G) / BCCH+BSIC (2G) / SC (3G)
        # resolves to a Sector. No-op with no site directory imported.
        attach_serving_cells(samples_data, validated_data.get('tech') or '4G')
        # Nearby-site tagging (~1km), computed server-side at save time so
        # it's always in sync with what was actually stored, not trusted
        # from the client. Stored inside the existing `meta` JSONField
        # rather than a new column/migration — see _nearby_site_ids'
        # docstring and project_dt_nearby_site_tagging memory.
        meta = validated_data.pop('meta', None) or {}
        meta['nearby_site_ids'] = _nearby_site_ids(
            (s.get('lat'), s.get('lng')) for s in samples_data
        )
        session = DriveTestSession.objects.create(
            uploaded_by=self.context['request'].user, meta=meta, **validated_data
        )
        _bulk_insert_dt_samples(session.id, samples_data)
        # size_bytes is computed server-side, not trusted from the client
        # (v1's own field is a client-side IndexedDB-quota estimate that
        # means nothing once storage is Postgres) — see the model
        # docstring. Cheap-enough approximation: the serialized payload
        # size, same rough JSON-length-based estimate v1 used, just
        # computed from what was actually stored instead of guessed by
        # the browser before the request was even sent. `meta` was popped
        # out above (to inject nearby_site_ids) so it's added back in
        # here explicitly — otherwise this estimate would silently stop
        # counting it.
        # O(1) size estimate: every sample dict is the same fixed shape and
        # near-identical length, so one representative row * count is within
        # a rounding error of stringifying all of them — and doesn't walk
        # up to 5000 dicts on every request just for a History-card number.
        per_sample = len(str(samples_data[0])) if samples_data else 0
        session.size_bytes = len(str(validated_data)) + len(str(meta)) + per_sample * len(samples_data)
        session.save(update_fields=['size_bytes'])
        return session


# ── External data-exchange API (2026-08-12) ─────────────────────────────
# Serializers backing core/external_api.py's views, mounted separately at
# /api/external/v1/ (API-key authenticated, see core/api_auth.py) rather
# than /api/v2/ (JWT-authenticated, the React app's own contract). Kept
# in this same file rather than a separate module — same "all serializers
# live here, all views live in their own per-feature module" split this
# file already uses for drive_test.py/backup.py/site_import.py/etc.
#
# Deliberately curated, EXPLICIT field lists rather than reusing
# SiteDetailSerializer's `fields = '__all__'` — an external integration
# contract needs to be something this app can reason about staying
# stable; `__all__` would silently start exposing any future internal-
# only Site field the moment it's added to the model, with no explicit
# decision made about whether an external system should see it.

SITE_EXTERNAL_CORE_FIELDS = [
    'id', 'name', 'region', 'city', 'district', 'lat', 'lng', 'type', 'tech',
    'status', 'status_2g', 'status_3g',
    'kpi_entered', 'kpi_entered_2g', 'kpi_entered_3g', 'kpi_date', 'updated_at',
]
SITE_EXTERNAL_KPI_FIELDS = [
    'rrc', 'erab', 'call_setup', 'call_drop', 'svc_drop', 'intra_ho', 'inter_ho',
    'inter_rat', 'ip_thru', 'ip_thru_dl', 'ip_thru_ul', 'ip_lat', 'prb', 'prb_dl',
    'prb_ul', 'bearer_util', 'lic_util', 'cell_avail', 'volte_setup', 'csfb',
    'rssi', 'load',
]


class ExternalSiteListSerializer(serializers.ModelSerializer):
    """`GET /api/external/v1/sites/` — flat KPI columns, no nested
    sectors (kept out of the list response the same reason
    SiteListSerializer above excludes them — a paginated list of ~4,700
    rows shouldn't carry each site's full sector array)."""
    class Meta:
        model = Site
        fields = SITE_EXTERNAL_CORE_FIELDS + SITE_EXTERNAL_KPI_FIELDS


class ExternalSiteDetailSerializer(serializers.ModelSerializer):
    """`GET /api/external/v1/sites/<id>/` — adds the 2G/3G KPI JSON blobs
    and the full sector list (reusing the same `SectorSerializer` the
    internal `/api/v2/` API already exposes — a sector's own field list
    has no internal-only concept to hide, unlike Site's `updated_by`
    FK)."""
    sectors = SectorSerializer(many=True, read_only=True)

    class Meta:
        model = Site
        fields = SITE_EXTERNAL_CORE_FIELDS + SITE_EXTERNAL_KPI_FIELDS + ['kpi_2g_json', 'kpi_3g_json', 'sectors']


class ExternalSectorWriteSerializer(serializers.Serializer):
    """Nested inside `ExternalSiteWriteSerializer` below — deliberately a
    plain `Serializer`, NOT the internal `SectorWriteSerializer`
    (ModelSerializer). `SectorWriteSerializer`'s fields mirror the
    Sector model's `blank=True, default=''`-style options, and DRF's
    ModelSerializer machinery turns each of those model-level defaults
    into a serializer-level `default=` too — meaning an OMITTED field
    would still land in `validated_data` as `''`/`None`, silently
    blanking that column on every upsert instead of leaving it untouched.
    Every field here is `required=False` with NO default, so an omitted
    field stays genuinely absent from `validated_data` — matching
    `ExternalSiteWriteSerializer`'s own partial-update reasoning, applied
    per-sector too (a KPI feed pushing one cell's `kpi_json` shouldn't be
    able to accidentally wipe that same cell's `azimuth`/`pci`/etc by
    omission)."""
    cell_name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    sector = serializers.CharField(max_length=100, required=False, allow_blank=True)
    tech = serializers.CharField(max_length=100, required=False, allow_blank=True)
    local_cell_id = serializers.IntegerField(required=False, allow_null=True)
    height = serializers.FloatField(required=False, allow_null=True)
    azimuth = serializers.FloatField(required=False, allow_null=True)
    mech_tilt = serializers.FloatField(required=False, allow_null=True)
    elec_tilt = serializers.FloatField(required=False, allow_null=True)
    pci = serializers.IntegerField(required=False, allow_null=True)
    scrambling_code = serializers.IntegerField(required=False, allow_null=True)
    bcch = serializers.IntegerField(required=False, allow_null=True)
    bsic = serializers.IntegerField(required=False, allow_null=True)
    kpi_json = serializers.JSONField(required=False, allow_null=True)
    kpi_date = serializers.CharField(max_length=32, required=False, allow_blank=True)
    lat = serializers.FloatField(required=False, allow_null=True)
    lng = serializers.FloatField(required=False, allow_null=True)
    carrier = serializers.CharField(max_length=255, required=False, allow_blank=True)
    site_band = serializers.CharField(max_length=255, required=False, allow_blank=True)
    cell_active_status = serializers.CharField(max_length=255, required=False, allow_blank=True)
    site_existence = serializers.CharField(max_length=255, required=False, allow_blank=True)


class ExternalSiteWriteSerializer(serializers.Serializer):
    """`POST /api/external/v1/sites/` — upserts ONE site by `id`. A plain
    `Serializer`, not a `ModelSerializer`: every field besides `id` is
    `required=False` with no default, so a field simply ABSENT from the
    request body stays absent from `validated_data` entirely (not set to
    `None`) — true partial-update semantics, matching how a real external
    KPI feed behaves (a system pushing today's `call_drop`/`cell_avail`
    numbers shouldn't have to also resend `name`/`region`/every other
    field or risk blanking them out). `external_api._upsert_site()` reads
    `validated_data` and only ever sets the keys that are actually
    present.

    Nested `sectors` uses `ExternalSectorWriteSerializer` (see its own
    docstring for why that's a hand-written plain Serializer, not the
    internal `SectorWriteSerializer`), with UPSERT semantics deliberately
    different from and safer than the internal API's: sectors are
    matched by `cell_name` and updated/created — never deleted. The
    internal `SiteWriteSerializer`'s "full replace" contract (delete
    every sector not in the payload) would let a partial external KPI
    push accidentally wipe out sectors the sender never even meant to
    touch."""
    id = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    region = serializers.CharField(max_length=100, required=False, allow_blank=True)
    city = serializers.CharField(max_length=100, required=False, allow_blank=True)
    district = serializers.CharField(max_length=100, required=False, allow_blank=True)
    lat = serializers.FloatField(required=False, allow_null=True)
    lng = serializers.FloatField(required=False, allow_null=True)
    type = serializers.CharField(max_length=50, required=False, allow_blank=True)
    tech = serializers.CharField(max_length=50, required=False, allow_blank=True)
    status = serializers.CharField(max_length=20, required=False, allow_blank=True)
    status_2g = serializers.CharField(max_length=20, required=False, allow_blank=True)
    status_3g = serializers.CharField(max_length=20, required=False, allow_blank=True)
    kpi_entered = serializers.BooleanField(required=False)
    kpi_entered_2g = serializers.BooleanField(required=False)
    kpi_entered_3g = serializers.BooleanField(required=False)
    kpi_date = serializers.CharField(max_length=32, required=False, allow_blank=True)
    kpi_2g_json = serializers.JSONField(required=False, allow_null=True)
    kpi_3g_json = serializers.JSONField(required=False, allow_null=True)
    rrc = serializers.FloatField(required=False, allow_null=True)
    erab = serializers.FloatField(required=False, allow_null=True)
    call_setup = serializers.FloatField(required=False, allow_null=True)
    call_drop = serializers.FloatField(required=False, allow_null=True)
    svc_drop = serializers.FloatField(required=False, allow_null=True)
    intra_ho = serializers.FloatField(required=False, allow_null=True)
    inter_ho = serializers.FloatField(required=False, allow_null=True)
    inter_rat = serializers.FloatField(required=False, allow_null=True)
    ip_thru = serializers.FloatField(required=False, allow_null=True)
    ip_thru_dl = serializers.FloatField(required=False, allow_null=True)
    ip_thru_ul = serializers.FloatField(required=False, allow_null=True)
    ip_lat = serializers.FloatField(required=False, allow_null=True)
    prb = serializers.FloatField(required=False, allow_null=True)
    prb_dl = serializers.FloatField(required=False, allow_null=True)
    prb_ul = serializers.FloatField(required=False, allow_null=True)
    bearer_util = serializers.FloatField(required=False, allow_null=True)
    lic_util = serializers.FloatField(required=False, allow_null=True)
    cell_avail = serializers.FloatField(required=False, allow_null=True)
    volte_setup = serializers.FloatField(required=False, allow_null=True)
    csfb = serializers.FloatField(required=False, allow_null=True)
    rssi = serializers.FloatField(required=False, allow_null=True)
    load = serializers.FloatField(required=False, allow_null=True)
    sectors = ExternalSectorWriteSerializer(many=True, required=False)


class ExternalDtSessionListSerializer(serializers.ModelSerializer):
    """`GET /api/external/v1/dt-sessions/` — metadata only (matches the
    internal list contract's "samples can be tens of thousands per
    session" reasoning, see DriveTestSessionListSerializer above). No
    `uploaded_by_name` — external callers have no use for an internal
    staff username, and a session created via the API itself has no
    uploader at all (see ExternalDtSessionCreateSerializer.create)."""
    sample_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = DriveTestSession
        fields = ['id', 'name', 'tech', 'date', 'uploaded_date', 'saved_at', 'meta', 'size_bytes', 'sample_count']


class ExternalDtSessionCreateSerializer(serializers.Serializer):
    """`POST /api/external/v1/dt-sessions/` — creates a new session, with
    an optional inline batch of samples (capped — see
    `external_api.MAX_SAMPLES_PER_REQUEST`; a larger drive-test file
    should follow up with `POST .../<id>/samples/` for the rest). No
    update/upsert path, matching the internal `DriveTestSessionWriteSerializer`'s
    own reasoning: a drive-test session is a point-in-time recording, not
    something that makes sense to "edit" from outside after the fact —
    only append more samples to it."""
    name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    tech = serializers.CharField(max_length=10, required=False)
    date = serializers.DateField(required=False, allow_null=True)
    uploaded_date = serializers.DateField(required=False, allow_null=True)
    meta = serializers.JSONField(required=False, allow_null=True)
    samples = DriveTestSampleSerializer(many=True, required=False)
