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


class SharesAndFindingsTests(TestCase):
    def setUp(self):
        site = Site.objects.create(id='CDR001', name='CDR001_TEST', lat=27.70, lng=85.30)
        Sector.objects.create(site=site, cell_name='CDR001_J3', sector='J3', pci=301)

    def _reading(self, serving, levels):
        TelemetrySample.objects.create(
            device_id='d', ts=timezone.now(), received_at=timezone.now(), lat=27.701, lng=85.301,
            network_type='LTE', pci=301, rsrp_dbm=serving, serving_site_id='CDR001', serving_sector='J3',
            neighbours=[{'net': 'LTE', 'pci': 60 + i, 'rsrp': v} for i, v in enumerate(levels)])

    def test_stronger_and_crowded_shares(self):
        self._reading(-100, [-95, -99, -102])   # one stronger, three within 5 dB: crowded
        self._reading(-80, [-100])              # neither
        s = neighbour_cells.session_summary(TelemetrySample.objects.all())
        self.assertEqual((s['same_tech_readings'], s['stronger_readings'], s['crowded_readings']), (2, 1, 1))
        self.assertEqual(s['avg_cells_heard'], 2.0)
        hidden = neighbour_cells.counts_only(s)
        self.assertEqual((hidden['cells'], hidden['names_hidden'], hidden['stronger_readings']), ([], True, 1))

    def test_problem_findings(self):
        from .problem_report import _neighbour_findings
        for _ in range(6):
            self._reading(-100, [-95, -99, -102])
        kinds = [f['kind'] for f in _neighbour_findings(
            neighbour_cells.session_summary(TelemetrySample.objects.all()), 'CDR001')]
        self.assertEqual(kinds, ['stronger_neighbour', 'no_dominant_cell'])
        self.assertEqual(_neighbour_findings({'same_tech_readings': 2, 'cells': []}, 'CDR001'), [])

    def test_signal_point_fields(self):
        f = neighbour_cells.point_fields([{'net': 'LTE', 'pci': 95, 'rsrp': -88, 'site': 'KTM361', 'sector': 'J20'},
                                          {'net': 'GSM', 'bcch': 42, 'rssi': -60}], 'LTE')
        self.assertEqual((f['neighbour_count'], f['neighbour_best']), (2, 'PCI 95 · -88 dBm'))
        self.assertIn('KTM361 J20', neighbour_cells.point_fields(
            [{'net': 'LTE', 'pci': 95, 'rsrp': -88, 'site': 'KTM361', 'sector': 'J20'}], 'LTE', with_site=True)['neighbour_best'])
