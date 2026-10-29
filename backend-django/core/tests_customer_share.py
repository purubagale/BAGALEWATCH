"""The customer's own "share until this is fixed" (2026-10-29, core/problem_report.py)."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .models import DeviceCredential, ProblemReport, TraceRequest
from .problem_report import SHARE_MAX_HOURS, start_customer_share


class CustomerShareTests(TestCase):
    def setUp(self):
        self.phone = DeviceCredential.objects.create(device_hash='kshare', public_key_pem='x', msisdn='9779800000009')
        self.report = ProblemReport.objects.create(source='app', device=self.phone, category='slow_data',
                                                   lat=27.7, lng=85.3, happened_at=timezone.now())
        self.admin = get_user_model().objects.create_user('share_admin', password='x', role='admin')

    def _start(self):
        req = RequestFactory().post('/x')
        req.user = self.phone
        return start_customer_share(req, self.report, self.phone)

    def test_starts_accepted_for_the_complaint(self):
        share = self._start()
        trace = TraceRequest.objects.get(pk=share['trace_id'])
        self.assertEqual((trace.status, trace.consent_method, trace.case_reference),
                         (TraceRequest.STATUS_ACCEPTED, TraceRequest.CONSENT_APP, f'Complaint ID {self.report.pk}'))
        self.assertAlmostEqual(trace.expires_at, timezone.now() + timedelta(hours=SHARE_MAX_HOURS),
                               delta=timedelta(minutes=1))
        self.assertEqual(share['interval_s'], 300)

    def test_closing_the_complaint_ends_it(self):
        share = self._start()
        c = APIClient()
        c.force_authenticate(self.admin)
        c.patch(f'/api/v2/problem-reports/{self.report.pk}/', {'status': 'checked'}, format='json')
        self.assertEqual(TraceRequest.objects.get(pk=share['trace_id']).status, TraceRequest.STATUS_ACCEPTED)
        c.patch(f'/api/v2/problem-reports/{self.report.pk}/', {'status': 'closed'}, format='json')
        trace = TraceRequest.objects.get(pk=share['trace_id'])
        self.assertEqual(trace.status, TraceRequest.STATUS_COMPLETED)
        self.assertIsNotNone(trace.ended_at)
