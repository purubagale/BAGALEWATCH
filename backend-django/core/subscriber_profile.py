"""Subscriber profile (2026-10-15): everything the server already holds about
one mobile number, for NTC staff solving a customer's problem.

Superadmin only. Every search needs a reason (ticket or case reference) and
is written to the audit log; the profile also lists who has looked the
number up before, here and in the two location lookups.

Nothing is fetched from the phone or the network: only rows already stored.

A number reaches its devices through every path that records one:
SubscriberDevice links (rescue enrolment, registration, identity upload, the
SDK link), DeviceCredential (registration, stored as typed, so all spellings
of the number are tried), SubscriberLastLocation (rescue) and DeviceIdentity
(the number the phone reported itself). Readings, tests and sessions are then
gathered for every device id of those phones.

Location follows the rules the location lookups already have (agreed when
they were built): the last serving cell, network and signal are always shown,
the exact coordinates only while an emergency is declared, and nothing about
location for a phone whose owner withdrew rescue consent.
"""
import uuid
from collections import Counter
from datetime import timedelta

from django.db.models import Count, Max, Min, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import radio_band
from .audit import log_audit_event
from .collection import NEPAL_TZ, decrypted_identity, msisdn_lookup_key
from .cqi import sample_cqi_fields
from .emergency import active_emergency
from .models import (
    AuditEvent, CallContextSample, CollectionSession, DeviceCredential, DeviceIdentity, DeviceLocationTraceLog,
    ProblemReport, RescueLocationAccessLog, SecuritySettings, SitePhoto, SubscriberDevice, SubscriberLastLocation,
    TelemetryDriveTestConsent, TelemetryDriveTestSession, TelemetryPushToken, TelemetrySample,
    Site, TelemetrySpeedResult, TraceLocationSample, TraceRequest, TraceSpeedResult, VolteCallSample,
)
from .operators import operator_name
from .rescue import _clean_msisdn
from .serving_site_lookup import lookup_serving_site
from .subscriber_analytics import profile_analytics
from .telemetry_status import status_of
from .views import IsSuperadminOnly

AUDIT_ACTION = 'SUBSCRIBER_PROFILE.VIEWED'
LIST_CAP = 50
# Readings drawn in the signal chart.
SERIES_CAP = 300


def number_variants(canonical):
    """Every spelling of a canonical number found in tables that keep it as
    typed: 9779851113656, +9779851113656 and 9851113656."""
    out = {canonical, '+' + canonical}
    if canonical.startswith('977') and len(canonical) > 3:
        out.add(canonical[3:])
    return sorted(out)


def _mask_imei(imei):
    imei = (imei or '').strip()
    return ('•' * (len(imei) - 4) + imei[-4:]) if len(imei) > 4 else imei


def _iso(value):
    return value.isoformat() if value else None


def _describe_phones(devices, by_link, credentials):
    """What each id is, in plain words, and which ids are the same phone
    (2026-10-16). One phone shows up several times: its registration key
    (Registered Devices lists only these), the app install that holds the
    readings, an earlier install linked by hand after a reinstall, and an
    older registration key a re-registration replaced.

    Sets on each device: `role` (registration, app_install, earlier_install,
    rescue, identity), `phone_key` (the phone's hardware fingerprint, else its
    make and model) and, on a registration key, `replaced_at` when a newer
    registration from the same phone exists."""
    for d in devices:
        link = by_link.get(d['device_id'])
        model = ' '.join(filter(None, [d['manufacturer'], d['phone_model']])).strip().lower()
        d['phone_key'] = (link and link.hardware_hash) or model or d['device_id']
        if d['kind'] == 'registration key':
            d['role'] = 'registration'
        elif 'manual_link' in d['linked_via']:
            d['role'] = 'earlier_install'
        elif d['kind'] in ('app', 'app (linked to registration)'):
            d['role'] = 'rescue' if d['rescue_beacon'] and not d['readings'] else 'app_install'
        else:
            d['role'] = 'identity'
        d['replaced_at'] = None
    # A manually linked earlier install of an unknown model is most likely
    # the same phone when the number has only one.
    keys = {d['phone_key'] for d in devices if d['role'] != 'earlier_install'}
    if len(keys) == 1:
        only = next(iter(keys))
        for d in devices:
            if d['role'] == 'earlier_install' and not (d['manufacturer'] or d['phone_model']):
                d['phone_key'] = only
    created = {c.device_hash: c.created_at for c in credentials}
    regs = [d for d in devices if d['role'] == 'registration' and d['device_id'] in created]
    for d in regs:
        newer = [created[o['device_id']] for o in regs
                 if o['phone_key'] == d['phone_key'] and created[o['device_id']] > created[d['device_id']]]
        if newer:
            d['replaced_at'] = _iso(min(newer))


COMPLAINT_AUDIT_ACTION = 'SUBSCRIBER_PROFILE.COMPLAINT_LOCATION'


