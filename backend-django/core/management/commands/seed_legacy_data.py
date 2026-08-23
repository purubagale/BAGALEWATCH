"""
python manage.py seed_legacy_data /path/to/bagalewatch.db [--wipe]

Read-only, one-directional import of v1's real data (users, sites,
sectors, role_permissions, KPI thresholds, tree structure) into the v2
Postgres schema, per §0 of the migration plan's isolation guarantee.
Follows the exact same pattern as scripts/copy_and_inspect_legacy_db.py:
the source bagalewatch.db is never opened for writing, never locked, and
the running v1 server is never touched — this command makes a
byte-for-byte copy (shutil.copy2) first, then opens ONLY the copy, in
SQLite's own read-only/immutable mode as a second layer of protection,
and does all reads against that.

--wipe clears the v2 Site/Sector/MenuPermission/KpiThreshold/tree-structure
tables before importing (never Users — accidentally wiping auth accounts
on a re-run would be a bad surprise). Without --wipe, re-running against
a database that already has sites/sectors will fail on the primary-key
collision, which is intentional: this is a one-time offline import, not a
sync job, so a silent partial-overwrite is worse than a loud failure.
"""
import json
import os
import shutil
import sqlite3
import tempfile

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.core.management.color import no_style
from django.db import connection, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from core.models import KpiThreshold, MenuPermission, Sector, Site, SiteAssignment, TreeFolder, TreeSettings

User = get_user_model()


# v1's sidebar tree groups sites by NTC's 5 traditional development
# regions (Central/Eastern/Western/Mid-West/Far-West) — NOT the 7 modern
# federal provinces. Each region is determined purely by the site ID
# prefix; KTM-prefixed sites (Kathmandu/Lalitpur/Bhaktapur) are Central
# region despite not sharing the CDR prefix. This is a different, simpler
# scheme than v1's _SITE_REGION_MAP (which maps site_id -> current
# province, used elsewhere in v1, not for the tree) — confirmed directly
# by the user 2026-07-27 after an initial fix attempt that ported
# _SITE_REGION_MAP into `region` turned out to target the wrong scheme
# entirely. District-level grouping underneath each region is unaffected
# by this — v1 already derives `district` from GPS coordinates
# (importGpsData()/fixSiteRegions() in bts_monitor.html), and that value
# is copied through unchanged.
_REGION_PREFIX_RULES = (
    ('MWDR', 'Mid-West'),
    ('FWDR', 'Far-West'),
    ('CDR', 'Central'),
    ('EDR', 'Eastern'),
    ('WDR', 'Western'),
    ('KTM', 'Central'),
)


def _region_from_site_id(site_id):
    """Returns the traditional 5-region name for a site ID prefix, or
    None if the prefix isn't recognized (caller falls back to the raw
    region column value in that case — never worse than before this fix)."""
    if not site_id:
        return None
    for prefix, region in _REGION_PREFIX_RULES:
        if site_id.startswith(prefix):
            return region
    return None


def _rewrite_password_hash(stored_hash):
    """Rewrites a v1 password hash's algorithm prefix so Django's hasher
    lookup (identify_hasher) routes it to the matching Legacy* hasher in
    core/hashers.py instead of colliding with Django's own PBKDF2PasswordHasher
    (which uses the same 'pbkdf2_sha256' prefix but a different, base64
    encoding — see hashers.py's module docstring for the full story).
    Returns None for anything unrecognized, so the caller can flag it
    rather than silently import a hash nothing can ever verify."""
    if not stored_hash:
        return None
    if stored_hash.startswith('pbkdf2_sha256$'):
        _, rest = stored_hash.split('$', 1)
        return f'bagalewatch_legacy_pbkdf2${rest}'
    if stored_hash.startswith('sha256:'):
        _, hex_digest = stored_hash.split(':', 1)
        return f'bagalewatch_legacy_sha256${hex_digest}'
    return None


def _to_bool(v):
    return bool(v) if v is not None else False


def _num(v):
    """SQLite has no real type enforcement (manifest typing) — a REAL or
    INTEGER-affinity column can still hold '' if something upstream ever
    inserted an empty string instead of NULL. Confirmed against the real
    production data on 2026-07-27: sectors.local_cell_id (and, going by
    how uniformly the v1 client writes these columns, potentially any
    other nullable numeric column) has empty-string rows. Django's
    Float/IntegerField raises ValueError on '' — coerce it to None so
    bulk_create doesn't blow up on real data. Any genuine number passes
    through unchanged; Django/psycopg handles the actual cast."""
    if v is None or v == '':
        return None
    return v


def _to_json(v):
    if not v:
        return None
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return None


