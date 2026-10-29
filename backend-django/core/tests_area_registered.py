"""Area Sample asks registered phones that are not sharing, with Accept/Reject (2026-10-29)."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .models import DeviceCredential, TelemetryPushToken, TelemetrySample, TraceLocationSample, TraceRequest

LAT, LNG = 27.70, 85.33


def _phone(key, msisdn, lat, lng, days_ago=1):
    cred = DeviceCredential.objects.create(device_hash=f'k{key}', sdk_device_hash=f's{key}', public_key_pem='x',
                                           msisdn=msisdn, fcm_token=f'token{key}')
    when = timezone.now() - timedelta(days=days_ago)
    TelemetrySample.objects.create(device_id=f's{key}', ts=when, received_at=when, lat=lat, lng=lng,
                                   network_type='LTE', rsrp_dbm=-95)
    return cred


class AreaRegisteredTests(TestCase):
    def setUp(self):
        self.near = _phone(1, '9779800000001', LAT + 0.002, LNG)
        self.far = _phone(2, '9779800000002', LAT + 0.5, LNG)            # outside the circle
        self.old = _phone(3, '9779800000003', LAT, LNG, days_ago=20)     # seen too long ago
        self.shares = _phone(4, '9779800000004', LAT, LNG + 0.002)       # sharing: asked quietly instead
        TelemetryPushToken.objects.create(device_id='s4', fcm_token='t4')
        User = get_user_model()
        self.admin = User.objects.create_user('area_admin', password='x', role='admin')

    def _ask(self, **extra):
        c = APIClient()
        c.force_authenticate(self.admin)
        return c.post('/api/v2/telemetry/area-samples/', {'lat': LAT, 'lng': LNG, 'radius_km': 1, **extra},
                      format='json')

    def test_only_the_registered_phone_seen_nearby_is_asked_and_must_accept(self):
        resp = self._ask()
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['registered_asked'], 1)
        trace = TraceRequest.objects.get()
        self.assertEqual((trace.device, trace.kind, trace.status), (self.near, TraceRequest.KIND_INVESTIGATION,
                                                                    TraceRequest.STATUS_PENDING))
        self.assertEqual(trace.area_request_id, resp.json()['id'])

        # After Accept its readings inside the circle join the results, with no number.
        trace.status, trace.consent_at = TraceRequest.STATUS_ACCEPTED, timezone.now()
        trace.save()
        TraceLocationSample.objects.create(trace=trace, ts=timezone.now(), lat=LAT + 0.001, lng=LNG,
                                           network_type='LTE', rsrp_dbm=-101)
        TraceLocationSample.objects.create(trace=trace, ts=timezone.now(), lat=LAT + 0.2, lng=LNG,
                                           network_type='LTE', rsrp_dbm=-90)      # outside: left out
        c = APIClient()
        c.force_authenticate(self.admin)
        res = c.get(f'/api/v2/telemetry/area-samples/{trace.area_request_id}/samples/').json()
        self.assertEqual(res['registered'], {'asked': 1, 'accepted': 1, 'declined': 0, 'waiting': 0})
        self.assertEqual([s['rsrp_dbm'] for s in res['samples']], [-101])
        self.assertEqual(res['samples'][0]['source'], 'registered')
        self.assertNotIn('9779800000001', str(res))

    def test_switched_off(self):
        self.assertEqual(self._ask(ask_registered=False).json()['registered_asked'], 0)
        self.assertFalse(TraceRequest.objects.exists())

    def test_not_asked_twice_while_a_request_is_open(self):
        self._ask()
        self.assertEqual(self._ask().json()['registered_asked'], 0)