def complaint_windows(canonical, credentials):
    """Time windows whose exact positions may be shown for the customer's own
    complaint (2026-10-16): off unless a superadmin turns it on (Security
    page). Each problem report from this number in the last N days opens
    [reported - H hours, reported + H hours]. Returns [(start, end, report_id)]."""
    from django.utils import timezone
    cfg = SecuritySettings.objects.filter(pk=1).first()
    if not cfg or not cfg.complaint_location_access:
        return []
    since = timezone.now() - timedelta(days=cfg.complaint_location_days)
    reports = ProblemReport.objects.filter(
        Q(device__in=credentials) | Q(msisdn__in=number_variants(canonical)), happened_at__gte=since,
    ).values_list('id', 'happened_at')
    span = timedelta(hours=cfg.complaint_location_hours)
    return [(at - span, at + span, rid) for rid, at in reports]


def _in_windows(ts, windows):
    """The report id whose window holds this time, or None."""
    for start, end, rid in windows:
        if start <= ts <= end:
            return rid
    return None


def devices_of_number(canonical):
    """Every device id tied to one number, and those whose location must stay
    hidden. Shared by the profile and its signal history so both apply the
    same rules: "verified numbers only" (2026-10-15) leaves out phones that
    only typed this number, and a withdrawn rescue consent hides a phone's
    readings from the history and its position everywhere."""
    variants = number_variants(canonical)
    links = list(SubscriberDevice.objects.filter(msisdn=canonical).order_by('-last_seen_at', '-last_linked_at'))
    credentials = list(DeviceCredential.objects.filter(msisdn__in=variants).order_by('-created_at'))
    unproven_claims = 0
    if SecuritySettings.objects.filter(pk=1, phone_verification_required=True).exists():
        proven = (SubscriberDevice.VERIFIED_SMS, SubscriberDevice.VERIFIED_SIM)
        kept_links = [link for link in links if link.number_verified_by in proven]
        kept_creds = [c for c in credentials if c.msisdn_verified_at]
        unproven_claims = len({link.device_hash for link in links} - {link.device_hash for link in kept_links}) \
            + len(credentials) - len(kept_creds)
        links, credentials = kept_links, kept_creds
    rescue_rows = list(SubscriberLastLocation.objects.filter(msisdn__in=variants))
    identities = list(DeviceIdentity.objects.filter(
        Q(msisdn_lookup=msisdn_lookup_key(canonical))
        | Q(device_hash__in=[link.device_hash for link in links])
        | Q(device_hash__in=[c.device_hash for c in credentials])
    ))
    ids = set()
    ids.update(link.device_hash for link in links)
    for c in credentials:
        ids.add(c.device_hash)
        if c.sdk_device_hash:
            ids.add(c.sdk_device_hash)
    ids.update(r.device_id for r in rescue_rows)
    ids.update(i.device_hash for i in identities)
    withdrawn = {r.device_id for r in rescue_rows if not r.rescue_consent}
    if credentials:
        withdrawn |= {c.device_hash for c in credentials if c.sdk_device_hash in withdrawn}
    return {
        'links': links, 'credentials': credentials, 'rescue_rows': rescue_rows, 'identities': identities,
        'ids': sorted(ids), 'withdrawn': withdrawn, 'unproven_claims': unproven_claims,
    }


