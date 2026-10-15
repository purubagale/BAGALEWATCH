"""Linking a phone's earlier readings to a number by hand (2026-10-15).

Readings are stored under the SDK's device id. A phone's id changes when the
app is uninstalled and installed again (for example to move from a test
build to the signed release), and an app built before 14 October never told
the server which SDK id was its own. Its earlier readings then belong to no
number, and the Subscriber Profile cannot show them. Nothing in a reading
names the phone, so the server cannot join them by itself.

A superadmin does it on the Subscriber Profile:

    GET    /api/v2/subscriber-profile/link-candidates/?msisdn=&reason=
    POST   /api/v2/subscriber-profile/link-device/   {msisdn, device_id, reason}
    DELETE /api/v2/subscriber-profile/link-device/   {msisdn, device_id, reason}

The candidates are device ids that are linked to no number and whose
readings in the last CANDIDATE_DAYS were taken in the same 500 m squares as
the readings of this number's known phones, the most overlap first. They
are a suggestion: the superadmin decides, and says why (the case
reference). A link made here is marked "linked by hand" on the profile,
counts as a typed (not proved) number, and is written to the Audit Log, as
is its removal.
"""
from datetime import timedelta

from django.db import connection
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .models import DeviceCredential, SubscriberDevice, SubscriberLastLocation
from .rescue import _clean_msisdn
from .subscriber_device import link_device, unlink_via
from .subscriber_profile import number_variants
from .views import IsSuperadminOnly

VIA_MANUAL = 'manual_link'
CANDIDATE_DAYS = 90
SQUARE_DEG = 0.005          # about 500 m
MAX_CANDIDATES = 10
MAX_SCANNED_DEVICES = 2000


def _known_ids(canonical):
    """Device ids this number already reaches (links, registrations, rescue)."""
    variants = number_variants(canonical)
    ids = set(SubscriberDevice.objects.filter(msisdn=canonical, ended_at__isnull=True)
              .values_list('device_hash', flat=True))
    for dev, sdk in DeviceCredential.objects.filter(msisdn__in=variants).values_list('device_hash', 'sdk_device_hash'):
        ids.update(i for i in (dev, sdk) if i)
    ids.update(SubscriberLastLocation.objects.filter(msisdn__in=variants).values_list('device_id', flat=True))
    return ids


def _squares(device_ids, since):
    """{device id: set of 500 m squares} for readings since `since`."""
    if not device_ids:
        return {}
    with connection.cursor() as cur:
        cur.execute(
            'SELECT DISTINCT device_id, floor(lat / %s)::int, floor(lng / %s)::int FROM v2_telemetry_samples '
            'WHERE device_id = ANY(%s) AND received_at >= %s AND lat IS NOT NULL AND lng IS NOT NULL',
            [SQUARE_DEG, SQUARE_DEG, list(device_ids), since])
        out = {}
        for dev, x, y in cur.fetchall():
            out.setdefault(dev, set()).add((x, y))
    return out


