"""Neighbour cells sent with phone readings (core/neighbour_cells.py, 2026-10-27)."""
import json

from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from . import neighbour_cells
from .models import Sector, Site, TelemetryIngestKey, TelemetrySample
from .telemetry import generate_ingest_key


class CoerceTests(SimpleTestCase):
    def test_keeps_known_keys_and_drops_bad_cells(self):
        cells = neighbour_cells.coerce([
            {'net': 'LTE', 'pci': 65, 'arfcn': 1850, 'rsrp': -98, 'rsrq': -12, 'junk': 'x'},
            {'net': 'LTE', 'pci': 66},                         # no level
            {'net': 'LTE', 'rsrp': -90},                       # no identity
            {'net': 'LTE', 'pci': 2000, 'rsrp': -90},          # PCI out of range
            {'net': 'UMTS', 'psc': 120, 'rscp': -88, 'ecio': -9},
            {'net': 'GSM', 'bcch': 42, 'bsic': 12, 'rssi': -71},
            {'net': 'NR', 'pci': 1, 'rsrp': -80},              # not taken
            'not a cell',
        ])
        self.assertEqual(cells, [
            {'net': 'LTE', 'pci': 65, 'arfcn': 1850, 'rsrp': -98, 'rsrq': -12},
            {'net': 'UMTS', 'psc': 120, 'rscp': -88, 'ecio': -9},
            {'net': 'GSM', 'bcch': 42, 'bsic': 12, 'rssi': -71},
        ])

    def test_caps_the_list(self):
        cells = neighbour_cells.coerce([{'net': 'LTE', 'pci': i, 'rsrp': -100} for i in range(30)])
        self.assertEqual(len(cells), neighbour_cells.MAX_STORED)

    def test_nothing_usable_is_null(self):
        self.assertIsNone(neighbour_cells.coerce(None))
        self.assertIsNone(neighbour_cells.coerce({'net': 'LTE'}))
        self.assertIsNone(neighbour_cells.coerce([{'net': 'LTE', 'pci': 5}]))

    def test_labels(self):
        self.assertEqual(neighbour_cells.label({'net': 'LTE', 'pci': 65}), 'PCI 65')
        self.assertEqual(neighbour_cells.label({'net': 'GSM', 'bcch': 42, 'bsic': 12}), 'BCCH 42 / BSIC 12')


class StoredNeighbourTests(TestCase):
    def setUp(self):
        full, prefix, key_hash = generate_ingest_key()
        TelemetryIngestKey.objects.create(name='t', key_prefix=prefix, key_hash=key_hash, rate_limit_per_min=1000)
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {full}'}
        serving = Site.objects.create(id='CDR001', name='CDR001_TEST', lat=27.70, lng=85.30)
        other = Site.objects.create(id='CDR002', name='CDR002_TEST', lat=27.71, lng=85.31)
        Sector.objects.create(site=serving, cell_name='CDR001_J3', sector='J3', pci=301)
        Sector.objects.create(site=other, cell_name='CDR002_K3', sector='K3', pci=65)

    def _post(self, rsrp_serving, rsrp_neighbour):
        body = [{
            'device_id': 'dev-n', 'ts': int(timezone.now().timestamp() * 1000), 'lat': 27.701, 'lon': 85.301,
            'network_type': 'LTE', 'pci': 301, 'rsrp_dbm': rsrp_serving, 'mcc': '429', 'mnc': '01',
            'neighbours': [{'net': 'LTE', 'pci': 65, 'arfcn': 1850, 'rsrp': rsrp_neighbour},
                           {'net': 'LTE', 'pci': 999, 'rsrp': -110}],
        }]
        r = APIClient().post('/api/telemetry/v1/samples/', data=json.dumps(body),
                             content_type='application/json', **self.auth)
        self.assertEqual(r.status_code, 202, r.content)

    def test_stored_and_named_at_upload(self):
        self._post(-100, -95)
        s = TelemetrySample.objects.get()
        self.assertEqual(s.serving_site_id, 'CDR001')
        named, unknown = s.neighbours
        self.assertEqual((named['site'], named['sector'], named['rsrp']), ('CDR002', 'K3', -95))
        self.assertGreater(named['km'], 0)
        self.assertNotIn('site', unknown)

    def test_session_summary_counts_stronger_neighbours(self):
        self._post(-100, -95)   # 5 dB stronger than the serving cell
        self._post(-90, -95)    # weaker
        summary = neighbour_cells.session_summary(TelemetrySample.objects.all())
        self.assertEqual((summary['readings'], summary['with_neighbours']), (2, 2))
        row = next(c for c in summary['cells'] if c['site_id'] == 'CDR002')
        self.assertEqual((row['cell'], row['heard'], row['stronger'], row['same_tech']), ('PCI 65', 2, 1, 2))
        self.assertEqual(row['site_name'], 'CDR002_TEST')
        self.assertEqual(row['mostly_beside'], 'CDR001 J3')
