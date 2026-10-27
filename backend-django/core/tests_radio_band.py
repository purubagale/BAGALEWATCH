from datetime import datetime, timezone

from django.test import SimpleTestCase

from . import radio_band
from .telemetry import coerce_sample


class ResolveTests(SimpleTestCase):
    def test_lte_from_channel(self):
        self.assertEqual(radio_band.resolve('LTE', arfcn=1650), (3, 1800))
        self.assertEqual(radio_band.resolve('LTE', arfcn=6300), (20, 800))
        self.assertEqual(radio_band.resolve('LTE', arfcn=100), (1, 2100))
        self.assertEqual(radio_band.resolve('LTE', arfcn=38950), (40, 2300))

    def test_range_edges(self):
        self.assertEqual(radio_band.resolve('LTE', arfcn=1949), (3, 1800))
        self.assertEqual(radio_band.resolve('LTE', arfcn=1950), (4, 1700))
        self.assertEqual(radio_band.resolve('LTE', arfcn=2700), (None, None))

    def test_reported_band_wins(self):
        self.assertEqual(radio_band.resolve('LTE', arfcn=1650, band=8), (8, 900))

    def test_reported_band_with_no_channel(self):
        self.assertEqual(radio_band.resolve('NR', band=78), (78, 3500))
        self.assertEqual(radio_band.resolve('LTE', band=66), (66, None))

    def test_bad_reported_band_falls_back_to_channel(self):
        self.assertEqual(radio_band.resolve('LTE', arfcn=1650, band=0), (3, 1800))

    def test_umts(self):
        self.assertEqual(radio_band.resolve('UMTS', arfcn=10737), (1, 2100))
        self.assertEqual(radio_band.resolve('UMTS', arfcn=3000), (8, 900))

    def test_gsm_has_no_band_number(self):
        self.assertEqual(radio_band.resolve('GSM', bcch=60), (None, 900))
        self.assertEqual(radio_band.resolve('GSM', bcch=1000), (None, 900))
        self.assertEqual(radio_band.resolve('GSM', arfcn=700), (None, 1800))
        self.assertEqual(radio_band.resolve('GSM', bcch=400), (None, None))

    def test_nothing_known(self):
        self.assertEqual(radio_band.resolve('LTE'), (None, None))
        self.assertEqual(radio_band.resolve('UNKNOWN', arfcn=1650), (None, None))

    def test_label(self):
        self.assertEqual(radio_band.label('LTE', 3, 1800), 'B3 (1800)')
        self.assertEqual(radio_band.label('NR', 78, 3500), 'n78 (3500)')
        self.assertEqual(radio_band.label('LTE', 66, None), 'B66')
        self.assertEqual(radio_band.label('GSM', None, 900), '900')
        self.assertEqual(radio_band.label('LTE', None, None), '')


class CoerceTests(SimpleTestCase):
    NOW = datetime(2026, 10, 13, tzinfo=timezone.utc)

    def row(self, **extra):
        return coerce_sample({'device_id': 'd', 'ts': 1760000000000, **extra}, self.NOW)

    def test_channel_gives_band(self):
        r = self.row(network_type='LTE', arfcn=1650)
        self.assertEqual((r['arfcn'], r['band'], r['band_mhz']), (1650, 3, 1800))

    def test_gsm_band_from_bcch_alone(self):
        r = self.row(network_type='GSM', bcch=45)
        self.assertEqual((r['arfcn'], r['band'], r['band_mhz']), (None, None, 900))

    def test_old_app_sends_nothing(self):
        r = self.row(network_type='LTE', pci=301)
        self.assertEqual((r['arfcn'], r['band'], r['band_mhz']), (None, None, None))

    def test_nonsense_channel_is_dropped(self):
        r = self.row(network_type='LTE', arfcn=-5)
        self.assertEqual((r['arfcn'], r['band']), (None, None))


class BandwidthTests(SimpleTestCase):
    NOW = datetime(2026, 10, 27, tzinfo=timezone.utc)

    def test_serving_cell_only(self):
        self.assertEqual(radio_band.resolve_bandwidth(20000), (20000, None, None))

    def test_carrier_aggregation(self):
        self.assertEqual(radio_band.resolve_bandwidth(20000, [20000, 15000, 10000]), (20000, 45000, 3))

    def test_first_carrier_stands_in(self):
        self.assertEqual(radio_band.resolve_bandwidth(None, [10000, 5000]), (10000, 15000, 2))

    def test_no_value_codes_dropped(self):
        self.assertEqual(radio_band.resolve_bandwidth(2147483647, [0, 20000, -1]), (20000, 20000, 1))
        self.assertEqual(radio_band.resolve_bandwidth('x', 'not a list'), (None, None, None))

    def test_label(self):
        self.assertEqual(radio_band.bandwidth_label(20000), '20 MHz')
        self.assertEqual(radio_band.bandwidth_label(1400), '1.4 MHz')
        self.assertEqual(radio_band.bandwidth_label(20000, 20000, 1), '20 MHz')
        self.assertEqual(radio_band.bandwidth_label(20000, 45000, 3), '20 MHz (3 carriers, 45 MHz)')
        self.assertEqual(radio_band.bandwidth_label(None), '')

    def test_coerce(self):
        r = coerce_sample({'device_id': 'd', 'ts': 1760000000000, 'network_type': 'LTE',
                           'bandwidth_khz': 15000, 'cell_bandwidths_khz': [15000, 100000]}, self.NOW)
        self.assertEqual((r['bandwidth_khz'], r['total_bandwidth_khz'], r['carrier_count']), (15000, 115000, 2))
        r = coerce_sample({'device_id': 'd', 'ts': 1760000000000, 'network_type': 'LTE'}, self.NOW)
        self.assertEqual((r['bandwidth_khz'], r['total_bandwidth_khz'], r['carrier_count']), (None, None, None))
