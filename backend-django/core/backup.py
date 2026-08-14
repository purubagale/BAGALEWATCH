"""
Backup & Restore — Complete Project (2026-08-05), ported from v1's
"Backup & Restore" modal (bts_monitor.html ~1581-1700 for the UI,
exportProject()/restoreProject() ~14120-14312 for the logic).

v1's ".netwatch" file is a JSON dump of a handful of localStorage keys
plus an IndexedDB read (it has no server — everything lives in the
browser). v2 already stores every one of those things in real Postgres
tables behind existing GET/PUT endpoints (TreeView, ThresholdsView,
DtBandsView), so rather than inventing a second, parallel export shape,
this file's payload is built from the SAME shapes those endpoints
already return — a v2 backup is "the current state of every one of
those endpoints, plus the full site+sector table, bundled into one JSON
document." `_tree_payload`/`_thresholds_payload`/`_dt_bands_payload`
below intentionally mirror TreeView.get()/ThresholdsView.get()/
DtBandsView.get() line-for-line rather than importing them directly, so
this file has no import-order dependency on views.py beyond the two
permission classes.

**Deliberately NOT ported: "GPS Coordinate Update" / "Fix Region
Names".** v1's version bulk-updates lat/lng/district for existing sites
(and auto-adds missing ones) from a 4,703-row GPS dataset baked directly
into bts_monitor.html as a JS array — a one-time fix for site data that
was known to be incomplete/wrong at the time. v2's Site table is already
seeded from the real, live production database (see Site's own
docstring in models.py — confirmed against bagalewatch.db, not a stale
dataset), so there's no equivalent "bulk-correct known-bad data from an
embedded spreadsheet" need here, and porting that embedded dataset
itself would mean extracting ~4,700 rows out of a single enormous line
in bts_monitor.html into a new v2 data migration — a real chunk of extra
work for a feature v2's live DB doesn't currently need. Flagged to the
user rather than silently dropped; happy to build it if there's a
concrete reason v2's site coordinates need a bulk re-seed.

Gating: export + the restore-preview step -> superadmin or admin,
matching v1's `userCan('backup','write')` (a coarse role-tier check —
see IsAdminOrSuperadmin's own docstring in views.py for why that's the
established pattern in this app, not a per-menu MenuPermission lookup).
The actual RESTORE (full delete-and-replace across sites/sectors/tree/
thresholds) is superadmin-only — the same extra-caution tier this app
already reserves for PermissionsMatrixView.put(), its other most
destructive action.
"""
from datetime import datetime, timezone as dt_timezone

from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DtBand, KpiThreshold, Sector, Site, SiteAssignment, TreeFolder, TreeSettings
from .serializers import SiteDetailSerializer, TreeFolderSerializer
from .views import IsAdminOrSuperadmin, IsSuperadminOnly

BACKUP_TYPE = 'BAGALEWATCH_BTS_V2_BACKUP'
BACKUP_VERSION = 1

# Explicit whitelists for restore — deliberately NOT `fields = '__all__'`
# like SiteDetailSerializer uses for read. `updated_at`/`updated_by` are
# excluded on purpose: they're bookkeeping tied to a specific v2
# install's own users, and restoring them verbatim from another
# system's backup would either point at a user id that doesn't exist
# here or silently misattribute an edit to the wrong account. Left
# unset on restore, same as a fresh site would have.
_SITE_FIELDS = [
    'id', 'name', 'region', 'city', 'district', 'lat', 'lng', 'type', 'tech',
    'status', 'status_2g', 'status_3g', 'rssi', 'load',
    'kpi_entered', 'kpi_entered_2g', 'kpi_entered_3g', 'kpi_date',
    'rrc', 'erab', 'call_setup', 'call_drop', 'svc_drop', 'intra_ho', 'inter_ho', 'inter_rat',
    'ip_thru', 'ip_thru_dl', 'ip_thru_ul', 'ip_lat', 'prb', 'prb_dl', 'prb_ul',
    'bearer_util', 'lic_util', 'cell_avail', 'volte_setup', 'csfb',
    'kpi_2g_json', 'kpi_3g_json',
]
_SECTOR_FIELDS = [
    'cell_name', 'sector', 'tech', 'local_cell_id', 'height', 'azimuth',
    'mech_tilt', 'elec_tilt', 'pci', 'scrambling_code', 'bcch', 'bsic',
    'kpi_json', 'kpi_date',
    # 'lat'/'lng' (per-sector GPS override) and carrier/site_band/
    # cell_active_status/site_existence added 2026-08-09 — this
    # allowlist had silently fallen behind Sector's real schema (found
    # while verifying the "need to store all those data also" work):
    # EXPORT already includes every real Sector column via
    # SectorSerializer's own field list (SiteDetailSerializer nests it),
    # but RESTORE was filtering incoming sector dicts against this
    # separate, stale list — so exporting a project and restoring that
    # exact same backup would have silently dropped every sector's GPS
    # override and all four of these new columns. Keep this list and
    # SectorSerializer's field list in sync going forward.
    'lat', 'lng', 'carrier', 'site_band', 'cell_active_status', 'site_existence',
]