def candidates(canonical):
    since = timezone.now() - timedelta(days=CANDIDATE_DAYS)
    known = _known_ids(canonical)
    known_squares = set().union(*_squares(known, since).values()) if known else set()
    if not known_squares:
        return known, [], ('This number\'s phones have no readings with a position in the last '
                           f'{CANDIDATE_DAYS} days, so there is nothing to compare with. Once the phone has '
                           'shared some readings with the current app, try again.')
    # Ids linked to any number are someone's phone already; only unlinked ones are offered.
    linked_anywhere = set(SubscriberDevice.objects.filter(ended_at__isnull=True).values_list('device_hash', flat=True))
    linked_anywhere |= {h for pair in DeviceCredential.objects.values_list('device_hash', 'sdk_device_hash')
                        for h in pair if h}
    xs = sorted({x for x, _ in known_squares})
    ys = sorted({y for _, y in known_squares})
    with connection.cursor() as cur:
        cur.execute(
            'SELECT device_id, count(*), min(ts), max(ts) FROM v2_telemetry_samples '
            'WHERE received_at >= %s AND lat IS NOT NULL AND floor(lat / %s)::int = ANY(%s) '
            'AND floor(lng / %s)::int = ANY(%s) GROUP BY device_id ORDER BY count(*) DESC LIMIT %s',
            [since, SQUARE_DEG, xs, SQUARE_DEG, ys, MAX_SCANNED_DEVICES])
        rows = [r for r in cur.fetchall() if r[0] not in known and r[0] not in linked_anywhere]
    their = _squares({r[0] for r in rows}, since)
    out = []
    for dev, n, first, last in rows:
        sq = their.get(dev, set())
        shared = len(sq & known_squares)
        if not shared:
            continue
        out.append({
            'device_id': dev, 'readings': n,
            'first_reading': first.isoformat() if first else None,
            'last_reading': last.isoformat() if last else None,
            'squares': len(sq), 'shared_squares': shared,
            'overlap_pct': round(100.0 * shared / len(sq)) if sq else 0,
        })
    out.sort(key=lambda c: (-c['overlap_pct'], -c['shared_squares'], -c['readings']))
    return known, out[:MAX_CANDIDATES], ''


def _check(request, data):
    canonical = _clean_msisdn(str(data.get('msisdn') or ''))
    reason = str(data.get('reason') or '').strip()[:200]
    if not canonical:
        return None, None, Response({'detail': 'Enter a valid mobile number.'}, status=status.HTTP_400_BAD_REQUEST)
    if not reason:
        return None, None, Response({'detail': 'Give the ticket or case reference.'}, status=status.HTTP_400_BAD_REQUEST)
    return canonical, reason, None


class LinkCandidatesView(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        canonical, reason, error = _check(request, request.query_params)
        if error:
            return error
        known, found, note = candidates(canonical)
        log_audit_event(request, 'SUBSCRIBER_PROFILE.LINK_CANDIDATES', resource='subscriber_profile',
                        resource_id=canonical, detail=f'{reason}: {len(found)} candidate(s)')
        return Response({'msisdn': canonical, 'days': CANDIDATE_DAYS, 'known_devices': len(known),
                         'candidates': found, 'note': note})


class LinkDeviceView(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        canonical, reason, error = _check(request, data)
        if error:
            return error
        device_id = str(data.get('device_id') or '').strip()
        if not device_id or len(device_id) > 64:
            return Response({'detail': 'Choose a device.'}, status=status.HTTP_400_BAD_REQUEST)
        other = SubscriberDevice.objects.filter(device_hash=device_id, ended_at__isnull=True).exclude(msisdn=canonical)
        if other.exists():
            return Response({'detail': 'That device is already linked to another number.'},
                            status=status.HTTP_409_CONFLICT)
        link_device(canonical, device_id, VIA_MANUAL)
        log_audit_event(request, 'SUBSCRIBER_PROFILE.DEVICE_LINKED', resource='subscriber_profile',
                        resource_id=canonical, detail=f'{reason}: linked device {device_id[:10]}… by hand')
        return Response({'linked': True})

    def delete(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        canonical, reason, error = _check(request, data)
        if error:
            return error
        device_id = str(data.get('device_id') or '').strip()
        if not SubscriberDevice.objects.filter(msisdn=canonical, device_hash=device_id, ended_at__isnull=True,
                                               linked_via__contains=[VIA_MANUAL]).exists():
            return Response({'detail': 'No link made by hand for that device.'}, status=status.HTTP_404_NOT_FOUND)
        unlink_via(device_id, VIA_MANUAL)
        log_audit_event(request, 'SUBSCRIBER_PROFILE.DEVICE_UNLINKED', resource='subscriber_profile',
                        resource_id=canonical, detail=f'{reason}: removed hand link to {device_id[:10]}…')
        return Response({'linked': False})
