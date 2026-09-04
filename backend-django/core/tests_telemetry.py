"""Tests for the crowdsourced-telemetry ingestion pipeline
(core/telemetry.py + models + retention command). The upload body shape
mirrors the provided netplanning-telemetry-sdk's Sample.kt exactly."""
import json

from django.core.management import call_command
from django.test import TestCase
from datetime import datetime, timezone as dt_timezone

from django.utils import timezone
from rest_framework.test import APIClient

from core.models import (
    TelemetryBatch,
    TelemetryCoverageBin,
    TelemetryIngestKey,
    TelemetrySample,
)
from core.telemetry import generate_ingest_key, geohash_encode, hash_device_id


def _sample(device_id='dev-a', ts_ms=None, lat=27.7, lon=85.3, nt='LTE', rsrp=-95, **kw):
    if ts_ms is None:
        ts_ms = int(timezone.now().timestamp() * 1000)
    s = {
        'device_id': device_id, 'ts': ts_ms,
        'lat': lat, 'lon': lon, 'gps_accuracy_m': 12.5,
        'cell_id': 123456789, 'pci': 301, 'tac': 4102,
        'mcc': '429', 'mnc': '01', 'network_type': nt,
        'rsrp_dbm': rsrp, 'rsrq_db': -11, 'rssi_dbm': -70, 'sinr_db': 8,
        'battery_pct': 77, 'trigger_reason': 'periodic',
    }
    s.update(kw)
    return s


class TelemetryIngestTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        full, prefix, key_hash = generate_ingest_key()
        self.full_key = full
        self.key = TelemetryIngestKey.objects.create(
            name='pilot', key_prefix=prefix, key_hash=key_hash, rate_limit_per_min=1000,
        )

    def _post(self, body, key=None, header='bearer'):
        kwargs = {}
        k = key if key is not None else self.full_key
        if k:
            if header == 'bearer':
                kwargs['HTTP_AUTHORIZATION'] = f'Bearer {k}'
            else:
                kwargs['HTTP_X_API_KEY'] = k
        return self.client.post('/api/telemetry/v1/samples/', data=json.dumps(body),
                                content_type='application/json', **kwargs)

    def test_health_is_open(self):
        r = self.client.get('/api/telemetry/v1/health/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['status'], 'ok')

    def test_accepts_batch_and_stores_samples(self):
        r = self._post([_sample('dev-a'), _sample('dev-b', rsrp=-80)])
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()['accepted'], 2)
        self.assertEqual(TelemetrySample.objects.count(), 2)
        s = TelemetrySample.objects.get(device_id=hash_device_id('dev-a'))
        self.assertEqual(s.network_type, 'LTE')
        self.assertEqual(s.rsrp_dbm, -95)
        self.assertEqual(s.lng, 85.3)          # SDK's `lon` -> `lng`
        self.assertIsNotNone(s.location)        # set inline by the COPY writer
        self.assertEqual(TelemetryBatch.objects.count(), 1)

    def test_device_id_is_stored_only_as_a_salted_hash(self):
        # A misconfigured client sends an MSISDN where the SDK would send
        # its pseudonymous UUID — the store must not end up with it.
        msisdn = '9779812345678'
        self._post([_sample(device_id=msisdn)])
        stored = TelemetrySample.objects.get().device_id
        self.assertNotEqual(stored, msisdn)
        self.assertNotIn(msisdn, stored)
        self.assertEqual(stored, hash_device_id(msisdn))
        self.assertEqual(len(stored), 32)

    def test_x_api_key_header_also_works(self):
        r = self._post([_sample()], header='xkey')
        self.assertEqual(r.status_code, 202, r.content)

    def test_duplicate_batch_is_a_noop(self):
        body = [_sample('dev-a', ts_ms=1_756_000_000_000), _sample('dev-a', ts_ms=1_756_000_002_000)]
        r1 = self._post(body)
        r2 = self._post(body)  # SDK retry: identical batch
        self.assertEqual(r1.status_code, 202)
        self.assertEqual(r2.status_code, 200)
        self.assertTrue(r2.json()['duplicate'])
        self.assertEqual(TelemetrySample.objects.count(), 2)   # not 4
        self.assertEqual(TelemetryBatch.objects.count(), 1)

    def test_bad_or_missing_key_is_401(self):
        self.assertEqual(self._post([_sample()], key='').status_code, 401)
        self.assertEqual(self._post([_sample()], key='tel_deadbeefdeadbeef').status_code, 401)

    def test_revoked_key_is_401(self):
        self.key.is_active = False
        self.key.save(update_fields=['is_active'])
        self.assertEqual(self._post([_sample()]).status_code, 401)

    def test_body_must_be_a_list(self):
        self.assertEqual(self._post({'device_id': 'x'}).status_code, 400)

    def test_oversize_batch_is_413(self):
        r = self._post([_sample(f'd{i}') for i in range(2001)])
        self.assertEqual(r.status_code, 413)

    def test_missing_device_id_rejects_batch(self):
        bad = _sample()
        del bad['device_id']
        self.assertEqual(self._post([bad]).status_code, 400)

    def test_rate_limit(self):
        self.key.rate_limit_per_min = 2
        self.key.save(update_fields=['rate_limit_per_min'])
        self.assertEqual(self._post([_sample(ts_ms=1)]).status_code, 202)
        self.assertEqual(self._post([_sample(ts_ms=2)]).status_code, 202)
        self.assertEqual(self._post([_sample(ts_ms=3)]).status_code, 429)

    def test_null_signal_fields_survive_as_null_not_zero(self):
        s = _sample()
        s['sinr_db'] = None
        self._post([s])
        self.assertIsNone(TelemetrySample.objects.get().sinr_db)


class TelemetryRetentionTests(TestCase):
    def test_prune_aggregates_then_drops_expired_partition(self):
        from django.db import connection

        # A partition well in the past, and a row in it.
        with connection.cursor() as c:
            c.execute("SELECT telemetry_ensure_partition('2024-01-01')")
        old_ts = datetime(2024, 1, 15, tzinfo=dt_timezone.utc)
        for i in range(5):
            TelemetrySample.objects.create(
                device_id=f'd{i % 2}', ts=old_ts, received_at=old_ts,
                lat=27.7001, lng=85.3001, network_type='LTE',
                rsrp_dbm=-90 - i, rsrq_db=-10, sinr_db=7,
            )
        self.assertEqual(TelemetrySample.objects.count(), 5)

        call_command('prune_telemetry', '--older-than-days', '30')

        # partition gone, rows gone, one coverage bin written
        with connection.cursor() as c:
            c.execute("SELECT to_regclass('v2_telemetry_samples_202401')")
            self.assertIsNone(c.fetchone()[0])
        self.assertEqual(TelemetrySample.objects.count(), 0)
        b = TelemetryCoverageBin.objects.get(network_type='LTE')
        self.assertEqual(b.sample_count, 5)
        self.assertEqual(b.device_count, 2)
        self.assertLess(b.rsrp_mean, -89)
        self.assertEqual(b.geohash, geohash_encode(27.7001, 85.3001, 7))

    def test_prune_keeps_current_partition(self):
        TelemetrySample.objects.create(
            device_id='now', ts=timezone.now(), received_at=timezone.now(),
            lat=27.7, lng=85.3, network_type='LTE', rsrp_dbm=-88,
        )
        call_command('prune_telemetry', '--older-than-days', '1')
        self.assertEqual(TelemetrySample.objects.count(), 1)
