"""
python manage.py shared_key_usage [--days 60]

Read-only (audit 2026-10-23). Before retiring the shared app key
(TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL) or the shared-key rescue enrolment,
shows who still depends on them: phones that sent readings in the period
and are not linked to a signed registration, registered phones and how many
proved their number by SMS, and rescue beacons with consent on.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.models import DeviceCredential, SubscriberLastLocation, TelemetrySample


class Command(BaseCommand):
    help = 'How many phones still rely on the shared app key (read-only).'

    def add_arguments(self, parser):
        parser.add_argument('--days', type=int, default=60)

    def handle(self, *args, **options):
        since = timezone.now() - timedelta(days=options['days'])
        active = set(TelemetrySample.objects.filter(received_at__gte=since)
                     .values_list('device_id', flat=True).distinct())
        live = DeviceCredential.objects.filter(revoked_at__isnull=True)
        signed = set(live.exclude(sdk_device_hash__isnull=True).exclude(sdk_device_hash='')
                     .values_list('sdk_device_hash', flat=True))
        beacons = SubscriberLastLocation.objects.filter(rescue_consent=True)
        w = self.stdout.write
        w(f'Phones that sent readings in the last {options["days"]} days: {len(active)}')
        w(f'  linked to a signed registration (keep working after a cut-off): {len(active & signed)}')
        w(f'  shared key only (would stop sharing after a cut-off): {len(active - signed)}')
        w(f'Registered phones: {live.count()}, number proved by SMS: {live.filter(msisdn_verified_at__isnull=False).count()}')
        w(f'Rescue beacons with consent on: {beacons.count()}, '
          f'of them on a registered phone: {beacons.filter(device_id__in=signed).count()}')
