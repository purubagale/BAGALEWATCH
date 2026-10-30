"""Loaded latency and use ratings (2026-10-29, core/speed_quality.py)."""
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from . import speed_quality
from .models import ProblemReport
from .problem_report import check_report


class RatingTests(SimpleTestCase):
    def test_the_users_ookla_run(self):
        # Fast, 7 ms idle, but 180 / 349 ms under load (the phone's table is the same).
        r = speed_quality.rate(114.5, 131.3, 7, 5, 0, 180, 349)
        self.assertEqual(r, {'browsing': 'good', 'video': 'very_good', 'gaming': 'fair', 'video_call': 'fair'})

    def test_quiet_line_and_missing_download(self):
        self.assertEqual(set(speed_quality.rate(114.5, 131.3, 7, 5, 0, 80, 90).values()), {'very_good'})
        self.assertEqual(speed_quality.rate(None, 10, 20), {})
        self.assertEqual(speed_quality.rate(0.5, 0.2, 300)['video_call'], 'poor')


class LoadedLatencyCauseTests(TestCase):
    def test_fast_line_with_high_loaded_latency(self):
        report = ProblemReport.objects.create(
            source='staff', category='call_drop', lat=27.7, lng=85.3, happened_at=timezone.now(),
            download_mbps=40, upload_mbps=15, ping_ms=20, latency_down_ms=520, latency_up_ms=300)
        user = get_user_model().objects.create_user('sq_admin', password='x', role='superadmin')
        kinds = [f['kind'] for f in check_report(report, user)['findings']]
        self.assertIn('loaded_latency', kinds)
