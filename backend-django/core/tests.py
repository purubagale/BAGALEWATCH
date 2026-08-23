"""
Phase 1 test coverage. Kept deliberately focused on the two things most
likely to silently break and hardest to eyeball-verify: the legacy
password hasher (any bug here means EVERY migrated account is locked out,
a full-severity Phase 1 regression) and the permission-shape serializer
(any bug here means the React route guards silently under- or
over-grant access).

Full endpoint coverage (auth flow, site list/detail, sectors) is a
natural next addition once these run against a real database — see
docs/RUNBOOK.md for the "what's verified vs not" status for this phase.
"""
import hashlib
import os
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from core.hashers import LegacyBagalewatchPBKDF2Hasher, LegacyBagalewatchSha256Hasher
from core.management.commands.seed_legacy_data import _rewrite_password_hash
from core.models import (
    AuditHistory, DriveTestSample, DriveTestSession, KpiSnapshot, KpiThreshold, MenuPermission, Sector, Site,
    SiteAssignment, TreeFolder,
)
from core.serializers import MeSerializer

User = get_user_model()


class LegacyPBKDF2HasherTests(TestCase):
    """Verifies against hashes produced the SAME way v1's hash_password()
    in bagalewatch_api.py produces them, so this test would catch a
    real incompatibility, not just test the hasher against itself."""

    def setUp(self):
        self.hasher = LegacyBagalewatchPBKDF2Hasher()

    def _v1_hash(self, password, iterations=200_000):
        import secrets
        salt = secrets.token_hex(16)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), iterations)
        # v1's own format, then rewritten exactly as seed_legacy_data.py does
        return f'bagalewatch_legacy_pbkdf2${iterations}${salt}${dk.hex()}'

    def test_verifies_correct_password(self):
        encoded = self._v1_hash('super123')
        self.assertTrue(self.hasher.verify('super123', encoded))

    def test_rejects_wrong_password(self):
        encoded = self._v1_hash('super123')
        self.assertFalse(self.hasher.verify('wrong-password', encoded))

    def test_must_update_always_true(self):
        self.assertTrue(self.hasher.must_update(self._v1_hash('x')))


class LegacySha256HasherTests(TestCase):
    def test_verifies_correct_password(self):
        hasher = LegacyBagalewatchSha256Hasher()
        encoded = f'bagalewatch_legacy_sha256${hashlib.sha256(b"view123").hexdigest()}'
        self.assertTrue(hasher.verify('view123', encoded))
        self.assertFalse(hasher.verify('wrong', encoded))


class RewritePasswordHashTests(TestCase):
    def test_rewrites_pbkdf2_prefix(self):
        v1 = 'pbkdf2_sha256$200000$abcd1234$deadbeef'
        rewritten = _rewrite_password_hash(v1)
        self.assertEqual(rewritten, 'bagalewatch_legacy_pbkdf2$200000$abcd1234$deadbeef')

    def test_rewrites_sha256_prefix(self):
        v1 = 'sha256:deadbeef'
        rewritten = _rewrite_password_hash(v1)
        self.assertEqual(rewritten, 'bagalewatch_legacy_sha256$deadbeef')

    def test_unrecognized_format_returns_none(self):
        self.assertIsNone(_rewrite_password_hash('bcrypt$something'))
        self.assertIsNone(_rewrite_password_hash(''))
        self.assertIsNone(_rewrite_password_hash(None))


class UpgradeOnLoginTests(TestCase):
    """The important end-to-end behavior: a user imported with a legacy
    hash can log in, AND their stored hash is silently upgraded to
    Django's native format afterward — proving the upgrade-on-login
    mechanic described in hashers.py's docstring actually fires, not
    just that verify() works in isolation."""

    def test_login_upgrades_hash_to_native_format(self):
        salt_hex = 'ab' * 16
        digest = hashlib.pbkdf2_hmac('sha256', b'super123', bytes.fromhex(salt_hex), 200_000).hex()
        encoded = _rewrite_password_hash(f'pbkdf2_sha256$200000${salt_hex}${digest}')

        user = User.objects.create(username='migrated', password=encoded, role='admin')
        self.assertTrue(user.check_password('super123'))

        user.refresh_from_db()
        self.assertTrue(
            user.password.startswith('pbkdf2_sha256$'),
            f'expected native Django format after upgrade, got: {user.password[:20]}...',
        )
        self.assertFalse(user.password.startswith('bagalewatch_legacy_pbkdf2$'))


class MeSerializerPermissionShapeTests(TestCase):
    """CRUD menus should serialize as {read,write,update,delete} dicts;
    simple menus as plain booleans — this is the shape the React route
    guards (api/types.ts's isAllowed()) depend on."""

    def test_crud_menu_shape(self):
        user = User.objects.create(username='admin1', role='admin')
        MenuPermission.objects.create(role='admin', menu_key='sites', action='read', allowed=True)
        MenuPermission.objects.create(role='admin', menu_key='sites', action='write', allowed=True)
        MenuPermission.objects.create(role='admin', menu_key='sites', action='delete', allowed=False)

        data = MeSerializer(user).data
        self.assertEqual(data['permissions']['sites'], {'read': True, 'write': True, 'delete': False})

    def test_simple_menu_shape(self):
        user = User.objects.create(username='admin2', role='admin')
        MenuPermission.objects.create(role='admin', menu_key='reports', action='read', allowed=True)

        data = MeSerializer(user).data
        self.assertEqual(data['permissions']['reports'], True)


