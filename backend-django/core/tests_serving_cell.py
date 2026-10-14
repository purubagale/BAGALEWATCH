"""How a reading is given to one of several sites with the same id
(core/dt_serving_cell.py) and the direction check of the site map
(core/site_coverage.py). No database."""
from types import SimpleNamespace

from django.test import SimpleTestCase

from .dt_serving_cell import choose_sector
from .site_coverage import direction_check


def sector(site_id, lat, lng, azimuth):
    return SimpleNamespace(site_id=site_id, azimuth=azimuth, site=SimpleNamespace(lat=lat, lng=lng))


# Two sites 0.06 degrees of longitude apart at latitude 27.87: about 5.9 km.
WEST = dict(site_id='WEST', lat=27.87, lng=83.50)
EAST = dict(site_id='EAST', lat=27.87, lng=83.56)


class ChooseSectorTests(SimpleTestCase):
    def pick(self, lat, lng, west_az, east_az, max_km=15.0):
        sec, km, unsure = choose_sector(lat, lng, [sector(azimuth=west_az, **WEST), sector(azimuth=east_az, **EAST)], max_km)
        return (sec.site_id if sec else None), unsure

    def test_distance_is_a_hard_limit(self):
        self.assertEqual(self.pick(27.87, 83.53, 90, 270, max_km=1.0), (None, False))

    def test_clearly_nearer_site_wins_whatever_the_direction(self):
        # 1 km from WEST, 4.9 km from EAST; WEST points away, EAST points at it.
        self.assertEqual(self.pick(27.87, 83.51, 270, 270), ('WEST', False))

    def test_beside_a_site_distance_decides(self):
        self.assertEqual(self.pick(27.8702, 83.5005, 270, 270), ('WEST', False))

    def test_between_two_sites_the_one_pointing_at_it_wins(self):
        # A little nearer WEST, but only EAST points at the reading.
        self.assertEqual(self.pick(27.87, 83.528, 270, 270), ('EAST', False))
        self.assertEqual(self.pick(27.87, 83.532, 90, 90), ('WEST', False))

    def test_between_two_sites_both_pointing_is_uncertain(self):
        self.assertEqual(self.pick(27.87, 83.528, 90, 270), ('WEST', True))

    def test_between_two_sites_neither_pointing_is_uncertain(self):
        self.assertEqual(self.pick(27.87, 83.528, 270, 90), ('WEST', True))

    def test_no_azimuth_cannot_refine(self):
        self.assertEqual(self.pick(27.87, 83.528, None, None), ('WEST', True))

    def test_single_candidate(self):
        sec, km, unsure = choose_sector(27.87, 83.52, [sector(azimuth=None, **WEST)])
        self.assertEqual((sec.site_id, unsure), ('WEST', False))


class DirectionCheckTests(SimpleTestCase):
    def test_too_few_readings(self):
        self.assertIsNone(direction_check(180, [(180, 50)]))
        self.assertIsNone(direction_check(None, [(180, 500)]))

    def test_readings_where_the_sector_points(self):
        d = direction_check(180, [(170, 100), (190, 100), (200, 50)])
        self.assertEqual(d['in_direction_pct'], 100)
        self.assertLessEqual(d['off_azimuth_deg'], 10)
        self.assertFalse(d['differs'])

    def test_readings_off_to_one_side_are_flagged(self):
        d = direction_check(180, [(95, 300), (100, 100)])
        self.assertEqual(d['in_direction_pct'], 0)
        self.assertGreater(d['off_azimuth_deg'], 70)
        self.assertTrue(d['differs'])

    def test_centre_wraps_through_north(self):
        d = direction_check(0, [(350, 100), (10, 100)])
        self.assertIn(d['centre_deg'], (0, 360))
        self.assertFalse(d['differs'])

    def test_readings_all_round_have_no_centre(self):
        d = direction_check(180, [(0, 100), (90, 100), (180, 100), (270, 100)])
        self.assertIsNone(d['centre_deg'])