class SubscriberProfileView(APIView):
    """`GET /api/v2/subscriber-profile/?msisdn=<number>&reason=<ticket>`."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        canonical = _clean_msisdn(request.query_params.get('msisdn'))
        reason = (request.query_params.get('reason') or '').strip()[:200]
        if not canonical:
            return Response({'detail': 'Enter a valid mobile number.'}, status=status.HTTP_400_BAD_REQUEST)
        if not reason:
            return Response({'detail': 'Enter the ticket or case reference for this search.'},
                            status=status.HTTP_400_BAD_REQUEST)
        variants = number_variants(canonical)
        log_audit_event(request, AUDIT_ACTION, resource='subscriber_profile', resource_id=canonical, detail=reason)

        # ── Devices of this number ────────────────────────────────────────
        found_devices = devices_of_number(canonical)
        links, credentials = found_devices['links'], found_devices['credentials']
        rescue_rows, identities = found_devices['rescue_rows'], found_devices['identities']
        ids, withdrawn = found_devices['ids'], found_devices['withdrawn']
        unproven_claims = found_devices['unproven_claims']

        # ── Readings per device id ────────────────────────────────────────
        reading_stats = {
            row['device_id']: row for row in TelemetrySample.objects.filter(device_id__in=ids)
            .values('device_id').annotate(n=Count('id'), first=Min('ts'), last=Max('ts'))
        }
        networks = Counter(dict(
            TelemetrySample.objects.filter(device_id__in=ids).values_list('network_type')
            .annotate(n=Count('id')).values_list('network_type', 'n')
        ))
        on_demand = TelemetrySample.objects.filter(device_id__in=ids, trigger_reason='on_demand').count()

        emergency = active_emergency()
        windows = [] if emergency else complaint_windows(canonical, credentials)
        last = (TelemetrySample.objects.filter(device_id__in=[i for i in ids if i not in withdrawn])
                .order_by('-ts').first())
        last_location = None
        complaint_report = _in_windows(last.ts, windows) if last is not None and last.lat is not None else None
        if complaint_report:
            log_audit_event(request, COMPLAINT_AUDIT_ACTION, resource='problem_report',
                            resource_id=str(complaint_report), detail=f'{canonical} | {reason} | last location')
        if last is not None:
            last_location = {
                'source': 'reading',
                'ts': _iso(last.ts),
                'network_type': last.network_type,
                'band_mhz': last.band_mhz,
                'cell_id': last.cell_id,
                'pci': last.pci,
                'tac': last.tac,
                'mnc': last.mnc,
                'level_dbm': last.rsrp_dbm if last.rsrp_dbm is not None else (
                    last.rscp_dbm if last.rscp_dbm is not None else last.rssi_dbm),
                'serving_site_id': last.serving_site_id or None,
                'serving_cell_name': last.serving_cell_name or None,
                'serving_dist_km': last.serving_dist_km,
                'serving_sector': last.serving_sector or None,
                # The full reading (2026-10-15), shown on the location card.
                'device_id': last.device_id,
                'rsrq_db': last.rsrq_db,
                'sinr_db': last.sinr_db,
                'cqi': last.cqi,
                'rscp_dbm': last.rscp_dbm,
                'ecio_db': last.ecio_db,
                'rssi_dbm': last.rssi_dbm,
                'arfcn': last.arfcn,
                'band': last.band,
                'bandwidth_label': radio_band.bandwidth_label(
                    last.bandwidth_khz, last.total_bandwidth_khz, last.carrier_count) or None,
                'mcc': last.mcc,
                'operator': operator_name(last.mcc, last.mnc),
                'gps_accuracy_m': last.gps_accuracy_m,
                'trigger_reason': last.trigger_reason,
                # Exact position only while an emergency is declared, or
                # (when switched on) near the customer's own complaint.
                'lat': last.lat if (emergency or complaint_report) else None,
                'lng': last.lng if (emergency or complaint_report) else None,
            }
            # A reading stored without a serving site (2026-10-19): matched now
            # with the same rule, else the newest reading that has one, so the
            # card names the site and sector the phone was last attached to.
            if not last.serving_site_id:
                found_site = lookup_serving_site(
                    last.network_type, cell_id=last.cell_id, pci=last.pci, psc=last.scrambling_code,
                    bcch=last.bcch, bsic=last.bsic, lat=last.lat, lon=last.lng, tac=last.tac)
                if found_site:
                    last_location.update(
                        serving_site_id=found_site['site_id'], serving_sector=found_site['sector'],
                        serving_cell_name=found_site['cell_name'],
                        serving_dist_km=(found_site['distance_m'] / 1000 if found_site['distance_m'] is not None
                                         else None),
                        serving_site_basis='matched_now')
                else:
                    attached = (TelemetrySample.objects
                                .filter(device_id__in=[i for i in ids if i not in withdrawn])
                                .exclude(serving_site_id='').exclude(serving_site_id__isnull=True)
                                .order_by('-ts').values('ts', 'serving_site_id', 'serving_sector',
                                                        'serving_cell_name', 'serving_dist_km').first())
                    if attached:
                        last_location.update(
                            serving_site_id=attached['serving_site_id'],
                            serving_sector=attached['serving_sector'] or None,
                            serving_cell_name=attached['serving_cell_name'] or None,
                            serving_dist_km=attached['serving_dist_km'],
                            serving_site_basis='earlier', serving_site_ts=_iso(attached['ts']))
            # The serving site is a mast, not the customer: its position is
            # always shown, so the card can draw it on a map.
            site_id = last_location.get('serving_site_id')
            site = Site.objects.filter(id=site_id).values('name', 'district', 'lat', 'lng').first() \
                if site_id else None
            if site:
                last_location.update(site_name=site['name'] or None, site_district=site['district'] or None,
                                     site_lat=site['lat'], site_lng=site['lng'])
        consented_rescue = [r for r in rescue_rows if r.rescue_consent and r.last_seen_ts]
        if emergency and consented_rescue:
            r = max(consented_rescue, key=lambda x: x.last_seen_ts)
            if last_location is None or (last_location['ts'] or '') < r.last_seen_ts.isoformat():
                last_location = {'source': 'rescue', 'ts': _iso(r.last_seen_ts), 'lat': r.last_lat, 'lng': r.last_lng}
        # Why the card may show no position (2026-10-15): hidden because no
        # emergency is declared, or simply not in the record (a reading taken
        # without a GPS fix, a rescue beacon that has not reported one). In an
        # emergency the newest reading that does carry a position is offered.
        if last_location is not None:
            last_location['position_withheld'] = not emergency and not complaint_report
            last_location['position_basis'] = ('emergency' if emergency else
                                               'complaint' if complaint_report else None)
            last_location['complaint_report_id'] = complaint_report
            if emergency and last_location.get('lat') is None:
                fix = (TelemetrySample.objects.filter(device_id__in=[i for i in ids if i not in withdrawn],
                                                      lat__isnull=False, lng__isnull=False)
                       .order_by('-ts').values('ts', 'lat', 'lng', 'gps_accuracy_m').first())
                if fix:
                    last_location['earlier_position'] = {
                        'ts': _iso(fix['ts']), 'lat': fix['lat'], 'lng': fix['lng'],
                        'gps_accuracy_m': fix['gps_accuracy_m']}

        # Signal history for the chart (2026-10-15): level and quality over
        # time from the newest readings, without positions.
        series_qs = (TelemetrySample.objects.filter(device_id__in=[i for i in ids if i not in withdrawn])
                     .order_by('-ts').values('ts', 'network_type', 'rsrp_dbm', 'rscp_dbm', 'rssi_dbm', 'rsrq_db', 'sinr_db')[:SERIES_CAP])
        signal_series = [{
            'ts': _iso(r['ts']), 'network_type': r['network_type'],
            'level_dbm': r['rsrp_dbm'] if r['rsrp_dbm'] is not None else (
                r['rscp_dbm'] if r['rscp_dbm'] is not None else r['rssi_dbm']),
            'rsrq_db': r['rsrq_db'], 'sinr_db': r['sinr_db'],
        } for r in series_qs][::-1]

        # ── Devices, one row per device id ────────────────────────────────
        by_cred = {c.device_hash: c for c in credentials}
        by_cred_sdk = {c.sdk_device_hash: c for c in credentials if c.sdk_device_hash}
        by_link = {link.device_hash: link for link in links}
        by_identity = {i.device_hash: i for i in identities}
        by_rescue = {r.device_id: r for r in rescue_rows}
        push = set(TelemetryPushToken.objects.filter(device_id__in=ids).values_list('device_id', flat=True))
        dt_consent = {c.device_id: c for c in TelemetryDriveTestConsent.objects.filter(device_id__in=ids)}
        devices = []
        for device_id in ids:
            link, cred, identity = by_link.get(device_id), by_cred.get(device_id), by_identity.get(device_id)
            rescue, stats = by_rescue.get(device_id), reading_stats.get(device_id)
            ident = decrypted_identity(identity) if identity else {}
            devices.append({
                'device_id': device_id,
                'kind': ('registration key' if cred else
                         'app (linked to registration)' if device_id in by_cred_sdk else
                         'app' if (rescue or stats) else 'identity'),
                'manufacturer': (link and link.manufacturer) or (identity and identity.manufacturer) or None,
                'phone_model': (link and link.phone_model) or (identity and identity.phone_model) or None,
                'app_version': (link and link.app_version) or (cred and cred.app_version) or None,
                'user_type': identity.user_type if identity else None,
                'imei': _mask_imei(ident.get('imei')) or None,
                'linked_via': list(link.linked_via) if link else [],
                'link_ended': _iso(link.ended_at) if link else None,
                'first_linked_at': _iso(link.first_linked_at) if link else None,
                'last_seen_at': _iso(link.last_seen_at) if link else None,
                'registered_at': _iso(cred.created_at) if cred else None,
                'registration_last_seen_at': _iso(cred.last_seen_at) if cred else None,
                'registration_revoked_at': _iso(cred.revoked_at) if cred else None,
                'registered_as': cred.msisdn if cred else None,
                # Proved by SMS code (or read from the SIM), 2026-10-15.
                'number_verified': bool((cred and cred.msisdn_verified_at) or (link and link.number_verified_by in (
                    SubscriberDevice.VERIFIED_SMS, SubscriberDevice.VERIFIED_SIM))),
                'signed_uploads_linked': bool(cred and cred.sdk_device_hash),
                'push_token': device_id in push or bool(cred and cred.fcm_token),
                'rescue_beacon': (None if not rescue else 'on' if rescue.rescue_consent else 'withdrawn'),
                'rescue_since': _iso(rescue.rescue_consent_at) if rescue else None,
                'drive_test_consent': (None if device_id not in dt_consent
                                       else 'yes' if dt_consent[device_id].consent else 'no'),
                'readings': stats['n'] if stats else 0,
                'first_reading': _iso(stats['first']) if stats else None,
                'last_reading': _iso(stats['last']) if stats else None,
            })
        devices.sort(key=lambda d: d['last_reading'] or d['registered_at'] or '', reverse=True)
        _describe_phones(devices, by_link, credentials)

        # ── Sessions ──────────────────────────────────────────────────────
        collections = [{
            'id': str(s.id), 'source': s.source, 'device_id': s.device_hash, 'samples': s.sample_count,
            'name': s.name or None, 'district': s.district or None,
            'started_at': _iso(s.started_at), 'last_sample_at': _iso(s.last_sample_at), 'ended_at': _iso(s.ended_at),
        } for s in CollectionSession.objects.filter(device_hash__in=ids).order_by('-started_at')[:LIST_CAP]]
        dt_filter = Q()
        for device_id in ids:
            dt_filter |= Q(device_ids__contains=[device_id])
        drive_test_sessions = [] if not ids else [{
            'id': s.id, 'name': s.name, 'status': s.status, 'started_at': _iso(s.started_at),
            'ended_at': _iso(s.ended_at), 'devices': len(s.device_ids or []),
        } for s in TelemetryDriveTestSession.objects.filter(dt_filter).order_by('-started_at')[:LIST_CAP]]
        traces = list(TraceRequest.objects.filter(Q(msisdn__in=variants) | Q(device__in=credentials))
                      .select_related('requested_by').order_by('-created_at')[:LIST_CAP])
        trace_requests = [{
            'id': str(t.id), 'kind': t.kind, 'status': t.status, 'case_reference': t.case_reference,
            'requested_by': t.requested_by.username if t.requested_by else None,
            'created_at': _iso(t.created_at), 'ended_at': _iso(t.ended_at),
            'positions': TraceLocationSample.objects.filter(trace=t).count(),
        } for t in traces]

        # ── Tests and reports ─────────────────────────────────────────────
        speed_tests = [{
            'ts': _iso(r.ts), 'device_id': r.device_id, 'bearer': r.bearer, 'download_mbps': r.download_mbps,
            'upload_mbps': r.upload_mbps, 'ping_ms': r.ping_median_ms, 'jitter_ms': r.jitter_ms,
            'packet_loss_pct': r.packet_loss_pct, 'network_type': r.network_type, 'rsrp_dbm': r.rsrp_dbm,
        } for r in TelemetrySpeedResult.objects.filter(device_id__in=ids).order_by('-ts')[:LIST_CAP]]
        trace_speed_tests = [{
            'ts': _iso(r.ran_at), 'trace_id': str(r.trace_id), 'download_mbps': r.download_mbps,
            'upload_mbps': r.upload_mbps, 'ping_ms': r.ping_median_ms, 'network_type': r.network_type,
        } for r in TraceSpeedResult.objects.filter(trace__in=traces).order_by('-ran_at')[:LIST_CAP]]
        problem_reports = [{
            'id': p.id, 'category': p.category, 'status': p.status, 'happened_at': _iso(p.happened_at),
            'network_type': p.network_type, 'level_dbm': p.level_dbm, 'download_mbps': p.download_mbps,
            'note': p.note[:200],
            # From the app, or from a linked NTC system that sent the number (2026-10-15).
            'source': p.source, 'external_system': p.external_system, 'external_ref': p.external_ref,
            'cause': p.cause,
        } for p in ProblemReport.objects.filter(Q(device__in=credentials) | Q(msisdn__in=variants))
            .order_by('-happened_at')[:LIST_CAP]]
        call_qs = CallContextSample.objects.filter(device_id__in=ids)
        calls = {
            'by_outcome': dict(Counter(call_qs.values_list('outcome', flat=True))),
            'latest': [{
                'started_at': _iso(c.started_at), 'duration_s': c.duration_s, 'outcome': c.outcome,
                'voice_networks': c.voice_networks, 'cell_id': c.cell_id, 'level_dbm': c.level_dbm,
            } for c in call_qs.order_by('-started_at')[:20]],
        }
        volte = [{
            'ts': _iso(v.ts), 'codec': v.codec, 'mos_estimate': v.mos_estimate, 'packet_loss_pct': v.packet_loss_pct,
        } for v in VolteCallSample.objects.filter(device_id__in=ids).order_by('-ts')[:20]]
        photos = [{
            'id': p.id, 'site_id': p.site_id, 'status': p.status, 'taken_at': _iso(p.taken_at),
        } for p in SitePhoto.objects.filter(Q(device__in=credentials) | Q(uploader_msisdn__in=variants))
            .order_by('-taken_at')[:LIST_CAP]]

        # ── Who has looked this number up ─────────────────────────────────
        lookups = [{'tool': 'Device Location Trace', 'by': l.looked_up_by.username if l.looked_up_by else None,
                    'at': _iso(l.queried_at), 'reference': l.case_reference, 'found': l.found}
                   for l in DeviceLocationTraceLog.objects.filter(query_type='msisdn', query_value__in=variants)
                   .select_related('looked_up_by').order_by('-queried_at')[:20]]
        lookups += [{'tool': 'Rescue Lookup', 'by': l.looked_up_by.username if l.looked_up_by else None,
                     'at': _iso(l.queried_at), 'reference': l.case_reference, 'found': l.found}
                    for l in RescueLocationAccessLog.objects.filter(msisdn_queried__in=variants)
                    .select_related('looked_up_by').order_by('-queried_at')[:20]]
        lookups += [{'tool': 'Subscriber Network Diagnosis', 'by': e.actor_username or None, 'at': _iso(e.created_at),
                     'reference': e.detail, 'found': None}
                    for e in AuditEvent.objects.filter(action=AUDIT_ACTION, resource_id=canonical)
                    .order_by('-created_at')[:20]]
        lookups.sort(key=lambda x: x['at'] or '', reverse=True)

        found = bool(devices or credentials or rescue_rows or traces)
        return Response({
            'msisdn': canonical,
            'found': found,
            'emergency_declared': emergency is not None,
            # Exact positions near this customer's own complaints (2026-10-16, off by default).
            'complaint_windows': [{'report_id': rid, 'from': _iso(a), 'to': _iso(b)} for a, b, rid in windows],
            'summary': {
                'devices': len({d['device_id'] for d in devices}),
                # Physical phones (2026-10-16): one phone carries several ids
                # (registration keys, app installs), see _describe_phones.
                'phones': len({d['phone_key'] for d in devices}),
                'registered': bool(credentials),
                # Phones left out because they only typed this number (verified-only mode).
                'unproven_claims': unproven_claims,
                'first_registered_at': _iso(min((c.created_at for c in credentials), default=None)),
                'rescue_beacon': ('on' if any(r.rescue_consent for r in rescue_rows)
                                  else 'withdrawn' if rescue_rows else None),
                'readings': sum(s['n'] for s in reading_stats.values()),
                'first_reading': _iso(min((s['first'] for s in reading_stats.values()), default=None)),
                'last_reading': _iso(max((s['last'] for s in reading_stats.values()), default=None)),
                'readings_by_network': dict(networks),
                'on_demand_readings': on_demand,
                'location_hidden': bool(withdrawn),
            },
            'last_location': last_location,
            'signal_series': signal_series,
            # Cells and sites served, shares, daily trend, histograms (2026-10-16).
            'analytics': profile_analytics([i for i in ids if i not in withdrawn], include_location=emergency is not None),
            'devices': devices,
            'collections': collections,
            'drive_test_sessions': drive_test_sessions,
            'trace_requests': trace_requests,
            'speed_tests': speed_tests,
            'trace_speed_tests': trace_speed_tests,
            'problem_reports': problem_reports,
            'calls': calls,
            'volte': volte,
            'site_photos': photos,
            'lookups': lookups[:30],
        })


SIGNAL_AUDIT_ACTION = 'SUBSCRIBER_PROFILE.SIGNAL'
# Readings in one signal-history answer: the newest 300 by default, at most
# this many for "all" or one session (newest first when there are more).
SIGNAL_MAX = 5000
_TECH_NETWORKS = {'4G': ('LTE', 'NR'), '3G': ('UMTS',), '2G': ('GSM',)}
_SPANS = {'day': timedelta(days=1), 'week': timedelta(days=7), 'month': timedelta(days=30)}


class SubscriberSignalView(APIView):
    """`GET /api/v2/subscriber-profile/signal/?msisdn=&reason=&range=&session=&tech=`
    (2026-10-16): the readings behind the profile's signal history, each with
    every measure, its cell and serving site.

    `range` is `newest` (300, the default), `all` (up to SIGNAL_MAX) or
    `session` with `session=collection:<id>` or `session=drive:<id>`, or
    `day` / `week` / `month` (the last span of readings, up to SIGNAL_MAX); `tech`
    is 4G, 3G or 2G. Same rules as the profile: superadmin, a reason, logged;
    phones with withdrawn rescue consent left out; the exact position of a
    reading only while an emergency is declared. Serving sites are masts and
    are always given, so the map can show where the phone was served from.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        canonical = _clean_msisdn(request.query_params.get('msisdn'))
        reason = (request.query_params.get('reason') or '').strip()[:200]
        if not canonical or not reason:
            return Response({'detail': 'A valid number and a reference are needed.'},
                            status=status.HTTP_400_BAD_REQUEST)
        scope = request.query_params.get('range') or 'newest'
        tech = request.query_params.get('tech') or ''
        session = request.query_params.get('session') or ''
        if scope not in ('newest', 'all', 'session', *_SPANS) or (tech and tech not in _TECH_NETWORKS):
            return Response({'detail': 'Unknown range or technology.'}, status=status.HTTP_400_BAD_REQUEST)

        found = devices_of_number(canonical)
        ids = [i for i in found['ids'] if i not in found['withdrawn']]
        qs = TelemetrySample.objects.filter(device_id__in=ids)
        if tech:
            qs = qs.filter(network_type__in=_TECH_NETWORKS[tech])
        # The last day / week / month of readings (2026-10-19), counted back
        # from the newest reading, so an old record still shows something.
        if scope in _SPANS:
            newest = qs.aggregate(m=Max('ts'))['m']
            if newest is not None:
                qs = qs.filter(ts__gte=newest - _SPANS[scope])

        session_label = None
        if scope == 'session':
            kind, _, key = session.partition(':')
            if kind == 'collection':
                s = CollectionSession.objects.filter(pk=key if _is_uuid(key) else None, device_hash__in=ids).first()
                if s is None:
                    return Response({'detail': 'That session is not one of this number.'},
                                    status=status.HTTP_404_NOT_FOUND)
                if s.drive_session_id:
                    qs = qs.filter(drive_session_id=s.drive_session_id)
                else:
                    end = s.ended_at or s.last_sample_at
                    qs = qs.filter(device_id=s.device_hash, ts__gte=s.started_at, **({'ts__lte': end} if end else {}))
                session_label = f'{s.source} from {s.started_at:%Y-%m-%d %H:%M}'
            elif kind == 'period':
                # A stretch of readings with no session tag (2026-10-19): old
                # app builds shared without one; split where the phone went quiet.
                start, _, end = key.partition('|')
                a, b = parse_datetime(start), parse_datetime(end)
                if a is None or b is None:
                    return Response({'detail': 'Choose a session.'}, status=status.HTTP_400_BAD_REQUEST)
                qs = qs.filter(Q(drive_session_id='') | Q(drive_session_id__isnull=True), ts__gte=a, ts__lte=b)
                session_label = f'Sharing from {timezone.localtime(a, NEPAL_TZ):%Y-%m-%d %H:%M}'
            elif kind == 'drive' and key.isdigit():
                s = TelemetryDriveTestSession.objects.filter(pk=int(key)).first()
                mine = [d for d in (s.device_ids or []) if d in ids] if s else []
                if not mine:
                    return Response({'detail': 'That session is not one of this number.'},
                                    status=status.HTTP_404_NOT_FOUND)
                qs = qs.filter(device_id__in=mine, ts__gte=s.started_at, **({'ts__lte': s.ended_at} if s.ended_at else {}))
                session_label = s.name
            else:
                return Response({'detail': 'Choose a session.'}, status=status.HTTP_400_BAD_REQUEST)

        log_audit_event(request, SIGNAL_AUDIT_ACTION, resource='subscriber_profile', resource_id=canonical,
                        detail=f'{reason} | {scope}{" " + session if session else ""}{" " + tech if tech else ""}')

        total = qs.count()
        limit = SERIES_CAP if scope == 'newest' else SIGNAL_MAX
        rows = list(qs.order_by('-ts').values(
            'ts', 'device_id', 'network_type', 'rsrp_dbm', 'rsrq_db', 'sinr_db', 'cqi', 'rscp_dbm', 'ecio_db',
            'rssi_dbm', 'rx_qual', 'pci', 'cell_id', 'tac', 'arfcn', 'band', 'band_mhz', 'trigger_reason',
            'serving_site_id', 'serving_sector', 'serving_dist_km', 'gps_accuracy_m', 'lat', 'lng',
            'received_at', 'service_state', 'cell_info_status', 'airplane_mode', 'sim_state',
            'environment', 'environment_source', 'bandwidth_khz', 'total_bandwidth_khz', 'carrier_count',
        )[:limit])[::-1]

        emergency = active_emergency() is not None
        windows = [] if emergency else complaint_windows(canonical, found['credentials'])
        released = set()
        points = []
        for r in rows:
            report = _in_windows(r['ts'], windows) if windows else None
            show = emergency or report is not None
            if report is not None and r['lat'] is not None:
                released.add(report)
            cqi = sample_cqi_fields(r['cqi'], r['sinr_db'], r['rsrq_db'], r['network_type'])
            level = r['rsrp_dbm'] if r['network_type'] in ('LTE', 'NR') else (
                r['rscp_dbm'] if r['network_type'] == 'UMTS' else r['rssi_dbm'] if r['network_type'] == 'GSM'
                else r['rsrp_dbm'])
            points.append({
                'ts': _iso(r['ts']), 'device_id': r['device_id'], 'network_type': r['network_type'],
                'level_dbm': level, 'rsrq_db': r['rsrq_db'], 'sinr_db': r['sinr_db'],
                'cqi': cqi['cqi_value'], 'cqi_source': cqi['cqi_source'],
                'ecio_db': r['ecio_db'], 'rx_qual': r['rx_qual'],
                'pci': r['pci'], 'cell_id': r['cell_id'], 'tac': r['tac'],
                'band_label': radio_band.label(r['network_type'], r['band'], r['band_mhz']) or None,
                'bandwidth_label': radio_band.bandwidth_label(
                    r['bandwidth_khz'], r['total_bandwidth_khz'], r['carrier_count']) or None,
                'trigger_reason': r['trigger_reason'],
                'serving_site_id': r['serving_site_id'] or None, 'serving_sector': r['serving_sector'] or None,
                'serving_dist_km': r['serving_dist_km'],
                'has_position': r['lat'] is not None and r['lng'] is not None,
                'lat': r['lat'] if show else None, 'lng': r['lng'] if show else None,
                'gps_accuracy_m': r['gps_accuracy_m'] if show else None,
                # The problem report whose window released this position.
                'complaint_report_id': report,
                # What a reading without a network means (2026-10-26,
                # core/telemetry_status.py), and how late it reached the server.
                'status': status_of(r['network_type'], r['lat'], r['service_state'], r['cell_info_status'],
                                    r['airplane_mode'], r['sim_state']),
                'status_reason': r['cell_info_status'] or r['service_state'] or None,
                'delay_s': int((r['received_at'] - r['ts']).total_seconds()) if r['received_at'] and r['ts'] else None,
                # Outdoors / indoors / in a vehicle and who said so (2026-10-26).
                'environment': r['environment'], 'environment_source': r['environment_source'],
            })
        for report in sorted(released):
            log_audit_event(request, COMPLAINT_AUDIT_ACTION, resource='problem_report', resource_id=str(report),
                            detail=f'{canonical} | {reason} | signal history')
        # The analysis cards follow this selection (2026-10-19): the same
        # readings, or for "newest" the span those readings cover.
        shown_qs = qs
        if scope == 'newest' and rows and total > len(rows):
            shown_qs = qs.filter(ts__gte=rows[0]['ts'])
        analytics = profile_analytics(ids, include_location=emergency, qs=shown_qs)

        site_ids = {p['serving_site_id'] for p in points if p['serving_site_id']}
        sites = {s['id']: {'name': s['name'] or None, 'lat': s['lat'], 'lng': s['lng']}
                 for s in Site.objects.filter(id__in=site_ids).values('id', 'name', 'lat', 'lng')}

        # The sessions this number has, for the range picker: its named
        # sessions, its Telemetry Drive Test sessions, and stretches of
        # untagged readings (2026-10-19).
        sessions = [{'key': f'collection:{c.id}',
                     'label': c.name or f'{c.source} · {timezone.localtime(c.started_at, NEPAL_TZ):%Y-%m-%d %H:%M}',
                     'readings': c.sample_count}
                    for c in CollectionSession.objects.filter(device_hash__in=ids).order_by('-started_at')[:LIST_CAP]]
        sessions += sharing_periods(ids)
        dt_filter = Q()
        for device_id in ids:
            dt_filter |= Q(device_ids__contains=[device_id])
        if ids:
            sessions += [{'key': f'drive:{d.id}', 'label': f'Drive test · {d.name}', 'readings': None}
                         for d in TelemetryDriveTestSession.objects.filter(dt_filter).order_by('-started_at')[:LIST_CAP]]

        return Response({
            'range': scope, 'tech': tech or None, 'session': session or None, 'session_label': session_label,
            'total': total, 'shown': len(points), 'limited': total > len(points),
            'positions_shown': emergency, 'points': points, 'sites': sites, 'sessions': sessions,
            'analytics': analytics,
            # Customer's own complaint (2026-10-16): the windows that release positions.
            'complaint_windows': [{'report_id': rid, 'from': _iso(a), 'to': _iso(b)} for a, b, rid in windows],
        })


