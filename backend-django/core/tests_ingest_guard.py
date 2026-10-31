"""Screening of phone readings on arrival (2026-10-29, core/ingest_guard.py)."""
import json
import time
import uuid

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .models import TelemetryIngestKey, TelemetrySample
from .telemetry import generate_ingest_key, hash_device_id
from .tests_telemetry import _sample


class IngestGuardTests(TestCase):
    def setUp(self):
        full, prefix, key_hash = generate_ingest_key()
        TelemetryIngestKey.objects.create(name='pilot', key_prefix=prefix, key_hash=key_hash, rate_limit_per_min=1000)
        self.key = full
        self.client = APIClient()
        # The cap and the last position live in the shared cache: a fresh phone id per test.
        self.dev = f'guard-{uuid.uuid4().hex[:10]}'

    def _post(self, body):
        return self.client.post('/api/telemetry/v1/samples/', data=json.dumps(body), content_type='application/json',
                                HTTP_AUTHORIZATION=f'Bearer {self.key}')

    def _flags(self):
        return list(TelemetrySample.objects.filter(device_id=hash_device_id(self.dev))
                    .order_by('ts').values_list('flag', 'signed'))

    def test_jump_and_burst_are_flagged_normal_is_not(self):
        t = int(time.time() * 1000) - 600_000
        self._post([
            _sample(self.dev, ts_ms=t, lat=27.70, lon=85.30),
            _sample(self.dev, ts_ms=t + 60_000, lat=27.701, lon=85.301),     # 150 m in a minute: normal
            _sample(self.dev, ts_ms=t + 120_000, lat=28.20, lon=83.98),      # Pokhara a minute later: jump
            _sample(self.dev, ts_ms=t + 120_400, lat=28.20, lon=83.98),      # 0.4 s later: burst
        ])
        self.assertEqual(self._flags(), [('', False), ('', False), ('jump', False), ('burst', False)])

    @override_settings(TELEMETRY_DEVICE_DAILY_CAP=3)
    def test_daily_cap_drops_the_excess(self):
        t = int(time.time() * 1000) - 600_000
        r = self._post([_sample(self.dev, ts_ms=t + i * 30_000) for i in range(5)])
        self.assertEqual((r.json()['accepted'], r.json()['dropped']), (3, 2))
        r = self._post([_sample(self.dev, ts_ms=t + 200_000)])
        self.assertEqual(r.status_code, 429)
        self.assertEqual(len(self._flags()), 3)

    def test_two_sims_read_together_are_not_a_burst(self):
        t = int(time.time() * 1000) - 600_000
        self._post([dict(_sample(self.dev, ts_ms=t), sim_slot=1),
                    dict(_sample(self.dev, ts_ms=t + 100), sim_slot=2),
                    dict(_sample(self.dev, ts_ms=t + 200), sim_slot=2)])
        rows = list(TelemetrySample.objects.filter(device_id=hash_device_id(self.dev))
                    .order_by('ts').values_list('sim_slot', 'flag'))
        self.assertEqual(rows, [(1, ''), (2, ''), (2, 'burst')])

    def test_spot_marked_by_hand_is_kept(self):
        t = int(time.time() * 1000) - 600_000
        self._post([dict(_sample(self.dev, ts_ms=t), position_source='manual'),
                    dict(_sample(self.dev, ts_ms=t + 60_000), position_source='bogus')])
        rows = list(TelemetrySample.objects.filter(device_id=hash_device_id(self.dev))
                    .order_by('ts').values_list('position_source', flat=True))
        self.assertEqual(rows, ['manual', None])
