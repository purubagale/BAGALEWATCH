"""Superadmin device-location trace (2026-10-08).

A DELIBERATE, acknowledged exception to this app's core privacy posture:
core/models.py's SubscriberLastLocation docstring states that table is
"never joined against TelemetrySample." This tool does exactly that,
cross-referencing DeviceIdentity (an MSISDN/IMEI a device uploaded as
part of its own identity -- core/collection.py's upsert_identity, from
the crowd/staff identity upload) to that device's latest position in the
regular anonymous telemetry pipeline. It exists as a second, separate
feature alongside Rescue Lookup, not a replacement for it or an extension
of its consent/case-reference model -- see DeviceLocationTraceLog's own
docstring for why this gets its own audit table instead of reusing
RescueLocationAccessLog, and why it is superadmin-only (a materially
higher bar than IsRescueOperator, the same tier as declaring an
emergency or the Rescue Enrolled Devices list).

Since 2026-10-08 it works only while an emergency is declared
(core/emergency.py) and every search needs a case reference. It was built
for search and rescue after the Bhotekoshi flood, and reads positions with
no consent from the device's owner, so it stays off outside a disaster.
"""
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .collection import imei_lookup_key
from .emergency import active_emergency
from .models import (
    DeviceIdentity, DeviceLocationTraceLog, SubscriberDevice, SubscriberLastLocation, TelemetrySample,
    TraceLocationSample,
)
from .rescue import _clean_msisdn
from .subscriber_device import describe, devices_for_msisdn
from .views import IsSuperadminOnly

TRACE_OFF_DETAIL = 'Device Location Trace is off. A superadmin must declare an emergency to turn it on.'

SOURCE_TELEMETRY = 'telemetry'      # a regular shared signal sample
SOURCE_RESCUE = 'rescue_enrolment'  # the rescue beacon's stored last position
SOURCE_TRACE = 'trace'              # a sample from an accepted trace request


LINK_IDENTITY = SubscriberDevice.VIA_IDENTITY


def _device_position(device_hash, rescue_row):
    """Newest GPS position of ONE device, from its regular telemetry
    samples, its rescue record and its accepted-trace samples. Returns
    (best, sources): `best` is a dict or None, `sources` the newest
    position time each store holds for this device."""
    candidates = []
    s = (
        TelemetrySample.objects.filter(device_id=device_hash)
        .exclude(lat__isnull=True).exclude(lng__isnull=True)
        .order_by('-ts').first()
    )
    if s:
        candidates.append({
            'source': SOURCE_TELEMETRY, 'device_hash': device_hash, 'lat': s.lat, 'lng': s.lng,
            'ts': s.ts, 'accuracy_m': s.gps_accuracy_m, 'network_type': s.network_type,
        })
    r = rescue_row
    if r is not None and r.last_lat is not None and r.last_lng is not None and r.last_seen_ts is not None:
        candidates.append({
            'source': SOURCE_RESCUE, 'device_hash': device_hash, 'lat': r.last_lat, 'lng': r.last_lng,
            'ts': r.last_seen_ts, 'accuracy_m': r.last_accuracy_m, 'network_type': None,
        })
    t = (
        TraceLocationSample.objects.filter(trace__device__device_hash=device_hash)
        .order_by('-ts').first()
    )
    if t:
        candidates.append({
            'source': SOURCE_TRACE, 'device_hash': device_hash, 'lat': t.lat, 'lng': t.lng,
            'ts': t.ts, 'accuracy_m': t.accuracy_m, 'network_type': t.network_type or None,
        })
    # Newest wins. On a tie the rescue record is kept: it is usually a copy
    # of that same shared sample and carries the fix type (gps / network).
    best = max(candidates, key=lambda c: (c['ts'], c['source'] == SOURCE_RESCUE)) if candidates else None
    newest = {c['source']: c['ts'] for c in candidates}
    sources = [{'source': name, 'ts': newest.get(name)} for name in (SOURCE_TELEMETRY, SOURCE_RESCUE, SOURCE_TRACE)]
    return best, sources