def _tree_payload():
    """Mirrors TreeView.get() exactly (core/views.py)."""
    top_level = TreeFolder.objects.filter(parent__isnull=True).order_by('name')
    assignments = {a.site_id: a.folder_id for a in SiteAssignment.objects.all()}
    settings_row = TreeSettings.objects.filter(pk=1).first()
    return {
        'folders': TreeFolderSerializer(top_level, many=True).data,
        'assignments': assignments,
        'active': bool(settings_row.custom_active) if settings_row else False,
    }


def _thresholds_payload():
    """Mirrors ThresholdsView.get() exactly."""
    return {
        r.kpi_key: {'warn': r.warn, 'crit': r.crit, 'hi': r.hi, 'max': r.max, 'unit': r.unit}
        for r in KpiThreshold.objects.all()
    }


def _dt_bands_payload():
    """Mirrors DtBandsView.get() exactly."""
    out: dict[str, list] = {}
    for r in DtBand.objects.all().order_by('metric_tag', 'sort_order'):
        out.setdefault(r.metric_tag, []).append(
            {'label': r.label, 'min': r.min_value, 'max': r.max_value, 'color': r.color}
        )
    return out


class BackupSummaryView(APIView):
    """GET /api/v2/backup/summary/ — counts shown before export, matching
    v1's modal-open summary card (openBackupModal(), ~14097-14112)."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        sites_qs = Site.objects.all()
        settings_row = TreeSettings.objects.filter(pk=1).first()
        return Response({
            'sites': sites_qs.count(),
            'sectors': Sector.objects.count(),
            'sites_with_kpi': sites_qs.filter(kpi_entered=True).count(),
            'tree_custom': bool(settings_row.custom_active) if settings_row else False,
            'thresholds_count': KpiThreshold.objects.count(),
            'dt_bands_count': DtBand.objects.count(),
        })


class BackupExportView(APIView):
    """GET /api/v2/backup/export/ — full project export. Returns JSON
    (not a file attachment) — the frontend triggers the actual
    `.netwatch` file download client-side from this response body, same
    split v1 itself has between "build the payload" and "turn it into a
    downloadable Blob" (exportProject())."""

    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        sites = Site.objects.prefetch_related('sectors').all().order_by('id')
        sites_data = SiteDetailSerializer(sites, many=True).data
        sectors_count = sum(len(s.get('sectors') or []) for s in sites_data)
        kpi_count = sum(1 for s in sites_data if s.get('kpi_entered'))
        payload = {
            '_type': BACKUP_TYPE,
            '_version': BACKUP_VERSION,
            '_created': datetime.now(dt_timezone.utc).isoformat(),
            '_app': 'BAGALEWATCH BTS v2',
            'meta': {
                'sitesCount': len(sites_data),
                'sectorsCount': sectors_count,
                'kpiCount': kpi_count,
                'exportedBy': request.user.username,
            },
            'sites': sites_data,
            'tree': _tree_payload(),
            'thresholds': _thresholds_payload(),
            'dt_bands': _dt_bands_payload(),
        }
        return Response(payload)


