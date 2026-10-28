"""Calls from phones in analysis (core/call_cells.py, 2026-10-27)."""
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from .call_cells import call_findings, name_calls, sector_calls
from .models import CallContextSample, Sector, Site


def _finding(kind, title, cause, action, evidence):
    return {'kind': kind, 'title': title, 'cause': cause, 'action': action, 'evidence': evidence}


class CallCellsTests(TestCase):
    def setUp(self):
        site = Site.objects.create(id='CDR001', name='CDR001_TEST', lat=27.70, lng=85.30)
        Sector.objects.create(site=site, cell_name='CDR001_J3', sector='J3', pci=116)
        self.now = timezone.now()

    def _call(self, outcome='volte', level=-80, end_level=-75, minutes=0, device='d1'):
        t = self.now + timedelta(minutes=minutes)
        return CallContextSample.objects.create(
            device_id=device, started_at=t, ended_at=t + timedelta(seconds=60), received_at=t, duration_s=60,
            outcome=outcome, network_type='LTE', pci=116, lat=27.701, lng=85.301, level_dbm=level,
            end_network_type='UMTS' if outcome == 'fallback' else 'LTE', end_level_dbm=end_level)

    def test_names_the_start_cell(self):
        c = self._call()
        self.assertEqual(name_calls([c]), [('CDR001 J3', None)])

    def test_calls_per_sector(self):
        self._call()
        self._call(outcome='fallback', minutes=5)
        per, unplaced = sector_calls(['d1'])
        self.assertEqual((per[('CDR001', 'J3')], unplaced), ({'calls': 2, 'fallback': 1}, 0))

    def test_findings_from_calls_near_the_problem(self):
        self._call(outcome='fallback', end_level=-100, minutes=10)
        self._call(end_level=-115, minutes=20)
        self._call(minutes=-60 * 10)   # outside the window
        found, n = call_findings({'d1'}, self.now, _finding)
        self.assertEqual(n, 2)
        self.assertEqual([f['kind'] for f in found], ['call_fallback', 'call_weak_end'])
        self.assertIn('CDR001 J3', found[0]['action'])

    def test_no_calls_no_findings(self):
        self.assertEqual(call_findings({'nobody'}, self.now, _finding), ([], 0))