def _to_datetime(v):
    if not v:
        return None
    dt = parse_datetime(v)
    if dt is None:
        return None
    # v1 stores naive local-ish timestamps as free-text; USE_TZ=True means
    # Django wants an aware datetime or it emits a RuntimeWarning (harmless
    # but noisy across ~4,700 rows). Treating them as UTC matches
    # settings.py's TIME_ZONE — not a claim the original timestamps were
    # literally recorded in UTC, just a consistent, documented assumption
    # for a field that's informational (last-updated display) rather than
    # used in any time-sensitive query in Phase 1.
    if timezone.is_naive(dt):
        # No explicit tzinfo arg: make_aware() defaults to
        # timezone.get_current_timezone(), which is settings.py's
        # TIME_ZONE='UTC' — avoids django.utils.timezone.utc, which
        # Django 5.x removed in favor of Python's own datetime.timezone.utc.
        dt = timezone.make_aware(dt)
    return dt


class Command(BaseCommand):
    help = 'Import users/sites/sectors/role_permissions/thresholds/tree structure from a v1 bagalewatch.db (read-only copy).'

    def add_arguments(self, parser):
        parser.add_argument('source_db', help='Path to bagalewatch.db (the LIVE file — a copy is made automatically, it is never opened directly).')
        parser.add_argument('--wipe', action='store_true', help='Clear existing Site/Sector/MenuPermission/KpiThreshold/tree-structure rows before importing (never Users).')

    def handle(self, *args, **options):
        source_path = options['source_db']
        if not os.path.isfile(source_path):
            raise CommandError(f'{source_path} does not exist or is not a file.')

        tmp_dir = tempfile.mkdtemp(prefix='dtwatch_seed_')
        copy_path = os.path.join(tmp_dir, 'dtwatch_snapshot.db')
        self.stdout.write(f'Copying (read-only) {source_path}\n            -> {copy_path}')
        shutil.copy2(source_path, copy_path)
        self.stdout.write(self.style.SUCCESS(f'Copy complete: {os.path.getsize(copy_path):,} bytes.'))

        conn = sqlite3.connect(f'file:{copy_path}?mode=ro&immutable=1', uri=True)
        conn.row_factory = sqlite3.Row
        try:
            self._import(conn, wipe=options['wipe'])
        finally:
            conn.close()
            shutil.rmtree(tmp_dir, ignore_errors=True)

    @transaction.atomic
    def _import(self, conn, wipe):
        if wipe:
            self.stdout.write('--wipe: clearing existing Site/Sector/MenuPermission/threshold/tree rows (Users untouched)...')
            SiteAssignment.objects.all().delete()
            # TreeFolder.parent is a self-referencing FK with
            # on_delete=CASCADE (see models.py — TreeSubfolder was retired
            # during the arbitrary-depth tree redesign), so deleting every
            # TreeFolder row already removes every nested folder at any
            # depth. This line used to also delete a separate
            # TreeSubfolder queryset, which no longer exists — that
            # leftover call was never cleaned up after the redesign and
            # crashed --wipe with a NameError (found 2026-07-28, live).
            TreeFolder.objects.all().delete()
            TreeSettings.objects.all().delete()
            KpiThreshold.objects.all().delete()
            Sector.objects.all().delete()
            Site.objects.all().delete()
            MenuPermission.objects.all().delete()

        # ── Users ────────────────────────────────────────────────────
        users_imported, users_skipped = 0, []
        for r in conn.execute('SELECT * FROM users'):
            pw = _rewrite_password_hash(r['password_hash'])
            if pw is None:
                users_skipped.append(r['username'])
                continue
            role = r['role'] if r['role'] in ('superadmin', 'admin', 'viewer') else 'viewer'
            User.objects.update_or_create(
                id=r['id'],
                defaults=dict(
                    username=r['username'],
                    password=pw,
                    role=role,
                    name=r['name'] or '',
                    dept=r['dept'] or '',
                    is_active=True,
                    is_staff=role in ('superadmin', 'admin'),
                    is_superuser=role == 'superadmin',
                ),
            )
            users_imported += 1
        self.stdout.write(self.style.SUCCESS(f'Users: {users_imported} imported.'))
        if users_skipped:
            self.stdout.write(self.style.WARNING(
                f'Users skipped (unrecognized password hash format): {", ".join(users_skipped)}'
            ))

        # ── Sites ────────────────────────────────────────────────────
        site_rows = conn.execute('SELECT * FROM sites').fetchall()
        unrecognized_prefix_ids = [
            r['id'] for r in site_rows if _region_from_site_id(r['id']) is None
        ]
        if unrecognized_prefix_ids:
            sample = ', '.join(unrecognized_prefix_ids[:15])
            more = f' (+{len(unrecognized_prefix_ids) - 15} more)' if len(unrecognized_prefix_ids) > 15 else ''
            self.stdout.write(self.style.WARNING(
                f'{len(unrecognized_prefix_ids)} site IDs did not match a known region prefix '
                f'(CDR/EDR/WDR/MWDR/FWDR/KTM) and kept their raw region column value: {sample}{more}'
            ))

        sites = [
            Site(
                id=r['id'], name=r['name'] or '', region=_region_from_site_id(r['id']) or r['region'] or '',
                city=r['city'] or '', district=r['district'] or '',
                lat=_num(r['lat']), lng=_num(r['lng']), type=r['type'] or '', tech=r['tech'] or '',
                status=r['status'] or 'nodata', status_2g=r['status_2g'] or '', status_3g=r['status_3g'] or '',
                rssi=_num(r['rssi']), load=_num(r['load']),
                kpi_entered=_to_bool(r['kpi_entered']), kpi_entered_2g=_to_bool(r['kpi_entered_2g']),
                kpi_entered_3g=_to_bool(r['kpi_entered_3g']), kpi_date=r['kpi_date'] or '',
                rrc=_num(r['rrc']), erab=_num(r['erab']), call_setup=_num(r['call_setup']), call_drop=_num(r['call_drop']),
                svc_drop=_num(r['svc_drop']), intra_ho=_num(r['intra_ho']), inter_ho=_num(r['inter_ho']), inter_rat=_num(r['inter_rat']),
                ip_thru=_num(r['ip_thru']), ip_thru_dl=_num(r['ip_thru_dl']), ip_thru_ul=_num(r['ip_thru_ul']), ip_lat=_num(r['ip_lat']),
                prb=_num(r['prb']), prb_dl=_num(r['prb_dl']), prb_ul=_num(r['prb_ul']),
                bearer_util=_num(r['bearer_util']), lic_util=_num(r['lic_util']), cell_avail=_num(r['cell_avail']),
                volte_setup=_num(r['volte_setup']), csfb=_num(r['csfb']),
                kpi_2g_json=_to_json(r['kpi_2g_json']), kpi_3g_json=_to_json(r['kpi_3g_json']),
                updated_at=_to_datetime(r['updated_at']), updated_by_id=_num(r['updated_by']),
            )
            for r in site_rows
        ]
        Site.objects.bulk_create(sites, batch_size=500)
        self.stdout.write(self.style.SUCCESS(f'Sites: {len(sites)} imported.'))

        # ── Sectors ──────────────────────────────────────────────────
        sector_rows = conn.execute('SELECT * FROM sectors').fetchall()
        sectors = [
            Sector(
                id=r['id'], site_id=r['site_id'], cell_name=r['cell_name'] or '',
                sector=r['sector'] or '', tech=r['tech'] or '', local_cell_id=_num(r['local_cell_id']),
                height=_num(r['height']), azimuth=_num(r['azimuth']), mech_tilt=_num(r['mech_tilt']), elec_tilt=_num(r['elec_tilt']),
                pci=_num(r['pci']), scrambling_code=_num(r['scrambling_code']), bcch=_num(r['bcch']), bsic=_num(r['bsic']),
                kpi_json=_to_json(r['kpi_json']), kpi_date=r['kpi_date'] or '',
            )
            for r in sector_rows
        ]
        Sector.objects.bulk_create(sectors, batch_size=1000)
        self.stdout.write(self.style.SUCCESS(f'Sectors: {len(sectors)} imported.'))

        # ── Role permissions ─────────────────────────────────────────
        perm_rows = conn.execute('SELECT * FROM role_permissions').fetchall()
        perms = [
            MenuPermission(role=r['role'], menu_key=r['menu_key'], action=r['action'], allowed=_to_bool(r['allowed']))
            for r in perm_rows
        ]
        MenuPermission.objects.bulk_create(perms, batch_size=500)
        self.stdout.write(self.style.SUCCESS(f'Role permissions: {len(perms)} imported.'))

        # ── KPI thresholds ───────────────────────────────────────────
        threshold_rows = conn.execute('SELECT * FROM thresholds').fetchall()
        thresholds = [
            KpiThreshold(
                kpi_key=r['kpi_key'], warn=_num(r['warn']), crit=_num(r['crit']),
                hi=_to_bool(r['hi']), max=_num(r['max']), unit=r['unit'] or '',
            )
            for r in threshold_rows
        ]
        KpiThreshold.objects.bulk_create(thresholds, batch_size=200)
        self.stdout.write(self.style.SUCCESS(f'KPI thresholds: {len(thresholds)} imported.'))

        # ── Tree structure (folders/subfolders/site assignments) ────
        # v1's tree is a fixed 2-level hierarchy (tree_folders +
        # tree_subfolders, a separate table one level deep). v2's
        # TreeFolder now nests to arbitrary depth via a self-referencing
        # `parent` (2026-07-27, user-confirmed, beyond v1 parity — see
        # the model's docstring), so this import flattens v1's 2-level
        # source data into that single recursive table: top-level
        # folders get parent=None, and each subfolder becomes a TreeFolder
        # whose parent is the folder it belonged to — same ids preserved
        # either way, so nothing downstream needs an id translation table.
        folder_rows = conn.execute('SELECT id, name, icon FROM tree_folders').fetchall()
        folders_by_id = {}
        for r in folder_rows:
            folders_by_id[r['id']] = TreeFolder.objects.create(id=r['id'], parent=None, name=r['name'] or '', icon=r['icon'] or '')
        self.stdout.write(self.style.SUCCESS(f'Tree folders: {len(folders_by_id)} imported.'))

        subfolder_rows = conn.execute('SELECT id, folder_id, name, icon, lat, lng FROM tree_subfolders').fetchall()
        all_folders_by_id = dict(folders_by_id)
        skipped_subfolders = 0
        for r in subfolder_rows:
            parent = folders_by_id.get(r['folder_id'])
            if parent is None:
                skipped_subfolders += 1
                continue
            all_folders_by_id[r['id']] = TreeFolder.objects.create(
                id=r['id'], parent=parent, name=r['name'] or '', icon=r['icon'] or '',
                lat=_num(r['lat']), lng=_num(r['lng']),
            )
        self.stdout.write(self.style.SUCCESS(f'Tree subfolders: {len(all_folders_by_id) - len(folders_by_id)} imported.'))
        if skipped_subfolders:
            self.stdout.write(self.style.WARNING(
                f'Tree subfolders skipped (dangling folder_id, no matching folder row): {skipped_subfolders}'
            ))

        # v1 splits an assignment across folder_id + subfolder_id; the
        # unified model just needs whichever one is the actual leaf the
        # site was assigned to. site_assignments.site_id has an FK to
        # sites, and the effective folder must be one we actually created
        # above (not a dangling id) — both skipped defensively, same as
        # v1's own _set_tree_state.
        known_site_ids = {s.id for s in sites}
        assignment_rows = conn.execute('SELECT site_id, folder_id, subfolder_id FROM site_assignments').fetchall()
        assignments = []
        skipped_assignments = 0
        for r in assignment_rows:
            effective_folder_id = r['subfolder_id'] or r['folder_id']
            if r['site_id'] not in known_site_ids or effective_folder_id not in all_folders_by_id:
                skipped_assignments += 1
                continue
            assignments.append(SiteAssignment(site_id=r['site_id'], folder_id=effective_folder_id))
        SiteAssignment.objects.bulk_create(assignments, batch_size=500)
        self.stdout.write(self.style.SUCCESS(f'Site tree assignments: {len(assignments)} imported.'))
        if skipped_assignments:
            self.stdout.write(self.style.WARNING(
                f'Site tree assignments skipped (unknown site or dangling folder reference): {skipped_assignments}'
            ))

        settings_row = conn.execute('SELECT custom_active FROM tree_settings WHERE id = 1').fetchone()
        if settings_row is not None:
            TreeSettings.objects.update_or_create(pk=1, defaults={'custom_active': _to_bool(settings_row['custom_active'])})
            self.stdout.write(self.style.SUCCESS(f"Tree settings: custom_active={_to_bool(settings_row['custom_active'])}."))

        # User.id and Sector.id are standard Django AutoFields, but the
        # imports above set them explicitly (copied from v1's row ids) so
        # seeded ids match the source system. On Postgres, an explicit-PK
        # INSERT does NOT advance the backing sequence — the next row
        # created *without* an explicit id (e.g. POST /api/v2/users/,
        # or a future Sector created through the site-edit "add sector"
        # flow) gets a low auto-assigned id that's already taken, and the
        # INSERT fails with an IntegrityError the view doesn't catch,
        # surfacing as an opaque HTTP 500. SQLite doesn't have this
        # failure mode (no persistent sequence counter), which is why this
        # didn't show up in the sqlite-backed test suite — same class of
        # gotcha as the password max_length column above. sequence_reset_sql
        # is a no-op on SQLite, so this is safe to run unconditionally.
        sequence_sql = connection.ops.sequence_reset_sql(no_style(), [User, Sector])
        if sequence_sql:
            with connection.cursor() as cursor:
                for sql in sequence_sql:
                    cursor.execute(sql)
            self.stdout.write(self.style.SUCCESS(
                'Reset Postgres auto-increment sequences for User/Sector (explicit-id import).'
            ))

        self.stdout.write(self.style.SUCCESS(
            f'\nDone. {users_imported} users, {len(sites)} sites, {len(sectors)} sectors, '
            f'{len(perms)} permission rows, {len(thresholds)} thresholds, {len(folders_by_id)} tree folders, '
            f'{len(all_folders_by_id) - len(folders_by_id)} tree subfolders, {len(assignments)} site assignments imported into the v2 database.'
        ))
