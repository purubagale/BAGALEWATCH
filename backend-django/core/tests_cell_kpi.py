"""Per-cell network KPIs (2026-10-28, core/cell_kpi.py)."""
from datetime import date, datetime
from zoneinfo import ZoneInfo

from django.test import TestCase
from rest_framework.test import APIClient

from .api_auth import generate_api_key
from .cell_kpi import BUSY_PRB, Matcher, load_at, normalize, site_busy_days, store
from .models import ApiKey, CellKpi, Sector, Site

NPT = ZoneInfo('Asia/Kathmandu')


def export_row(cell, lcid, prb_dl, when='2026-10-22 20:00', **more):
    """One row as NTC's daily network export has it (busy-hour file)."""
    return {'Time': when, 'eNodeB Name': cell.split('-')[0] + '_L', 'Cell Name': cell, 'LocalCell Id': str(lcid),
            'eNodeB Function Name': cell.rsplit('-', 1)[0], 'Integrity': 1,
            'Resource Block Utilizing Rate (DL)(%)': prb_dl, 'Resource Block Utilizing Rate (UL)(%)': '/0',
            'Average DL Throughput per User(Mbps)': 2.5, 'Average number of users': 60,
            'Call Drop Rate (VoIP)(%)': '', 'Odd Column': 'kept', **more}


class NormalizeTests(TestCase):
    def test_export_busy_hour_row(self):
        rec, why = normalize(export_row('FWDR444_Jogbudha height-J3', 1, 99.0))
        self.assertIsNone(why)
        self.assertEqual(rec['level'], 'bbh')
        self.assertEqual(rec['busy_hour'], 20)
        self.assertEqual(rec['date'], date(2026, 10, 22))
        self.assertEqual(rec['site_id'], 'FWDR444')
        self.assertEqual(rec['cell_key'], 'FWDR444_JOGBUDHAHEIGHT-J3')
        self.assertEqual(rec['prb_dl'], 99.0)
        self.assertIsNone(rec['prb_ul'])          # "/0" = not measured, never 0
        self.assertIsNone(rec['volte_drop'])      # blank = not measured
        self.assertEqual(rec['extra']['Odd Column'], 'kept')

    def test_day_row_and_our_names(self):
        rec, _ = normalize({'Date': '2026-10-22', 'Cell Name': 'KTM856_X-K3', 'LocalCell Id': 2})
        self.assertEqual(rec['level'], 'day')
        self.assertEqual(rec['hour'], -1)
        rec, _ = normalize({'date': '20261022', 'level': 'hour', 'hour': 21, 'enodeb_id': 1856, 'local_cell_id': 2,
                            'prb_dl': '81.5%'})
        self.assertEqual((rec['hour'], rec['site_id'], rec['prb_dl']), (21, 'KTM856', 81.5))
        self.assertEqual(rec['cell_key'], 'ENB1856-2')

    def test_their_field_names(self):
        rec, _ = normalize({'kpi_date': '2026-10-22', 'granularity': 'day', 'cell': 'KTM856_X-J3', 'dl_prb_pct': 40},
                           {'kpi_date': 'date', 'granularity': 'level', 'cell': 'cell_name', 'dl_prb_pct': 'prb_dl'})
        self.assertEqual((rec['level'], rec['prb_dl']), ('day', 40.0))

    def test_refusals(self):
        self.assertEqual(normalize({'Cell Name': 'X-J3'})[1], 'no date')
        self.assertEqual(normalize({'date': '2026-10-22', 'level': 'week', 'cell_name': 'X'})[1], 'unknown level')
        self.assertEqual(normalize({'date': '2026-10-22', 'level': 'hour', 'cell_name': 'X'})[1],
                         'hour row without an hour 0-23')
        self.assertEqual(normalize({'date': '2026-10-22', 'level': 'day'})[1], 'no cell name or eNodeB ID')