# ── Phase 2: write-endpoint coverage ─────────────────────────────────────
# Focused on the two things most likely to silently misbehave: role-gate
# enforcement (a viewer must never be able to write) and the "full
# replace, not partial patch" contract several of these endpoints share
# with v1 (sectors-on-site-update, tree, permissions) — the easiest kind
# of bug to introduce by accident (e.g. switching to Django's default
# partial-update semantics without noticing the shape changed).

class SiteWriteEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        self.admin = User.objects.create(username='a1', role='admin')
        self.site = Site.objects.create(id='WDR900', name='Test Site', region='Western')

    def test_viewer_cannot_create_site(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.post('/api/v2/sites/', {'id': 'WDR901', 'name': 'New'}, format='json')
        self.assertEqual(resp.status_code, 403)

    def test_admin_can_create_site_with_sectors(self):
        self.client.force_authenticate(self.admin)
        payload = {
            'id': 'WDR901', 'name': 'New Site', 'region': 'Western',
            'sectors': [{'cell_name': 'WDR901_A', 'sector': 'A', 'pci': 12}],
        }
        resp = self.client.post('/api/v2/sites/', payload, format='json')
        self.assertEqual(resp.status_code, 201, resp.data)
        site = Site.objects.get(id='WDR901')
        self.assertEqual(site.sectors.count(), 1)
        self.assertEqual(site.sectors.first().cell_name, 'WDR901_A')
        self.assertEqual(site.updated_by, self.admin)

    def test_update_replaces_sectors_not_merges(self):
        self.site.sectors.create(cell_name='OLD_A', sector='A')
        self.site.sectors.create(cell_name='OLD_B', sector='B')
        self.client.force_authenticate(self.admin)
        payload = {'id': self.site.id, 'name': 'Renamed', 'sectors': [{'cell_name': 'NEW_A', 'sector': 'A'}]}
        resp = self.client.put(f'/api/v2/sites/{self.site.id}/', payload, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.site.refresh_from_db()
        self.assertEqual(self.site.name, 'Renamed')
        self.assertEqual(list(self.site.sectors.values_list('cell_name', flat=True)), ['NEW_A'])

    def test_update_ignores_id_in_body_uses_url(self):
        # A stray/mismatched 'id' in the PUT body must not rename or
        # redirect the write — the URL is authoritative (see
        # SiteWriteSerializer.update()'s comment on why).
        self.client.force_authenticate(self.admin)
        payload = {'id': 'SOMETHING_ELSE', 'name': 'Renamed Again'}
        resp = self.client.put(f'/api/v2/sites/{self.site.id}/', payload, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.site.refresh_from_db()
        self.assertEqual(self.site.name, 'Renamed Again')
        self.assertFalse(Site.objects.filter(id='SOMETHING_ELSE').exists())

    def test_admin_can_delete_site(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.delete(f'/api/v2/sites/{self.site.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Site.objects.filter(id=self.site.id).exists())

    def test_rssi_and_load_persist_and_appear_in_detail(self):
        # Regression test for task #38: rssi/load were missing from the
        # Site model entirely despite existing on v1's real sites table
        # (bagalewatch_api.py's SCHEMA_SQL) — Scatter Plot needs both.
        self.client.force_authenticate(self.admin)
        payload = {'id': self.site.id, 'name': self.site.name, 'rssi': -78.5, 'load': 42.0}
        resp = self.client.put(f'/api/v2/sites/{self.site.id}/', payload, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data['rssi'], -78.5)
        self.assertEqual(resp.data['load'], 42.0)
        detail = self.client.get(f'/api/v2/sites/{self.site.id}/')
        self.assertEqual(detail.data['rssi'], -78.5)
        self.assertEqual(detail.data['load'], 42.0)


class ThresholdsEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create(username='a2', role='admin')
        KpiThreshold.objects.create(kpi_key='callDrop', warn=2, crit=5, hi=False, unit='%')
        KpiThreshold.objects.create(kpi_key='cellAvail', warn=98, crit=95, hi=True, unit='%')

    def test_get_returns_full_dict(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.get('/api/v2/thresholds/')
        self.assertEqual(resp.data['callDrop'], {'warn': 2.0, 'crit': 5.0, 'hi': False, 'max': None, 'unit': '%'})
        self.assertIn('cellAvail', resp.data)

    def test_put_only_touches_provided_keys(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.put('/api/v2/thresholds/', {'callDrop': {'warn': 3, 'crit': 6, 'unit': '%'}}, format='json')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(KpiThreshold.objects.get(kpi_key='callDrop').warn, 3)
        # cellAvail wasn't in the PUT body — must be untouched, not deleted.
        self.assertTrue(KpiThreshold.objects.filter(kpi_key='cellAvail', warn=98).exists())


class TreeEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create(username='a3', role='admin')
        Site.objects.create(id='WDR910', name='Known Site')

    def test_full_replace_and_unknown_site_skipped(self):
        self.client.force_authenticate(self.admin)
        # Nested to 3 levels deliberately — this is the arbitrary-depth
        # redesign (2026-07-27, user-confirmed, beyond v1's fixed 2-level
        # folder/subfolder), so the regression test should actually
        # exercise depth beyond what v1 could ever represent.
        payload = {
            'folders': [{'id': 'f1', 'name': 'My Folder', 'icon': 'star', 'children': [
                {'id': 'sf1', 'name': 'Sub', 'icon': 'pin', 'lat': 27.7, 'lng': 85.3, 'children': [
                    {'id': 'ssf1', 'name': 'Sub-sub', 'icon': '', 'children': []},
                ]},
            ]}],
            'assignments': {
                'WDR910': 'ssf1',
                'DOES_NOT_EXIST': 'f1',
            },
            'active': True,
        }
        resp = self.client.put('/api/v2/tree/', payload, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertTrue(TreeFolder.objects.filter(id='f1', parent__isnull=True).exists())
        self.assertTrue(TreeFolder.objects.filter(id='sf1', parent_id='f1').exists())
        self.assertTrue(TreeFolder.objects.filter(id='ssf1', parent_id='sf1').exists())
        self.assertTrue(SiteAssignment.objects.filter(site_id='WDR910', folder_id='ssf1').exists())
        self.assertFalse(SiteAssignment.objects.filter(site_id='DOES_NOT_EXIST').exists())

        get_resp = self.client.get('/api/v2/tree/')
        self.assertEqual(get_resp.data['active'], True)
        self.assertEqual(len(get_resp.data['folders']), 1)
        self.assertEqual(get_resp.data['folders'][0]['children'][0]['children'][0]['id'], 'ssf1')

        # A second PUT with an empty payload must fully clear the tree,
        # not merge with/leave behind the first PUT's state.
        resp2 = self.client.put('/api/v2/tree/', {'folders': [], 'assignments': {}, 'active': False}, format='json')
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(TreeFolder.objects.count(), 0)
        self.assertEqual(SiteAssignment.objects.count(), 0)


class UserAdminEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.superadmin = User.objects.create(username='root', role='superadmin')
        self.admin = User.objects.create(username='a4', role='admin')

    def test_admin_can_read_but_not_write_users(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get('/api/v2/users/').status_code, 200)
        resp = self.client.post('/api/v2/users/', {'username': 'x', 'password': 'x', 'role': 'viewer'}, format='json')
        self.assertEqual(resp.status_code, 403)

    def test_superadmin_create_sets_native_password_hash(self):
        # 2026-08-07: was 'hunter2' — a famously weak/common password that
        # AUTH_PASSWORD_VALIDATORS now actually rejects (see
        # UserWriteSerializer.validate()'s new validate_password() call,
        # added after the security audit found the validators were
        # configured but never enforced). This test is about hash FORMAT,
        # not password strength, so it just needs any password real
        # validators accept.
        self.client.force_authenticate(self.superadmin)
        resp = self.client.post('/api/v2/users/', {'username': 'newbie', 'password': 'Correct-Horse-Battery-9', 'role': 'viewer'}, format='json')
        self.assertEqual(resp.status_code, 201, resp.data)
        user = User.objects.get(username='newbie')
        self.assertTrue(user.check_password('Correct-Horse-Battery-9'))
        self.assertTrue(user.password.startswith('pbkdf2_sha256$'))  # Django's own hasher, not a Legacy* one

    def test_update_without_password_does_not_touch_hash(self):
        self.client.force_authenticate(self.superadmin)
        target = User.objects.create(username='edittarget', role='viewer')
        target.set_password('original')
        target.save()
        old_hash = target.password
        resp = self.client.patch(f'/api/v2/users/{target.id}/', {'name': 'New Name'}, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        target.refresh_from_db()
        self.assertEqual(target.password, old_hash)
        self.assertEqual(target.name, 'New Name')


class PermissionsMatrixEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.superadmin = User.objects.create(username='root2', role='superadmin')
        self.admin = User.objects.create(username='a5', role='admin')

    def test_superadmin_excluded_from_output(self):
        MenuPermission.objects.create(role='superadmin', menu_key='sites', action='read', allowed=True)
        MenuPermission.objects.create(role='viewer', menu_key='reports', action='read', allowed=True)
        self.client.force_authenticate(self.admin)
        resp = self.client.get('/api/v2/permissions-matrix/')
        self.assertNotIn('superadmin', resp.data)
        self.assertEqual(resp.data['viewer']['reports'], True)

    def test_admin_cannot_write_permissions(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.put('/api/v2/permissions-matrix/', {'viewer': {'reports': False}}, format='json')
        self.assertEqual(resp.status_code, 403)

    def test_superadmin_write_upserts_crud_and_simple_shapes(self):
        self.client.force_authenticate(self.superadmin)
        payload = {
            'admin': {
                'sites': {'read': True, 'write': True, 'update': True, 'delete': False},
                'reports': True,
            },
        }
        resp = self.client.put('/api/v2/permissions-matrix/', payload, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertTrue(MenuPermission.objects.filter(role='admin', menu_key='sites', action='write', allowed=True).exists())
        self.assertTrue(MenuPermission.objects.filter(role='admin', menu_key='sites', action='delete', allowed=False).exists())
        self.assertTrue(MenuPermission.objects.filter(role='admin', menu_key='reports', action='read', allowed=True).exists())


class SlaReportEndpointTests(TestCase):
    """Regression coverage for core/reports.py's site_sla_score() — the
    two things most likely to silently drift from v1's siteSlaScore():
    the weighted-average math, and treating a missing KPI as "not counted"
    rather than "counted as a fail"."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        # Meets every SLA_TARGETS threshold — should score 100.
        Site.objects.create(
            id='WDR900', name='Good Site', region='Western', kpi_entered=True,
            cell_avail=99, rrc=97, erab=97, call_drop=1.0, ip_thru_dl=15, prb_dl=60, intra_ho=95,
        )
        # Only cell_avail recorded (passing) — every other SLA_TARGETS
        # field is None, so the score must be computed from cell_avail's
        # weight alone (100%), not treated as failing the unset ones.
        Site.objects.create(id='WDR901', name='Partial Data Site', region='Western', kpi_entered=True, cell_avail=99)
        # Excluded from the report entirely — kpi_entered=False, matching
        # v1's `s.kpiEntered!==false` filter.
        Site.objects.create(id='WDR902', name='No KPI Site', region='Western', kpi_entered=False)

    def test_full_pass_site_scores_100_and_partial_data_site_scores_on_what_it_has(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/sla/')
        self.assertEqual(resp.status_code, 200)
        by_id = {s['id']: s for s in resp.data['sites']}
        self.assertEqual(by_id['WDR900']['score'], 100)
        self.assertEqual(by_id['WDR901']['score'], 100)
        self.assertNotIn('WDR902', by_id)
        self.assertEqual(resp.data['summary']['total'], 2)
        self.assertEqual(resp.data['summary']['compliant'], 2)

    def test_region_filter(self):
        self.client.force_authenticate(self.viewer)
        Site.objects.create(id='CDR900', name='Other Region', region='Central', kpi_entered=True, cell_avail=99)
        resp = self.client.get('/api/v2/sla/?region=Central')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([s['id'] for s in resp.data['sites']], ['CDR900'])


class NtaReportEndpointTests(TestCase):
    """Regression coverage for core/reports.py's nta_check()/nta_site_rows()
    — specifically the two behaviors most likely to get "fixed" by
    accident during a refactor: the warn band being a percentage of the
    limit (not a fixed offset), and how a missing KPI value is treated.

    That second one is subtle and was WRONG in an earlier version of this
    file: v1's `if(v===undefined)return{st:'pass'}` reads like "missing
    data auto-passes", but v1's real site objects always have every KPI
    key present (possibly `null`, never actually `undefined` — see
    nta_check()'s docstring), so that branch never fires in practice.
    What actually happens is JS coercing `null` to `0` in the comparison,
    which FAILS every `hi:true` KPI (needs >= a minimum) and PASSES every
    `hi:false` KPI (0 is always <= a positive maximum). This test locks
    in the corrected, verified-against-source behavior."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')

    def test_missing_data_fails_hi_type_kpis_passes_lo_type_kpis(self):
        # No fields set at all — every NTA_THRESHOLDS key is None.
        Site.objects.create(id='WDR900', name='No Data Site', region='Western')
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/nta/')
        self.assertEqual(resp.status_code, 200)
        row = next(s for s in resp.data['sites'] if s['id'] == 'WDR900')
        # rrc is hi:true (needs >= 95) -> None coerces to 0 -> fail.
        rrc_cell = next(c for c in row['cells'] if c['key'] == 'rrc')
        self.assertEqual(rrc_cell['status'], 'fail')
        # call_drop is hi:false (needs <= 2) -> None coerces to 0 -> pass.
        call_drop_cell = next(c for c in row['cells'] if c['key'] == 'call_drop')
        self.assertEqual(call_drop_cell['status'], 'pass')
        self.assertEqual(row['overall'], 'fail')
        self.assertEqual(resp.data['summary']['violation'], 1)

    def test_warn_band_is_percentage_of_limit(self):
        # rrc min=95, warn band is min*0.95=90.25. 91 -> warn, 89 -> fail.
        # Every other hi:true NTA_THRESHOLDS field must be set to a
        # comfortably-passing value here — since the nta_check() fix
        # above, an unset hi:true field no longer auto-passes, it fails
        # (None coerces to 0). Without setting these, both sites would
        # show 'fail' regardless of rrc, for the wrong reason (missing
        # erab/call_setup/etc, not the rrc value this test isolates).
        passing = dict(erab=99, call_setup=99, intra_ho=99, inter_ho=99, ip_thru=99, cell_avail=99)
        Site.objects.create(id='WDR901', name='Warn Site', region='Western', rrc=91, **passing)
        Site.objects.create(id='WDR902', name='Fail Site', region='Western', rrc=89, **passing)
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/nta/')
        by_id = {s['id']: s for s in resp.data['sites']}
        self.assertEqual(by_id['WDR901']['overall'], 'warn')
        self.assertEqual(by_id['WDR902']['overall'], 'fail')

    def test_violations_pane_excludes_passing_sites(self):
        # "All Pass" must set every hi:true NTA_THRESHOLDS field, not just
        # rrc — same reasoning as test_warn_band_is_percentage_of_limit
        # above (an unset hi:true field fails post-correction, it doesn't
        # auto-pass).
        Site.objects.create(
            id='WDR903', name='All Pass', region='Western',
            rrc=99, erab=99, call_setup=99, intra_ho=99, inter_ho=99, ip_thru=99, cell_avail=99,
            call_drop=0, svc_drop=0, ip_lat=0,
        )
        Site.objects.create(id='WDR904', name='Has Violation', region='Western', rrc=50)
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/nta/?pane=violations')
        ids = [s['id'] for s in resp.data['sites']]
        self.assertIn('WDR904', ids)
        self.assertNotIn('WDR903', ids)


class MonthlyReportEndpointTests(TestCase):
    """Regression coverage for core/reports.py's build_monthly_report() —
    focused on the two things most likely to silently break: a site with
    no KPI data at all landing in the worst/best-5 ranking (this used to
    crash v1's browser via a null `.toFixed()` call — see _fmt1()'s
    docstring) and the region filter."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')

    def test_no_data_site_does_not_crash_and_renders_dash(self):
        # No KPI fields set — must not raise, and worst/best formatting
        # must show "—" rather than attempting to format None.
        Site.objects.create(id='WDR900', name='No Data Site', region='Western', status='crit')
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/monthly-report/')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertIn('—', resp.data['markdown'])
        self.assertEqual(resp.data['meta']['site_count'], 1)

    def test_region_filter_and_empty_region_does_not_crash(self):
        Site.objects.create(id='WDR900', name='Western Site', region='Western', rrc=99, status='ok')
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/monthly-report/?region=Western')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data['meta']['site_count'], 1)
        # A region with zero sites (e.g. one only the sidebar tree knows
        # about) must return a "no sites found" report, not a 500 from
        # dividing by zero.
        resp2 = self.client.get('/api/v2/monthly-report/?region=NoSuchRegion')
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp2.data['meta']['site_count'], 0)

    def test_board_style_omits_worst_best_sections(self):
        Site.objects.create(id='WDR900', name='Site', region='Western', rrc=99, status='ok')
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/monthly-report/?style=board')
        self.assertNotIn('Worst Performing Sites', resp.data['markdown'])
        self.assertNotIn('Best Performing Sites', resp.data['markdown'])


class ScatterDataEndpointTests(TestCase):
    """core/reports.py's build_scatter_data() does no aggregation — this
    just confirms the endpoint is reachable, returns the 12-KPI list
    ported from v1's SCATTER_KPIS, and includes rssi/load (the fields
    task #38 added specifically for this report)."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        Site.objects.create(id='WDR900', name='Site', region='Western', rrc=97, rssi=-78, load=42)

    def test_returns_kpi_list_and_site_rows(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/scatter/')
        self.assertEqual(resp.status_code, 200)
        kpi_keys = [k['key'] for k in resp.data['kpis']]
        self.assertEqual(len(kpi_keys), 12)
        self.assertIn('rssi', kpi_keys)
        self.assertIn('load', kpi_keys)
        site = next(s for s in resp.data['sites'] if s['id'] == 'WDR900')
        self.assertEqual(site['rrc'], 97.0)
        self.assertEqual(site['rssi'], -78.0)
        self.assertEqual(site['load'], 42.0)
        self.assertIn('region_colors', resp.data)


class TakeKpiSnapshotCommandTests(TestCase):
    """Regression coverage for the daily job KPI Trend depends on — must
    be idempotent (safe to re-run same-day) and must actually copy the
    site's current KPI values, not just create an empty row."""

    def test_creates_one_snapshot_per_site_and_is_idempotent(self):
        from django.core.management import call_command
        Site.objects.create(id='WDR900', name='Site', region='Western', rrc=97.5, rssi=-78)
        call_command('take_kpi_snapshot')
        self.assertEqual(KpiSnapshot.objects.count(), 1)
        snap = KpiSnapshot.objects.get(site_id='WDR900')
        self.assertEqual(snap.rrc, 97.5)
        self.assertEqual(snap.rssi, -78)
        # Re-run same day — must update the existing row, not duplicate it.
        Site.objects.filter(id='WDR900').update(rrc=99.0)
        call_command('take_kpi_snapshot')
        self.assertEqual(KpiSnapshot.objects.count(), 1)
        self.assertEqual(KpiSnapshot.objects.get(site_id='WDR900').rrc, 99.0)

    def test_date_override_backfills_a_past_date(self):
        # --date exists purely so verification/testing doesn't require
        # waiting 3 real calendar days to clear MIN_SNAPSHOTS_FOR_TREND —
        # it still records the site's real current KPI values, just under
        # an earlier date.
        from django.core.management import call_command
        Site.objects.create(id='WDR900', name='Site', region='Western', rrc=95.0)
        call_command('take_kpi_snapshot', '--date=2026-07-01')
        snap = KpiSnapshot.objects.get(site_id='WDR900')
        self.assertEqual(str(snap.date), '2026-07-01')
        self.assertEqual(snap.rrc, 95.0)

    def test_bad_date_format_raises(self):
        from django.core.management import call_command
        from django.core.management.base import CommandError
        Site.objects.create(id='WDR900', name='Site', region='Western')
        with self.assertRaises(CommandError):
            call_command('take_kpi_snapshot', '--date=not-a-date')


class KpiTrendEndpointTests(TestCase):
    """Regression coverage for the "never fabricate data" decision
    (2026-07-28) — must report has_enough_data=False with an empty series
    below the 3-snapshot threshold, not synthesize a fallback trend the
    way v1's buildSimulatedHistory() does."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        self.site = Site.objects.create(id='WDR900', name='Site', region='Western')

    def test_missing_site_param_is_400(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/kpi-trend/')
        self.assertEqual(resp.status_code, 400)

    def test_unknown_site_is_404(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/kpi-trend/?site=DOES_NOT_EXIST')
        self.assertEqual(resp.status_code, 404)

    def test_fewer_than_3_snapshots_reports_not_enough_data(self):
        from datetime import date, timedelta
        for i in range(2):
            KpiSnapshot.objects.create(site=self.site, date=date.today() - timedelta(days=i), rrc=95)
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/kpi-trend/?site={self.site.id}')
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data['has_enough_data'])
        self.assertEqual(resp.data['series'], [])
        self.assertEqual(resp.data['snapshot_count'], 2)

    def test_3_or_more_snapshots_returns_real_series(self):
        from datetime import date, timedelta
        for i in range(5):
            KpiSnapshot.objects.create(site=self.site, date=date.today() - timedelta(days=i), rrc=95 + i)
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/kpi-trend/?site={self.site.id}&days=30')
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.data['has_enough_data'])
        self.assertEqual(len(resp.data['series']), 5)
        self.assertIn('overview', resp.data['categories'])

    def test_days_filter_excludes_older_snapshots(self):
        from datetime import date, timedelta
        KpiSnapshot.objects.create(site=self.site, date=date.today() - timedelta(days=1), rrc=90)
        KpiSnapshot.objects.create(site=self.site, date=date.today() - timedelta(days=2), rrc=91)
        KpiSnapshot.objects.create(site=self.site, date=date.today() - timedelta(days=100), rrc=50)
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/kpi-trend/?site={self.site.id}&days=7')
        self.assertEqual(resp.data['snapshot_count'], 2)


class RfAuditDataEndpointTests(TestCase):
    """core/rf_audit.py's RfAuditDataView — read-only, any authenticated
    role (matches v1: the audit tool's data views have no separate gate,
    only *saving* a report does — see AuditHistoryEndpointTests below)."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')

    def test_missing_site_param_is_400(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/rf-audit/data/')
        self.assertEqual(resp.status_code, 400)

    def test_unknown_site_is_404(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get('/api/v2/rf-audit/data/?site=DOES_NOT_EXIST')
        self.assertEqual(resp.status_code, 404)

    def test_kpi_findings_flag_critical_and_warning_bands(self):
        # rrc=88 is below crit(90) -> CRITICAL. call_drop=3 is above
        # ok(2) but not above crit(4) -> MAJOR/warning. cell_avail=99 is
        # comfortably passing -> no finding at all.
        site = Site.objects.create(
            id='WDR900', name='Site', region='Western',
            rrc=88, call_drop=3, cell_avail=99,
        )
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/rf-audit/data/?site={site.id}')
        self.assertEqual(resp.status_code, 200)
        findings_by_title = {f['title']: f for f in resp.data['kpi_findings']}
        self.assertEqual(findings_by_title['Low RRC Setup SR']['sev'], 'CRITICAL')
        self.assertEqual(findings_by_title['High Call Drop Rate']['sev'], 'MAJOR')
        self.assertNotIn('Low Cell Availability', findings_by_title)
        # score = 100 - 1*18 (rrc crit) - 1*8 (call_drop warn) = 74
        self.assertEqual(resp.data['kpi_score'], 74)

    def test_missing_kpi_value_produces_no_finding(self):
        # None must never coerce into a fake pass or fail — it's simply
        # excluded, same as v1's `if(ck.v===undefined||ck.v===null)return`.
        site = Site.objects.create(id='WDR900', name='Site', region='Western')
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/rf-audit/data/?site={site.id}')
        self.assertEqual(resp.data['kpi_findings'], [])
        self.assertEqual(resp.data['kpi_score'], 100)

    def test_sector_uses_real_kpi_json_when_present_else_site_fallback(self):
        # This is the "no Math.random() fabrication" fix (task #37): a
        # sector with its own kpi_json.rrc reports that real value and
        # source='sector'; a sector with no rrc entry falls back to the
        # site's own real rrc, source='site' — never an invented number.
        site = Site.objects.create(id='WDR900', name='Site', region='Western', rrc=95, call_drop=1.5)
        Sector.objects.create(site=site, cell_name='WDR900_A', sector='A', kpi_json={'rrc': 91.2})
        Sector.objects.create(site=site, cell_name='WDR900_B', sector='B', kpi_json={})
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f'/api/v2/rf-audit/data/?site={site.id}')
        rows = {r['cell_name']: r for r in resp.data['sectors']}
        self.assertEqual(rows['WDR900_A']['values']['rrc'], {'value': 91.2, 'source': 'sector'})
        self.assertEqual(rows['WDR900_B']['values']['rrc'], {'value': 95.0, 'source': 'site'})
        self.assertEqual(rows['WDR900_B']['values']['call_drop'], {'value': 1.5, 'source': 'site'})


class AuditHistoryEndpointTests(TestCase):
    """core/rf_audit.py's AuditHistoryListView/AuditHistoryDetailView —
    matches v1's /audit-history gating exactly: superadmin/admin only for
    both read and write (bagalewatch_api.py, roles=('superadmin','admin')
    on GET and POST alike) — a viewer never sees saved audit reports."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        self.admin = User.objects.create(username='a1', role='admin')
        self.site = Site.objects.create(id='WDR900', name='Some Site', region='Western')

    def test_viewer_forbidden_on_read_and_write(self):
        self.client.force_authenticate(self.viewer)
        self.assertEqual(self.client.get('/api/v2/rf-audit/history/').status_code, 403)
        self.assertEqual(
            self.client.post('/api/v2/rf-audit/history/', {'site': self.site.id, 'content': 'x'}).status_code,
            403,
        )

    def test_admin_can_save_and_list_audit_report(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.post('/api/v2/rf-audit/history/', {
            'site': self.site.id, 'content': '# RF SITE AUDIT REPORT\n...', 'score': 82,
        }, format='json')
        self.assertEqual(resp.status_code, 201)
        entry = AuditHistory.objects.get()
        self.assertEqual(entry.site_id, self.site.id)
        self.assertEqual(entry.site_name, 'Some Site')  # snapshotted from the live site at save time
        self.assertEqual(entry.score, 82)
        self.assertEqual(entry.created_by, self.admin)

        listing = self.client.get('/api/v2/rf-audit/history/')
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.data), 1)
        self.assertEqual(listing.data[0]['site_name'], 'Some Site')
        self.assertEqual(listing.data[0]['created_by_name'], self.admin.username)

    def test_site_name_survives_site_deletion(self):
        # The whole reason site_name is denormalized rather than relying
        # on site.name via the FK — a saved report must stay readable
        # after the site it was taken against is removed from the tree.
        entry = AuditHistory.objects.create(site=self.site, site_name='Some Site', content='x', score=50)
        self.site.delete()
        entry.refresh_from_db()
        self.assertIsNone(entry.site_id)
        self.assertEqual(entry.site_name, 'Some Site')
        self.assertEqual(entry.content, 'x')

    def test_list_can_filter_by_site_and_is_newest_first(self):
        other = Site.objects.create(id='WDR901', name='Other', region='Western')
        e1 = AuditHistory.objects.create(site=self.site, site_name='Some Site', content='first')
        e2 = AuditHistory.objects.create(site=self.site, site_name='Some Site', content='second')
        AuditHistory.objects.create(site=other, site_name='Other', content='unrelated')
        self.client.force_authenticate(self.admin)
        resp = self.client.get(f'/api/v2/rf-audit/history/?site={self.site.id}')
        self.assertEqual([r['id'] for r in resp.data], [e2.id, e1.id])

    def test_admin_can_delete_saved_audit(self):
        entry = AuditHistory.objects.create(site=self.site, site_name='Some Site', content='x')
        self.client.force_authenticate(self.admin)
        resp = self.client.delete(f'/api/v2/rf-audit/history/{entry.id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(AuditHistory.objects.filter(id=entry.id).exists())

    def test_delete_unknown_id_is_404(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.delete('/api/v2/rf-audit/history/999999/')
        self.assertEqual(resp.status_code, 404)


class DriveTestSessionEndpointTests(TestCase):
    """core/drive_test.py's DriveTestSessionViewSet — Phase 4a. Read: any
    authenticated role. Write (create/destroy): admin+ only, matching
    v1's `_require_auth(roles=('superadmin','admin'))` on POST/DELETE of
    `/dt-sessions` (bagalewatch_api.py) exactly — GET has no role
    restriction in v1 either, just `_require_auth(conn, headers)`."""

    def setUp(self):
        self.client = APIClient()
        self.viewer = User.objects.create(username='v1', role='viewer')
        self.admin = User.objects.create(username='a1', role='admin')
        self.sample_payload = {
            'name': 'DT_trp_20260728_Kathmandu_4G',
            'tech': '4G',
            'date': '2026-07-28',
            'uploaded_date': '2026-07-28',
            'meta': {'gpsCount': 2, 'fileNames': ['route1.trp'], 'avgRsrp': -92.5},
            'samples': [
                {'ts': '2026-07-28T10:00:00', 'date': '2026-07-28', 'lat': 27.7, 'lng': 85.3, 'rsrp': -90, 'rsrq': -10, 'sinr': 12, 'pci': 101},
                {'ts': '2026-07-28T10:00:05', 'date': '2026-07-28', 'lat': 27.71, 'lng': 85.31, 'rsrp': -95, 'rsrq': -12, 'sinr': 8, 'pci': 101, 'cell_role': 'neighbor'},
            ],
        }

    def test_viewer_can_list_and_retrieve_but_not_write(self):
        self.client.force_authenticate(self.admin)
        create_resp = self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json')
        self.assertEqual(create_resp.status_code, 201)
        session_id = create_resp.data['id']

        self.client.force_authenticate(self.viewer)
        self.assertEqual(self.client.get('/api/v2/dt-sessions/').status_code, 200)
        self.assertEqual(self.client.get(f'/api/v2/dt-sessions/{session_id}/').status_code, 200)
        self.assertEqual(self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json').status_code, 403)
        self.assertEqual(self.client.delete(f'/api/v2/dt-sessions/{session_id}/').status_code, 403)

    def test_admin_create_persists_session_and_samples(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json')
        self.assertEqual(resp.status_code, 201)
        session = DriveTestSession.objects.get(id=resp.data['id'])
        self.assertEqual(session.name, 'DT_trp_20260728_Kathmandu_4G')
        self.assertEqual(session.uploaded_by, self.admin)
        self.assertEqual(DriveTestSample.objects.filter(session=session).count(), 2)
        neighbor = DriveTestSample.objects.get(session=session, cell_role='neighbor')
        self.assertEqual(neighbor.rsrp, -95)
        self.assertEqual(neighbor.pci, 101)
        # meta is stored as-is (JSONField), matching v1's meta_json blob.
        self.assertEqual(session.meta['avgRsrp'], -92.5)
        # size_bytes is computed server-side (not present in the request
        # payload at all — this test never sends one) and must be a real
        # positive number, not null.
        self.assertIsNotNone(session.size_bytes)
        self.assertGreater(session.size_bytes, 0)

    def test_list_returns_metadata_only_no_samples_key(self):
        self.client.force_authenticate(self.admin)
        self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json')
        resp = self.client.get('/api/v2/dt-sessions/')
        self.assertEqual(resp.status_code, 200)
        row = resp.data[0]
        self.assertNotIn('samples', row)
        self.assertEqual(row['sample_count'], 2)
        self.assertEqual(row['uploaded_by_name'], 'a1')

    def test_retrieve_includes_full_samples(self):
        self.client.force_authenticate(self.admin)
        create_resp = self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json')
        session_id = create_resp.data['id']
        resp = self.client.get(f'/api/v2/dt-sessions/{session_id}/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data['samples']), 2)
        self.assertEqual(resp.data['samples'][0]['rsrp'], -90)

    def test_admin_delete_cascades_samples(self):
        self.client.force_authenticate(self.admin)
        create_resp = self.client.post('/api/v2/dt-sessions/', self.sample_payload, format='json')
        session_id = create_resp.data['id']
        resp = self.client.delete(f'/api/v2/dt-sessions/{session_id}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(DriveTestSession.objects.filter(id=session_id).exists())
        self.assertEqual(DriveTestSample.objects.filter(session_id=session_id).count(), 0)

    def test_create_with_no_samples_is_allowed(self):
        # An empty/degenerate upload shouldn't 500 — matches v1's
        # `saveDtSession` returning null for zero valid records rather
        # than crashing; the equivalent server-side guard here is just
        # "don't blow up," the "were there any valid GPS records at all"
        # check itself stays client-side same as v1 (see model docstring).
        self.client.force_authenticate(self.admin)
        payload = {**self.sample_payload, 'samples': []}
        resp = self.client.post('/api/v2/dt-sessions/', payload, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(DriveTestSample.objects.filter(session_id=resp.data['id']).count(), 0)


class IdleTimeoutConfigTests(TestCase):
    """The inactivity auto-logout is server-configured (2026-08-23,
    "autologout time should be configurable") so it can be changed with an
    .env edit and a backend restart instead of a frontend rebuild. It reaches
    the SPA on the public /branding/ payload, because AuthProvider owns the
    idle timer and needs the value before any authenticated request happens.
    """

    def test_branding_reports_the_configured_timeout(self):
        with override_settings(IDLE_TIMEOUT_MINUTES=15):
            body = self.client.get('/api/v2/branding/').json()
        self.assertEqual(body['idle_timeout_minutes'], 15)

    def test_zero_is_passed_through_as_disabled(self):
        """0 means "never auto-logout" and must survive as 0 rather than being
        treated as falsy and replaced by the default."""
        with override_settings(IDLE_TIMEOUT_MINUTES=0):
            body = self.client.get('/api/v2/branding/').json()
        self.assertEqual(body['idle_timeout_minutes'], 0)

    def test_value_is_public(self):
        """Unauthenticated: the login page fetches this payload before any
        token exists, and a UX timer is not sensitive."""
        resp = self.client.get('/api/v2/branding/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn('idle_timeout_minutes', resp.json())

    def test_env_parsing_falls_back_instead_of_raising(self):
        """A typo in the env var must not stop the backend booting — this is a
        UX preference, not a security control."""
        from dtwatch.settings import _idle_timeout_minutes

        for raw, expected in (
            ('', 5),         # unset
            ('   ', 5),      # whitespace only
            ('abc', 5),      # not a number
            ('-3', 5),       # negative is meaningless
            ('0', 0),        # explicit "never"
            ('30', 30),      # ordinary value
        ):
            with mock.patch.dict(os.environ, {'IDLE_TIMEOUT_MINUTES': raw}):
                self.assertEqual(_idle_timeout_minutes(), expected, f'raw={raw!r}')
