"""Radio values for the predicted coverage (2026-10-28, core/coverage_prediction.py)."""
from django.test import TestCase
from rest_framework.test import APIClient

from .coverage_prediction import BANDS
from .models import CoveragePredictionSettings, User

URL = '/api/v2/coverage-prediction/settings/'


class PredictionSettingsTests(TestCase):
    def setUp(self):
        self.viewer = User.objects.create_user(username='pred_viewer', password='x-Audit-12345!', role='viewer')
        self.admin = User.objects.create_user(username='pred_admin', password='x-Audit-12345!', role='admin')
        self.c = APIClient()

    def test_defaults_for_any_signed_in_user(self):
        self.c.force_authenticate(self.viewer)
        r = self.c.get(URL)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.data['is_default'])
        self.assertEqual(r.data['bands']['lte_b3']['power_dbm'], BANDS['lte_b3']['power_dbm'])
        self.assertEqual(r.data['environment'], 'suburban')

    def test_viewer_cannot_change(self):
        self.c.force_authenticate(self.viewer)
        self.assertEqual(self.c.put(URL, {'offset_db': 3}, format='json').status_code, 403)

    def test_admin_changes_one_value_and_resets(self):
        self.c.force_authenticate(self.admin)
        r = self.c.put(URL, {'bands': {'lte_b3': {'power_dbm': 12.2}}, 'offset_db': -4.5}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['bands']['lte_b3']['power_dbm'], 12.2)
        self.assertEqual(r.data['bands']['lte_b3']['changed'], ['power_dbm'])
        self.assertEqual(r.data['bands']['lte_b20']['changed'], [])
        self.assertEqual(r.data['offset_db'], -4.5)
        self.assertFalse(r.data['is_default'])
        self.assertEqual(CoveragePredictionSettings.load().bands, {'lte_b3': {'power_dbm': 12.2}})
        # Setting it back to the starting value stores nothing for the band.
        r = self.c.put(URL, {'bands': {'lte_b3': {'power_dbm': BANDS['lte_b3']['power_dbm']}}}, format='json')
        self.assertEqual(CoveragePredictionSettings.load().bands, {})
        r = self.c.put(URL, {'reset': True}, format='json')
        self.assertTrue(r.data['is_default'])

    def test_refuses_bad_values(self):
        self.c.force_authenticate(self.admin)
        self.assertEqual(self.c.put(URL, {'bands': {'lte_b3': {'gain_dbi': 99}}}, format='json').status_code, 400)
        self.assertEqual(self.c.put(URL, {'bands': {'nr_n78': {'gain_dbi': 15}}}, format='json').status_code, 400)
        self.assertEqual(self.c.put(URL, {'environment': 'jungle'}, format='json').status_code, 400)
        self.assertEqual(self.c.put(URL, {'offset_db': 'x'}, format='json').status_code, 400)
        self.assertIsNone(CoveragePredictionSettings.load())