class BackupImportView(APIView):
    """POST /api/v2/backup/import/ — body: {data: <the export payload>,
    restore: {sites, tree, thresholds, dt_bands}} (booleans), matching
    v1's 4 restore checkboxes (v1 also has a "Data Source Config" 4th
    checkbox — no v2 equivalent exists to restore, data-source config
    isn't a v2 concept, so that one's dropped; `dt_bands` takes its slot
    instead as a v2-only addition).

    Full delete-and-replace per selected section, inside ONE transaction
    covering the whole request — if any section fails, nothing is
    partially applied. v1's client-side restoreProject() has no such
    guarantee (a mid-restore failure could leave localStorage/IndexedDB
    in a mixed old/new state); a real transactional DB lets v2 do
    strictly better here rather than just matching v1.

    Superadmin only — the single most destructive action in this app."""

    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def post(self, request):
        body = request.data or {}
        data = body.get('data')
        restore = body.get('restore') or {}
        if not isinstance(data, dict) or data.get('_type') != BACKUP_TYPE:
            return Response({'detail': 'Not a valid BAGALEWATCH v2 backup file.'}, status=400)

        restored = []
        with transaction.atomic():
            if restore.get('sites') and isinstance(data.get('sites'), list):
                Sector.objects.all().delete()
                Site.objects.all().delete()
                # Bulk, not per-row (2026-08-10 perf audit finding) — this
                # used to be one Site.objects.create() + one
                # Sector.objects.create() per sector, individually, which
                # on a real ~4,700-site backup with a handful of sectors
                # each meant roughly 15,000-20,000 separate INSERT round
                # trips inside a single transaction. Restore is rare and
                # admin-only, but it's exactly the moment someone needs
                # the app back FAST (usually because something just went
                # wrong) — a restore that takes minutes instead of seconds
                # is a bad experience at the worst possible time. Site's
                # PK is the caller-supplied `id` string (not an
                # auto-increment column), so every Site() instance already
                # has its real PK before insert — bulk_create works
                # cleanly here with no two-pass "insert then refetch PKs"
                # dance.
                sites_to_create = []
                sectors_to_create = []
                for row in data['sites']:
                    row = row or {}
                    sectors = row.get('sectors') or []
                    site_fields = {k: v for k, v in row.items() if k in _SITE_FIELDS}
                    if not site_fields.get('id'):
                        continue
                    sites_to_create.append(Site(**site_fields))
                    for sec in sectors:
                        sec_fields = {k: v for k, v in (sec or {}).items() if k in _SECTOR_FIELDS}
                        sectors_to_create.append(Sector(site_id=site_fields['id'], **sec_fields))
                if sites_to_create:
                    Site.objects.bulk_create(sites_to_create, batch_size=1000)
                if sectors_to_create:
                    Sector.objects.bulk_create(sectors_to_create, batch_size=1000)
                restored.append(f"{len(sites_to_create)} sites")

            if restore.get('tree') and isinstance(data.get('tree'), dict):
                tree = data['tree']

                def create_folder(node, parent):
                    if not node or not node.get('id'):
                        return
                    folder = TreeFolder.objects.create(
                        id=node['id'], parent=parent, name=node.get('name') or '', icon=node.get('icon') or '',
                        lat=node.get('lat'), lng=node.get('lng'),
                    )
                    for child in (node.get('children') or []):
                        create_folder(child, folder)

                TreeFolder.objects.all().delete()
                SiteAssignment.objects.all().delete()
                for node in (tree.get('folders') or []):
                    create_folder(node, None)
                known_site_ids = set(Site.objects.values_list('id', flat=True))
                known_folder_ids = set(TreeFolder.objects.values_list('id', flat=True))
                assignments = tree.get('assignments') or {}
                to_create = [
                    SiteAssignment(site_id=site_id, folder_id=folder_id)
                    for site_id, folder_id in assignments.items()
                    if site_id in known_site_ids and folder_id in known_folder_ids
                ]
                if to_create:
                    SiteAssignment.objects.bulk_create(to_create)
                TreeSettings.objects.update_or_create(pk=1, defaults={'custom_active': bool(tree.get('active'))})
                restored.append('tree structure')

            if restore.get('thresholds') and isinstance(data.get('thresholds'), dict):
                for kpi_key, t in data['thresholds'].items():
                    t = t or {}
                    KpiThreshold.objects.update_or_create(
                        kpi_key=kpi_key,
                        defaults=dict(
                            warn=t.get('warn'), crit=t.get('crit'),
                            hi=bool(t.get('hi')), max=t.get('max'), unit=t.get('unit') or '',
                        ),
                    )
                restored.append('thresholds')

            if restore.get('dt_bands') and isinstance(data.get('dt_bands'), dict):
                for tag, bands in data['dt_bands'].items():
                    if not isinstance(bands, list):
                        continue
                    DtBand.objects.filter(metric_tag=tag).delete()
                    rows = [
                        DtBand(
                            metric_tag=tag, label=(b or {}).get('label') or '',
                            min_value=(b or {}).get('min') or 0, max_value=(b or {}).get('max') or 0,
                            color=(b or {}).get('color') or '#94a3b8', sort_order=i,
                        )
                        for i, b in enumerate(bands)
                    ]
                    if rows:
                        DtBand.objects.bulk_create(rows)
                restored.append('band colors')

        return Response({'ok': True, 'restored': restored})
