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
from collections import Counter

from django.db.models import Count, Max, Min, Q
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .collection import decrypted_identity, msisdn_lookup_key
from .emergency import active_emergency
from .models import (
    AuditEvent, CallContextSample, CollectionSession, DeviceCredential, DeviceIdentity, DeviceLocationTraceLog,
    ProblemReport, RescueLocationAccessLog, SitePhoto, SubscriberDevice, SubscriberLastLocation,
    TelemetryDriveTestConsent, TelemetryDriveTestSession, TelemetryPushToken, TelemetrySample,
    Site, TelemetrySpeedResult, TraceLocationSample, TraceRequest, TraceSpeedResult, VolteCallSample,
)
from .rescue import _clean_msisdn
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
        links = list(SubscriberDevice.objects.filter(msisdn=canonical).order_by('-last_seen_at', '-last_linked_at'))
        credentials = list(DeviceCredential.objects.filter(msisdn__in=variants).order_by('-created_at'))
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
        ids = sorted(ids)
        withdrawn = {r.device_id for r in rescue_rows if not r.rescue_consent}
        if credentials:
            withdrawn |= {c.device_hash for c in credentials if c.sdk_device_hash in withdrawn}

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
        last = (TelemetrySample.objects.filter(device_id__in=[i for i in ids if i not in withdrawn])
                .order_by('-ts').first())
        last_location = None
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
                'mcc': last.mcc,
                'gps_accuracy_m': last.gps_accuracy_m,
                'trigger_reason': last.trigger_reason,
                # Exact position only while an emergency is declared.
                'lat': last.lat if emergency else None,
                'lng': last.lng if emergency else None,
            }
            # The serving site is a mast, not the customer: its position is
            # always shown, so the card can draw it on a map.
            site = Site.objects.filter(id=last.serving_site_id).values('name', 'district', 'lat', 'lng').first() \
                if last.serving_site_id else None
            if site:
                last_location.update(site_name=site['name'] or None, site_district=site['district'] or None,
                                     site_lat=site['lat'], site_lng=site['lng'])
        consented_rescue = [r for r in rescue_rows if r.rescue_consent and r.last_seen_ts]
        if emergency and consented_rescue:
            r = max(consented_rescue, key=lambda x: x.last_seen_ts)
            if last_location is None or (last_location['ts'] or '') < r.last_seen_ts.isoformat():
                last_location = {'source': 'rescue', 'ts': _iso(r.last_seen_ts), 'lat': r.last_lat, 'lng': r.last_lng}

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

        # ── Sessions ──────────────────────────────────────────────────────
        collections = [{
            'id': str(s.id), 'source': s.source, 'device_id': s.device_hash, 'samples': s.sample_count,
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
        lookups += [{'tool': 'Subscriber Profile', 'by': e.actor_username or None, 'at': _iso(e.created_at),
                     'reference': e.detail, 'found': None}
                    for e in AuditEvent.objects.filter(action=AUDIT_ACTION, resource_id=canonical)
                    .order_by('-created_at')[:20]]
        lookups.sort(key=lambda x: x['at'] or '', reverse=True)

        found = bool(devices or credentials or rescue_rows or traces)
        return Response({
            'msisdn': canonical,
            'found': found,
            'emergency_declared': emergency is not None,
            'summary': {
                'devices': len({d['device_id'] for d in devices}),
                'registered': bool(credentials),
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
