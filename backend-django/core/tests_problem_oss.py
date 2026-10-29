"""OSS diagnostics (KPI) of a complaint (core/problem_oss.py)."""
from datetime import datetime
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .cell_kpi import store
from .models import ProblemReport, Sector, Site
from .tests_cell_kpi import export_row

NPT = ZoneInfo('Asia/Kathmandu')


class ProblemOssKpiTests(TestCase):
    def setUp(self):
        busy = Site.objects.create(id='FWDR444', name='Jogbudha height', lat=29.10, lng=80.40)
        Site.objects.create(id='FWDR445', name='Near', lat=29.105, lng=80.405)
        Site.objects.create(id='FWDR900', name='Far away', lat=29.50, lng=80.90)
        Sector.objects.create(site=busy, cell_name='FWDR444_Jogbudha height-J3', sector='J3', tech='4G', local_cell_id=1)
        store([export_row('FWDR444_Jogbudha height-J3', 1, 95.0)], 'demo')
        self.report = ProblemReport.objects.create(
            source='staff', category='slow_data', lat=29.101, lng=80.401, site_id='FWDR444',
            happened_at=datetime(2026, 10, 22, 20, 15, tzinfo=NPT))
        User = get_user_model()
        self.admin = User.objects.create_user('oss_admin', password='x', role='admin')
        self.viewer = User.objects.create_user('oss_viewer', password='x', role='viewer')

    def _get(self, user, **params):
        c = APIClient()
        c.force_authenticate(user)
        return c.get(f'/api/v2/problem-reports/{self.report.pk}/oss-kpi/', params)

    def test_complaint_site_first_with_its_load(self):
        resp = self._get(self.admin, radius_km=3)
        self.assertEqual(resp.status_code, 200)
        sites = resp.json()['sites']
        self.assertEqual([s['site_id'] for s in sites], ['FWDR444', 'FWDR445'])
        first = sites[0]
        self.assertEqual(first['roles'], ['complaint', 'nearby'])
        self.assertEqual(first['verdict'], 'busy')
        self.assertEqual(first['at_problem']['prb_dl'], 95.0)
        self.assertEqual(first['week']['busy_days'], 1)
        self.assertEqual(sites[1]['verdict'], 'none')

    def test_newest_figures_when_the_week_has_none(self):
        self.report.happened_at = datetime(2026, 11, 20, 10, tzinfo=NPT)
        self.report.save()
        first = self._get(self.admin).json()['sites'][0]
        self.assertEqual(first['figures_from'], '2026-10-22')
        self.assertIn('22 Oct', first['verdict_text'])

    def test_viewer_refused(self):
        self.assertEqual(self._get(self.viewer).status_code, 403)
