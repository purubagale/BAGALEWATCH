"""Number <-> device links: the rules in core/subscriber_device.py, and the
two lookup tools reading them through the real endpoints."""
import json
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from core.models import (
    EmergencyDeclaration, SubscriberDevice, SubscriberLastLocation, TelemetryIngestKey, User,
)
from core.subscriber_device import (
    describe, devices_for_msisdn, link_device, touch_seen, unlink_via, update_device_details,
)
from core.telemetry import generate_ingest_key, hash_device_id

HUAWEI_NO = '9779864465619'
REDMI_NO = '9779851129935'
RESCUE, REGISTRATION, IDENTITY = (
    SubscriberDevice.VIA_RESCUE, SubscriberDevice.VIA_REGISTRATION, SubscriberDevice.VIA_IDENTITY,
)


class LinkRuleTests(TestCase):
    def test_link_is_created_once_and_refreshed(self):
        a = link_device(HUAWEI_NO, 'dev-a', RESCUE, manufacturer='HUAWEI', phone_model='P10')
        b = link_device(HUAWEI_NO, 'dev-a', IDENTITY)
        self.assertEqual(a.pk, b.pk)
        self.assertEqual(b.linked_via, [RESCUE, IDENTITY])
        self.assertEqual((b.manufacturer, b.phone_model), ('HUAWEI', 'P10'))  # not blanked by the bare call
        self.assertEqual(b.number_verified_by, SubscriberDevice.VERIFIED_SELF)
        self.assertIsNone(link_device('', 'dev-a', RESCUE))
        self.assertIsNone(link_device(HUAWEI_NO, '', RESCUE))

    def test_same_number_on_two_phones_keeps_both(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        link_device(HUAWEI_NO, 'dev-b', RESCUE)
        self.assertEqual({d.device_hash for d in devices_for_msisdn(HUAWEI_NO)}, {'dev-a', 'dev-b'})

    def test_sim_change_on_same_path_ends_the_old_number(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        link_device(REDMI_NO, 'dev-a', RESCUE)
        self.assertEqual(devices_for_msisdn(HUAWEI_NO), [])
        old = SubscriberDevice.objects.get(msisdn=HUAWEI_NO, device_hash='dev-a')
        self.assertEqual(old.ended_reason, SubscriberDevice.ENDED_NUMBER_CHANGED)
        self.assertEqual([d.device_hash for d in devices_for_msisdn(REDMI_NO)], ['dev-a'])

    def test_dual_sim_second_number_through_another_path_is_kept(self):
        link_device(HUAWEI_NO, 'dev-a', REGISTRATION)
        link_device(REDMI_NO, 'dev-a', RESCUE)
        self.assertEqual(len(devices_for_msisdn(HUAWEI_NO)), 1)
        self.assertEqual(len(devices_for_msisdn(REDMI_NO)), 1)

    def test_same_phone_under_two_device_ids_keeps_both_links_and_hashes_the_hardware_id(self):
        # A phone has two ids at once (install id, registration key id), and
        # a reinstall adds another. None is retired; the lookups group them.
        link_device(HUAWEI_NO, 'install-1', RESCUE, hardware_id='android-abc')
        link_device(HUAWEI_NO, 'key-id', REGISTRATION, hardware_id='android-abc')
        links = devices_for_msisdn(HUAWEI_NO)
        self.assertEqual({d.device_hash for d in links}, {'install-1', 'key-id'})
        self.assertEqual(len({d.hardware_hash for d in links}), 1)
        self.assertNotIn('android-abc', links[0].hardware_hash)  # stored hashed

    def test_identity_upload_can_add_the_hardware_id_later(self):
        link_device(HUAWEI_NO, 'key-id', REGISTRATION)
        update_device_details('key-id', hardware_id='android-abc')
        self.assertTrue(SubscriberDevice.objects.get(device_hash='key-id').hardware_hash)

    def test_without_hardware_id_a_reinstall_looks_like_a_second_device(self):
        link_device(HUAWEI_NO, 'install-1', RESCUE)
        link_device(HUAWEI_NO, 'install-2', RESCUE)
        self.assertEqual(len(devices_for_msisdn(HUAWEI_NO)), 2)

    def test_a_different_phone_with_another_hardware_id_is_not_retired(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE, hardware_id='android-abc')
        link_device(HUAWEI_NO, 'dev-b', RESCUE, hardware_id='android-xyz')
        self.assertEqual(len(devices_for_msisdn(HUAWEI_NO)), 2)

    def test_ended_link_is_reopened_by_a_new_enrolment(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        unlink_via('dev-a', RESCUE)
        self.assertEqual(devices_for_msisdn(HUAWEI_NO), [])
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        self.assertEqual(len(devices_for_msisdn(HUAWEI_NO)), 1)

    def test_unlink_ends_only_when_no_path_is_left(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        link_device(HUAWEI_NO, 'dev-a', IDENTITY)
        unlink_via('dev-a', RESCUE)
        self.assertEqual(devices_for_msisdn(HUAWEI_NO)[0].linked_via, [IDENTITY])
        unlink_via('dev-a', IDENTITY)
        self.assertEqual(devices_for_msisdn(HUAWEI_NO), [])

    def test_most_recently_seen_first_and_stale_flag(self):
        now = timezone.now()
        link_device(HUAWEI_NO, 'old-phone', RESCUE)
        link_device(HUAWEI_NO, 'new-phone', RESCUE)
        link_device(HUAWEI_NO, 'silent-phone', RESCUE)
        touch_seen(['old-phone'], now - timedelta(days=45))
        touch_seen(['new-phone'], now - timedelta(hours=1))
        SubscriberDevice.objects.filter(device_hash='silent-phone').update(last_linked_at=now - timedelta(days=90))
        order = devices_for_msisdn(HUAWEI_NO)
        self.assertEqual([d.device_hash for d in order], ['new-phone', 'old-phone', 'silent-phone'])
        self.assertEqual([describe(d)['stale'] for d in order], [False, True, True])

    def test_touch_seen_skips_ended_links_and_details_update(self):
        link_device(HUAWEI_NO, 'dev-a', RESCUE)
        link_device(REDMI_NO, 'dev-a', RESCUE)  # ends the first
        touch_seen(['dev-a', '', None])
        self.assertIsNone(SubscriberDevice.objects.get(msisdn=HUAWEI_NO).last_seen_at)
        self.assertIsNotNone(SubscriberDevice.objects.get(msisdn=REDMI_NO).last_seen_at)
        update_device_details('dev-a', 'Xiaomi', 'Redmi Note')
        self.assertEqual(SubscriberDevice.objects.get(msisdn=REDMI_NO).phone_model, 'Redmi Note')
        self.assertEqual(SubscriberDevice.objects.get(msisdn=HUAWEI_NO).phone_model, '')

    def test_withdrawn_rescue_consent_hides_the_device(self):
        link_device(HUAWEI_NO, 'dev-a', REGISTRATION)
        SubscriberLastLocation.objects.create(device_id='dev-a', msisdn=HUAWEI_NO, rescue_consent=False)
        self.assertEqual(devices_for_msisdn(HUAWEI_NO), [])
        self.assertEqual(len(devices_for_msisdn(HUAWEI_NO, include_withdrawn=True)), 1)


class LookupEndToEndTests(TestCase):
    """Enrol and upload through the device endpoints, then search with
    both operator tools."""

    def setUp(self):
        full, prefix, key_hash = generate_ingest_key()
        TelemetryIngestKey.objects.create(name='t', key_prefix=prefix, key_hash=key_hash, rate_limit_per_min=1000)
        self.device = APIClient()
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {full}'}
        self.su = User.objects.create_user(username='su_links', password='x-Audit-12345!', role='superadmin')
        self.op = APIClient()
        self.op.force_authenticate(user=self.su)
        EmergencyDeclaration.objects.create(
            reason='test', declared_by=self.su, expires_at=timezone.now() + timedelta(days=1),
        )

    def enrol(self, raw_device, number, **extra):
        r = self.device.post('/api/telemetry/v1/rescue-enroll/', data=json.dumps(
            {'device_id': raw_device, 'consent': True, 'msisdn': number, **extra},
        ), content_type='application/json', **self.auth)
        self.assertEqual(r.status_code, 200, r.content)

    def upload(self, raw_device, lat, lon, minutes_ago):
        ts = int((timezone.now() - timedelta(minutes=minutes_ago)).timestamp() * 1000)
        r = self.device.post('/api/telemetry/v1/samples/', data=json.dumps([{
            'device_id': raw_device, 'ts': ts, 'lat': lat, 'lon': lon, 'gps_accuracy_m': 9.0,
            'cell_id': 1, 'pci': 1, 'tac': 1, 'mcc': '429', 'mnc': '01', 'network_type': 'LTE',
            'rsrp_dbm': -90, 'rsrq_db': -10, 'rssi_dbm': -70, 'sinr_db': 10, 'battery_pct': 50,
            'trigger_reason': 'periodic',
        }]), content_type='application/json', **self.auth)
        self.assertEqual(r.status_code, 202, r.content)

    def rescue(self, number):
        return self.op.get('/api/v2/rescue/lookup/', {'msisdn': number, 'case_reference': 'c1'}).json()

    def trace(self, number):
        return self.op.get('/api/v2/device-location-trace/', {'msisdn': number, 'case_reference': 'c1'}).json()

    def test_enrolment_writes_a_link_with_model(self):
        self.enrol('huawei-install', '9864465619', manufacturer='HUAWEI', model='VTR-L29', app_version='1.4')
        link = SubscriberDevice.objects.get()
        self.assertEqual((link.msisdn, link.device_hash), (HUAWEI_NO, hash_device_id('huawei-install')))
        self.assertEqual((link.manufacturer, link.phone_model, link.app_version), ('HUAWEI', 'VTR-L29', '1.4'))
        self.assertEqual(link.linked_via, [RESCUE])

    def test_each_number_returns_its_own_phone_in_both_tools(self):
        self.enrol('huawei-install', '9864465619', manufacturer='HUAWEI', model='VTR-L29')
        self.enrol('redmi-install', '9851129935', manufacturer='Xiaomi', model='Redmi')
        self.upload('huawei-install', 27.70, 85.30, minutes_ago=30)
        self.upload('redmi-install', 28.20, 83.98, minutes_ago=5)

        for number, lat, model, raw in (('9864465619', 27.70, 'HUAWEI VTR-L29', 'huawei-install'),
                                        ('9851129935', 28.20, 'Xiaomi Redmi', 'redmi-install')):
            r, t = self.rescue(number), self.trace(number)
            self.assertTrue(r['found'] and t['found'])
            self.assertEqual((r['lat'], t['lat']), (lat, lat))
            self.assertEqual(r['device'], hash_device_id(raw)[:10])
            self.assertEqual(t['device_hash'], hash_device_id(raw))
            self.assertEqual(r['device_model'], model)
            self.assertEqual((r['device_count'], len(t['devices'])), (1, 1))

    def test_one_number_on_two_phones_lists_both_and_pins_the_newest(self):
        self.enrol('phone-1', '9864465619', manufacturer='HUAWEI', model='VTR-L29')
        self.enrol('phone-2', '9864465619', manufacturer='OPPO', model='CPH')
        self.upload('phone-1', 27.70, 85.30, minutes_ago=120)
        self.upload('phone-2', 27.75, 85.35, minutes_ago=3)

        r, t = self.rescue('9864465619'), self.trace('9864465619')
        self.assertEqual((r['lat'], r['lng']), (27.75, 85.35))
        self.assertEqual(r['device_model'], 'OPPO CPH')
        self.assertEqual(r['device_count'], 2)
        self.assertEqual((t['lat'], t['lng']), (27.75, 85.35))
        self.assertEqual(t['device_hash'], hash_device_id('phone-2'))
        self.assertEqual([(d['phone_model'], d['lat']) for d in t['devices']], [('CPH', 27.75), ('VTR-L29', 27.70)])
        self.assertTrue(all(d['last_seen_at'] and not d['stale'] for d in t['devices']))

    def test_upload_stamps_last_seen_only_for_linked_devices(self):
        self.enrol('phone-1', '9864465619')
        self.assertIsNone(SubscriberDevice.objects.get().last_seen_at)
        self.upload('stranger', 27.0, 85.0, minutes_ago=1)
        self.assertIsNone(SubscriberDevice.objects.get().last_seen_at)
        self.upload('phone-1', 27.7, 85.3, minutes_ago=1)
        self.assertIsNotNone(SubscriberDevice.objects.get().last_seen_at)

    def test_withdrawing_consent_removes_the_phone_from_both_tools(self):
        self.enrol('phone-1', '9864465619')
        self.upload('phone-1', 27.7, 85.3, minutes_ago=1)
        self.assertTrue(self.trace('9864465619')['found'])
        r = self.device.post('/api/telemetry/v1/rescue-enroll/', data=json.dumps(
            {'device_id': 'phone-1', 'consent': False}), content_type='application/json', **self.auth)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(self.rescue('9864465619')['found'])
        self.assertFalse(self.trace('9864465619')['found'])
        self.assertIsNotNone(SubscriberDevice.objects.get().ended_at)  # history kept

    def test_two_device_ids_of_one_phone_are_shown_as_one_phone(self):
        # Enrolled under the install id; an older install id of the same
        # phone (a reinstall) also linked. Same hardware id on both.
        self.enrol('install-old', '9864465619', manufacturer='HUAWEI', model='VTR-L29', hardware_id='hw-1')
        self.enrol('install-new', '9864465619', manufacturer='HUAWEI', model='VTR-L29', hardware_id='hw-1')
        self.enrol('other-phone', '9864465619', manufacturer='OPPO', model='CPH', hardware_id='hw-2')
        self.upload('install-old', 27.60, 85.20, minutes_ago=600)
        self.upload('install-new', 27.70, 85.30, minutes_ago=10)
        self.upload('other-phone', 27.75, 85.35, minutes_ago=60)

        r, t = self.rescue('9864465619'), self.trace('9864465619')
        self.assertEqual(r['device_count'], 2)                      # two phones, not three ids
        self.assertEqual((r['lat'], r['device_model']), (27.70, 'HUAWEI VTR-L29'))
        self.assertEqual(len(t['devices']), 2)
        huawei = t['devices'][0]
        self.assertEqual(huawei['device_hash'], hash_device_id('install-new'))
        self.assertEqual(set(huawei['device_hashes']), {hash_device_id('install-old'), hash_device_id('install-new')})
        self.assertEqual(huawei['lat'], 27.70)                      # the phone's newest, from the new id
        self.assertNotIn('hardware_hash', huawei)                   # never sent to a client
        self.assertEqual(t['devices'][1]['phone_model'], 'CPH')

    def test_unknown_number_is_not_found(self):
        self.assertFalse(self.rescue('9800000001')['found'])
        t = self.trace('9800000001')
        self.assertEqual((t['found'], t['devices']), (False, []))