PERIOD_GAP = timedelta(minutes=30)
PERIODS_MAX = 40


def sharing_periods(ids):
    """Stretches of readings without a session tag, split wherever the phone
    sent nothing for PERIOD_GAP, newest first, as picker entries named like
    the sessions: "<district> · Sharing · <start>"."""
    from .collection import district_at
    rows = list(TelemetrySample.objects.filter(device_id__in=ids)
                .filter(Q(drive_session_id='') | Q(drive_session_id__isnull=True))
                .order_by('ts').values('ts', 'serving_site_id', 'lat', 'lng')[:SIGNAL_MAX * 4])
    periods, current = [], []
    for r in rows:
        if current and r['ts'] - current[-1]['ts'] > PERIOD_GAP:
            periods.append(current)
            current = []
        current.append(r)
    if current:
        periods.append(current)
    out = []
    for p in reversed(periods[-PERIODS_MAX:]):
        a, b = p[0]['ts'], p[-1]['ts']
        la, lb = timezone.localtime(a, NEPAL_TZ), timezone.localtime(b, NEPAL_TZ)
        district = district_at(p[:50])
        out.append({'key': f'period:{a.isoformat()}|{b.isoformat()}',
                    'label': f'{district or "Unknown area"} · Sharing · {la:%Y-%m-%d %H:%M}'
                             f'–{lb:%H:%M}' if la.date() == lb.date() else
                             f'{district or "Unknown area"} · Sharing · {la:%Y-%m-%d %H:%M}–{lb:%Y-%m-%d %H:%M}',
                    'readings': len(p)})
    return out


def _is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False
