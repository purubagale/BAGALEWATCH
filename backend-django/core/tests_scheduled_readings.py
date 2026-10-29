"""'Help improve NTC's network' readings (2026-10-29, core/scheduled_readings.py)."""
import time
import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import ScheduledReading, TelemetryIngestKey
from .telemetry import generate_ingest_key

URL = '/api/telemetry/v1/scheduled-readings/'


class ScheduledReadingTests(TestCase):
    def setUp(self):
        full, prefix, key_hash = generate_ingest_key()
        TelemetryIngestKey.objects.create(name='pilot', key_prefix=prefix, key_hash=key_hash, rate_limit_per_min=1000)
        self.key = full
        self.client = APIClient()
        self.anon = uuid.uuid4().hex   # the daily counter lives in the shared cache

    def _send(self, **extra):
        body = {'anon_id': self.anon, 'ts': int(time.time() * 1000), 'slot': 19, 'network_type': 'LTE',
                'level_dbm': -112, 'band': 'B3 (1800)', **extra}
        return self.client.post(URL, body, format='json', HTTP_AUTHORIZATION=f'Bearer {self.key}')

    def test_stored_without_any_identity(self):
        self.assertEqual(self._send().status_code, 201)
        r = ScheduledReading.objects.get()
        self.assertEqual((r.slot, r.network_type, r.level_dbm), (19, 'LTE', -112))
        self.assertNotEqual(r.anon_hash, self.anon)
        self.assertFalse(any(f.name in ('device_id', 'lat', 'lng', 'msisdn') for f in ScheduledReading._meta.fields))

    def test_key_needed_and_signed_calls_refused(self):
        self.assertEqual(self.client.post(URL, {'anon_id': 'x', 'network_type': 'LTE'}, format='json').status_code, 401)
        resp = self.client.post(URL, {'anon_id': 'x', 'network_type': 'LTE'}, format='json', HTTP_X_SIGNATURE='abc')
        self.assertEqual(resp.status_code, 400)

    def test_daily_limit_and_summary(self):
        for _ in range(8):
            self.assertEqual(self._send().status_code, 201)
        self.assertEqual(self._send().status_code, 429)
        admin = get_user_model().objects.create_user('sched_admin', password='x', role='admin')
        c = APIClient()
        c.force_authenticate(admin)
        d = c.get('/api/v2/telemetry/scheduled-readings/?days=7').json()
        self.assertEqual((d['readings'], d['phones']), (8, 1))
        evening = next(s for s in d['slots'] if s['slot'] == 19)
        self.assertEqual(evening['techs']['4G']['weak'], 8)

    def test_area_rounded_to_the_square_and_on_the_map(self):
        self._send(area_lat=27.70123, area_lng=85.32456)
        self._send(area_lat=48.0, area_lng=2.3)          # outside Nepal: dropped
        rows = list(ScheduledReading.objects.order_by('id').values_list('area_lat', 'area_lng'))
        self.assertEqual(rows, [(27.7025, 85.3225), (None, None)])
        admin = get_user_model().objects.create_user('sched_map', password='x', role='admin')
        c = APIClient()
        c.force_authenticate(admin)
        d = c.get('/api/v2/telemetry/scheduled-readings/map/?days=7&slot=19&tech=4G').json()
        self.assertEqual(d['squares'], [{'lat': 27.7025, 'lng': 85.3225, 'readings': 1, 'weak_pct': 100, 'level_avg': -112.0}])
        self.assertEqual(c.get('/api/v2/telemetry/scheduled-readings/map/?slot=10').json()['squares'], [])