def _latest_position(msisdn, imei, only_devices=None):
    """The newest known position for a phone number or IMEI (2026-10-09).

    A number is resolved to its devices through ONE table,
    SubscriberDevice (core/subscriber_device.py), which every path that
    learns a number writes to: rescue enrolment, phone registration and
    identity upload. An IMEI resolves through DeviceIdentity, the only
    place one is stored.

    A number can be on more than one device (two handsets, or one phone
    seen under two device ids). Positions are never mixed across devices:
    each is worked out on its own (`_device_position`), every one is
    returned in `devices` with its make, model, how it is linked and when
    it last uploaded, and `best` is the device with the newest position.

    A device whose owner has withdrawn rescue consent is left out, the
    same rule the lookups have always applied, even during an emergency.

    `only_devices` limits the search to those device hashes. Rescue Lookup
    passes the devices that hold a consented rescue enrolment for the
    number, so it never returns a phone that did not enrol.

    Returns (best, sources, devices). `best` and `sources` describe the
    chosen device; `devices` lists every linked device, newest position
    first.
    """
    now = timezone.now()
    if msisdn:
        described = [describe(link, now) for link in devices_for_msisdn(msisdn)]
    else:
        hashes = list(
            DeviceIdentity.objects.filter(imei_lookup=imei_lookup_key(imei)).values_list('device_hash', flat=True)
        )
        by_hash = {}
        for link in SubscriberDevice.objects.filter(device_hash__in=hashes, ended_at__isnull=True):
            by_hash.setdefault(link.device_hash, describe(link, now))
        identities = {d.device_hash: d for d in DeviceIdentity.objects.filter(device_hash__in=hashes)}
        described = []
        for h in hashes:
            entry = by_hash.get(h) or {
                'device_hash': h, 'manufacturer': identities[h].manufacturer or None,
                'phone_model': identities[h].phone_model or None, 'app_version': None,
                'hardware_hash': '', 'linked_by': [LINK_IDENTITY], 'number_verified_by': None,
                'first_linked_at': None, 'last_seen_at': None, 'stale': True,
            }
            described.append(entry)

    # One PHONE can hold several device ids: the SDK's install id, the
    # registration key's id, and older ids left by a reinstall. Links that
    # share a hardware hash are folded into one phone here, so the operator
    # sees one entry with that phone's newest position, not two "devices".
    # A link with no hardware hash (older app builds) stays on its own.
    phones = {}
    for entry in described:
        key = entry['hardware_hash'] or 'device:' + entry['device_hash']
        phones.setdefault(key, []).append(entry)
    if only_devices is not None:
        phones = {k: group for k, group in phones.items() if any(d['device_hash'] in only_devices for d in group)}

    rescue_by_device = {
        r.device_id: r for r in SubscriberLastLocation.objects.filter(
            device_id__in=[d['device_hash'] for group in phones.values() for d in group], rescue_consent=True,
        )
    }
    devices = []
    for group in phones.values():
        best, sources, best_hash = None, None, None
        for entry in group:
            b, s = _device_position(entry['device_hash'], rescue_by_device.get(entry['device_hash']))
            if b is not None and (best is None or b['ts'] > best['ts']):
                best, sources, best_hash = b, s, entry['device_hash']
        if sources is None:
            sources = [{'source': name, 'ts': None} for name in (SOURCE_TELEMETRY, SOURCE_RESCUE, SOURCE_TRACE)]
        seen = [d['last_seen_at'] for d in group if d['last_seen_at']]
        first = [d['first_linked_at'] for d in group if d['first_linked_at']]
        devices.append({
            # The id that holds the newest position, else the most recently seen.
            'device_hash': best_hash or group[0]['device_hash'],
            'device_hashes': [d['device_hash'] for d in group],
            'manufacturer': next((d['manufacturer'] for d in group if d['manufacturer']), None),
            'phone_model': next((d['phone_model'] for d in group if d['phone_model']), None),
            'app_version': next((d['app_version'] for d in group if d['app_version']), None),
            'linked_by': sorted({via for d in group for via in d['linked_by']}),
            'number_verified_by': group[0]['number_verified_by'],
            'first_linked_at': min(first) if first else None,
            'last_seen_at': max(seen) if seen else None,
            'stale': all(d['stale'] for d in group),
            'best': best, 'sources': sources,
        })
    located = [d for d in devices if d['best'] is not None]
    located.sort(key=lambda d: d['best']['ts'], reverse=True)
    devices = located + [d for d in devices if d['best'] is None]
    if not located:
        empty = [{'source': name, 'ts': None} for name in (SOURCE_TELEMETRY, SOURCE_RESCUE, SOURCE_TRACE)]
        return None, empty, devices
    return located[0]['best'], located[0]['sources'], devices