class StoreTests(TestCase):
    def setUp(self):
        self.site = Site.objects.create(id='FWDR444', name='Jogbudha height')
        self.j3 = Sector.objects.create(site=self.site, cell_name='FWDR444_Jogbudha height-J3', sector='J3',
                                        tech='4G', local_cell_id=1)
        # Named differently in the site list: found by site + sector label.
        self.k20 = Sector.objects.create(site=self.site, cell_name='FWDR444_JOGBUDHA-K20', sector='K20',
                                         tech='4G', local_cell_id=5)

    def test_match_upsert_and_site_prb(self):
        rows = [export_row('FWDR444_Jogbudha height-J3', 1, 99.0),
                export_row('FWDR444_Jogbudha height-K20', 5, 85.0),
                export_row('FWDR444_Jogbudha height-L20', 6, 70.0)]
        got = store(rows, 'demo')
        self.assertEqual((got['rows'], got['matched'], got['unmatched']), (3, 2, 1))
        self.assertEqual(CellKpi.objects.get(cell_name__endswith='J3').sector, self.j3)
        self.assertEqual(CellKpi.objects.get(cell_name__endswith='K20').sector, self.k20)
        self.assertEqual(CellKpi.objects.get(cell_name__endswith='L20').site_id, 'FWDR444')
        self.site.refresh_from_db()
        self.assertEqual(self.site.prb_dl, 99.0)
        # Sending the same period again replaces it.
        store([export_row('FWDR444_Jogbudha height-J3', 1, 50.0)], 'demo')
        self.assertEqual(CellKpi.objects.count(), 3)
        self.assertEqual(CellKpi.objects.get(cell_name__endswith='J3').prb_dl, 50.0)

    def test_load_at_prefers_the_hour(self):
        store([export_row('FWDR444_Jogbudha height-J3', 1, 99.0),
               {'date': '2026-10-22', 'level': 'hour', 'hour': 9, 'cell_name': 'FWDR444_Jogbudha height-J3', 'prb_dl': 20},
               {'Date': '2026-10-22', 'Cell Name': 'FWDR444_Jogbudha height-J3', 'Resource Block Utilizing Rate (DL)(%)': 60}],
              'demo')
        at9 = load_at(datetime(2026, 10, 22, 9, 30, tzinfo=NPT), sector_id=self.j3.pk)
        self.assertEqual((at9['level'], at9['prb_dl'], at9['quiet']), ('hour', 20.0, True))
        at15 = load_at(datetime(2026, 10, 22, 15, tzinfo=NPT), sector_id=self.j3.pk)
        self.assertEqual((at15['level'], at15['prb_dl'], at15['busy']), ('bbh', 99.0, True))
        later = load_at(datetime(2026, 10, 24, 15, tzinfo=NPT), site_id='FWDR444')
        self.assertTrue(later['earlier_day'])
        self.assertIsNone(load_at(datetime(2026, 10, 30, 15, tzinfo=NPT), site_id='FWDR444'))

    def test_matcher_by_enodeb(self):
        self.j3.enodeb_id = 6444
        self.j3.save()
        rec, _ = normalize({'date': '2026-10-22', 'level': 'day', 'enodeb_id': 6444, 'local_cell_id': 1})
        self.assertEqual(Matcher().find(rec)[0], self.j3.pk)

    def test_busy_days(self):
        store([export_row('FWDR444_Jogbudha height-J3', 1, BUSY_PRB + 5)], 'demo')
        busy = site_busy_days({'FWDR444'}, days=3650)
        self.assertEqual(busy['FWDR444']['busy_days'], 1)


class PushTests(TestCase):
    def setUp(self):
        Site.objects.create(id='KTM856', name='Bohoratar')
        full, prefix, digest = generate_api_key()
        ApiKey.objects.create(name='KPI system', key_prefix=prefix, key_hash=digest, scopes=['kpis:write'])
        self.key = full
        full2, prefix2, digest2 = generate_api_key()
        ApiKey.objects.create(name='Other', key_prefix=prefix2, key_hash=digest2, scopes=['problems:write'])
        self.other = full2

    def test_push_needs_the_scope(self):
        c = APIClient()
        body = [{'date': '2026-10-22', 'level': 'day', 'cell_name': 'KTM856_BOHORATAR1-J3', 'local_cell_id': 1, 'prb_dl': 34}]
        self.assertEqual(c.post('/api/external/v1/cell-kpis/', body, format='json', HTTP_X_API_KEY=self.other).status_code, 403)
        r = c.post('/api/external/v1/cell-kpis/', body, format='json', HTTP_X_API_KEY=self.key)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['rows'], 1)
        self.assertEqual(CellKpi.objects.get().source, 'push')
        self.assertEqual(c.post('/api/external/v1/cell-kpis/', [], format='json', HTTP_X_API_KEY=self.key).status_code, 400)
