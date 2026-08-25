import math

from django.contrib.auth import get_user_model, password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from django.utils import timezone
from rest_framework import serializers

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
                  'last_login', 'date_joined', 'auth_source']
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
        fields = ['id', 'username', 'password', 'role', 'name', 'dept', 'is_active']

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
    this is intentionally NOT a partial update."""
    sectors = SectorWriteSerializer(many=True, required=False)

    class Meta:
        model = Site
        fields = '__all__'
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


class DriveTestSessionDetailSerializer(DriveTestSessionListSerializer):
    samples = DriveTestSampleSerializer(many=True, read_only=True)

    class Meta(DriveTestSessionListSerializer.Meta):
        fields = DriveTestSessionListSerializer.Meta.fields + ['samples']


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
    samples = DriveTestSampleSerializer(many=True, read_only=True, source='filtered_samples')

    class Meta(DriveTestSessionListSerializer.Meta):
        fields = DriveTestSessionListSerializer.Meta.fields + ['samples']


# ~1km nearby-site tagging (2026-07-30 request) — "through this tag, it
# will be easier for future search also". Kept as free functions here
# (not in drive_test.py, even though drive_test.py already has an
# identical _haversine_km for its near() endpoint) because drive_test.py
# imports from this module — importing back the other way would be
# circular. Same formula, duplicated deliberately.
NEARBY_SITE_RADIUS_KM = 1.0


def _haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _nearby_site_ids(sample_points, radius_km=NEARBY_SITE_RADIUS_KM):
    """Every Site within radius_km of AT LEAST ONE sample point — the
    plural counterpart to the single nearest-site match v1 already
    computes into meta (siteId/siteName/siteDistKm — see
    DriveTestSession's docstring). Used both at upload time
    (DriveTestSessionWriteSerializer.create below) and by the
    backfill_nearby_sites management command for existing sessions.

    sample_points: iterable of (lat, lng) tuples (None-safe — filtered
    below). Deduped to a coarse ~100m grid first: a session can have
    tens of thousands of samples, and checking every candidate site
    against every raw sample would be wasteful when all that's needed
    is "is this site within radius of at least one point somewhere on
    the route", not a distance for every sample.
    """
    points = {
        (round(lat, 3), round(lng, 3))
        for lat, lng in sample_points
        if lat is not None and lng is not None
    }
    if not points:
        return []

    lats = [p[0] for p in points]
    lngs = [p[1] for p in points]
    # Bounding-box prefilter (cheap index range scan), same pattern as
    # drive_test.py's near() endpoint, sized to the whole point cloud's
    # extent plus one radius on each side.
    lat_delta = radius_km / 111.0
    lng_delta = radius_km / (111.0 * max(min(math.cos(math.radians(lat)) for lat in lats), 0.01))
    candidates = Site.objects.filter(
        lat__isnull=False, lng__isnull=False,
        lat__gte=min(lats) - lat_delta, lat__lte=max(lats) + lat_delta,
        lng__gte=min(lngs) - lng_delta, lng__lte=max(lngs) + lng_delta,
    ).only('id', 'lat', 'lng')

    matched = []
    for site in candidates:
        for lat, lng in points:
            if _haversine_km(lat, lng, site.lat, site.lng) <= radius_km:
                matched.append(site.id)
                break
    return matched


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
    in via repeated calls to DriveTestSessionViewSet.samples()."""
    samples = DriveTestSampleSerializer(many=True, write_only=True, required=False)

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
        samples_data = validated_data.pop('samples', [])
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
        DriveTestSample.objects.bulk_create(
            [DriveTestSample(session=session, **s) for s in samples_data],
            batch_size=1000,
        )
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
        session.size_bytes = len(str(validated_data)) + len(str(meta)) + sum(len(str(s)) for s in samples_data)
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