class DeviceLocationTraceView(APIView):
    """`GET /api/v2/device-location-trace/?msisdn=...` or `?imei=...` --
    exactly one of the two. Resolves to a DeviceIdentity row by its keyed
    lookup hash (never by decrypting every row), then returns that
    device's most recent GPS-tagged TelemetrySample. No rescue-location
    consent required -- this reads whatever MSISDN/IMEI the device itself
    already uploaded as crowd/staff identity info, a separate and
    broader-reaching lane than Rescue Lookup's own consent-gated
    SubscriberLastLocation. Since 2026-10-08 it works only while an
    emergency is declared and needs `case_reference`. Every search is
    logged to DeviceLocationTraceLog and the audit log, whether or not it
    finds a match.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        # Usable only during a declared emergency, and only against a case
        # reference (2026-10-08). It reads positions with no consent from the
        # device's owner, so it is limited to the disaster it was built for.
        emergency = active_emergency()
        if emergency is None:
            return Response({'detail': TRACE_OFF_DETAIL}, status=status.HTTP_403_FORBIDDEN)
        case_reference = (request.query_params.get('case_reference') or '').strip()[:120]
        if not case_reference:
            return Response({'detail': 'A case reference is required'}, status=status.HTTP_400_BAD_REQUEST)

        msisdn_raw = (request.query_params.get('msisdn') or '').strip()
        imei_raw = (request.query_params.get('imei') or '').strip()
        if bool(msisdn_raw) == bool(imei_raw):
            return Response({'detail': 'Provide exactly one of msisdn or imei'}, status=status.HTTP_400_BAD_REQUEST)

        canonical = None
        if msisdn_raw:
            query_type, query_value = 'msisdn', msisdn_raw
            canonical = _clean_msisdn(msisdn_raw)
            if not canonical:
                return Response({'detail': 'Not a valid phone number'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            query_type, query_value = 'imei', imei_raw

        best, sources, linked = _latest_position(canonical, imei_raw)
        found = best is not None
        # Every device this number or IMEI is tied to, each with its own
        # newest position. More than one entry means two phones have used
        # it; the pin below is the first entry and never a blend.
        devices = [
            {
                **{k: v for k, v in d.items() if k not in ('best', 'sources')},
                'lat': d['best']['lat'] if d['best'] else None,
                'lng': d['best']['lng'] if d['best'] else None,
                'ts': d['best']['ts'] if d['best'] else None,
                'source': d['best']['source'] if d['best'] else None,
            }
            for d in linked
        ]
        DeviceLocationTraceLog.objects.create(
            looked_up_by=request.user, query_type=query_type, query_value=query_value[:32], found=found,
            case_reference=case_reference, emergency=emergency,
        )
        log_audit_event(
            request, 'DEVICE_LOCATION_TRACE.SEARCHED', resource='device_location_trace',
            payload={'case_reference': case_reference, 'query_type': query_type, 'found': found,
                     'emergency_id': emergency.id, 'devices_linked': len(devices)},
        )

        if not found:
            return Response({'found': False, 'sources': sources, 'devices': devices})
        return Response({
            'found': True,
            'device_hash': best['device_hash'],
            'lat': best['lat'],
            'lng': best['lng'],
            'accuracy_m': best['accuracy_m'],
            'network_type': best['network_type'],
            'ts': best['ts'],
            # Which store the position came from, and the newest time each
            # store held, so the operator can see why this one was chosen.
            'source': best['source'],
            'sources': sources,
            'devices': devices,
            'phone_model': devices[0]['phone_model'],
            'manufacturer': devices[0]['manufacturer'],
        })
