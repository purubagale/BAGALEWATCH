"""Collection sessions and device identity (2026-10-05).

Every collection gets a CollectionSession with a source:
  * drive sessions from the app's Map tab, tagged crowd_drive, or staff_drive
    when the device is declared as an employee;
  * operator traces, tagged operator_investigation or operator_case, created
    when the device accepts the trace.

Background samples with no drive session are kept as plain samples, not
sessions, as designed.

Identity (MSISDN, IMEI, model) lives in DeviceIdentity and is never copied
into the sample tables. See core/device_identity.py for who can read it.
"""
import hashlib
import hmac
from collections import Counter

from django.conf import settings
from django.db.models import F
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .access import PERM_VIEW_IDENTITY, CanViewDrives, user_has
from .mfa import decrypt_secret, encrypt_secret
from .models import CollectionSession, DeviceIdentity


def msisdn_lookup_key(msisdn):
    """Keyed hash of a normalised MSISDN, for searching without decrypting.
    Keyed with the telemetry salt so the value can't be reversed by guessing
    numbers without the server's secret."""
    key = (settings.TELEMETRY_DEVICE_ID_SALT + '::msisdn').encode()
    return hmac.new(key, msisdn.encode(), hashlib.sha256).hexdigest()


def upsert_identity(device_hash, *, msisdn=None, imei=None, phone_model=None,
                    manufacturer=None, user_type=None):
    """Store or update one device's identity. Each argument is optional, so a
    partial upload only changes the fields it sends. An empty string clears
    that field."""
    identity, _ = DeviceIdentity.objects.get_or_create(device_hash=device_hash)
    if msisdn is not None:
        identity.msisdn_enc = encrypt_secret(msisdn) if msisdn else ''
        identity.msisdn_lookup = msisdn_lookup_key(msisdn) if msisdn else ''
    if imei is not None:
        identity.imei_enc = encrypt_secret(imei) if imei else ''
    if phone_model is not None:
        identity.phone_model = phone_model[:80]
    if manufacturer is not None:
        identity.manufacturer = manufacturer[:80]
    if user_type in (DeviceIdentity.USER_GENERAL, DeviceIdentity.USER_EMPLOYEE):
        identity.user_type = user_type
    identity.save()
    return identity


def decrypted_identity(identity):
    """The readable form of a DeviceIdentity. Only the identity views call this,
    and only after the permission check and audit entry."""
    return {
        'device_hash': identity.device_hash,
        'msisdn': decrypt_secret(identity.msisdn_enc) if identity.msisdn_enc else None,
        'imei': decrypt_secret(identity.imei_enc) if identity.imei_enc else None,
        'phone_model': identity.phone_model or None,
        'manufacturer': identity.manufacturer or None,
        'user_type': identity.user_type,
        'updated_at': identity.updated_at,
    }


def record_collection_sessions(rows):
    """Called by ingest after samples are stored. Groups the batch's drive
    samples by drive_session_id and bumps each session's count, creating the
    session the first time it's seen. Background samples are skipped."""
    counts = Counter()
    for row in rows:
        dsid = row.get('drive_session_id')
        if dsid:
            counts[(row['device_id'], dsid)] += 1
    if not counts:
        return

    now = timezone.now()
    device_hashes = {device_hash for device_hash, _ in counts}
    user_types = dict(
        DeviceIdentity.objects.filter(device_hash__in=device_hashes).values_list('device_hash', 'user_type')
    )
    for (device_hash, dsid), n in counts.items():
        user_type = user_types.get(device_hash, DeviceIdentity.USER_GENERAL)
        source = (
            CollectionSession.SOURCE_STAFF_DRIVE
            if user_type == DeviceIdentity.USER_EMPLOYEE
            else CollectionSession.SOURCE_CROWD_DRIVE
        )
        session, _ = CollectionSession.objects.get_or_create(
            drive_session_id=dsid,
            defaults={
                'source': source,
                'device_hash': device_hash,
                'user_type': user_type,
                'started_at': now,
            },
        )
        CollectionSession.objects.filter(pk=session.pk).update(
            sample_count=F('sample_count') + n,
            last_sample_at=now,
        )


def close_trace_session(trace):
    """Records when a trace's session ended. Called wherever a trace reaches a
    terminal state: completed, cancelled, stopped by the user, or expired."""
    CollectionSession.objects.filter(trace=trace, ended_at__isnull=True).update(
        ended_at=trace.ended_at or timezone.now(),
    )


def ensure_trace_session(trace):
    """One CollectionSession per accepted trace. Called when the device
    accepts (or a policy bypass creates an accepted trace)."""
    from .models import TraceRequest

    source = (
        CollectionSession.SOURCE_CASE if trace.kind == TraceRequest.KIND_CASE
        else CollectionSession.SOURCE_INVESTIGATION
    )
    session, _ = CollectionSession.objects.get_or_create(
        trace=trace,
        defaults={
            'source': source,
            'device_hash': trace.device.device_hash,
            'user_type': DeviceIdentity.objects.filter(device_hash=trace.device.device_hash)
                .values_list('user_type', flat=True).first() or DeviceIdentity.USER_GENERAL,
            'started_at': trace.consent_at or timezone.now(),
        },
    )
    return session


class CollectionSessionListView(APIView):
    """`GET /api/v2/collection-sessions/?source=...&limit=50` -- needs
    drive.view. The device hash is included only for users who also hold
    device.view_identity, so drive viewers see sessions without identity."""
    permission_classes = [IsAuthenticated, CanViewDrives]

    def get(self, request):
        qs = CollectionSession.objects.all()
        source = (request.query_params.get('source') or '').strip()
        if source:
            qs = qs.filter(source=source)
        try:
            limit = max(1, min(int(request.query_params.get('limit', 50)), 200))
        except (TypeError, ValueError):
            limit = 50
        can_see_identity = user_has(request.user, PERM_VIEW_IDENTITY)
        rows = []
        for s in qs[:limit]:
            row = {
                'id': str(s.id),
                'source': s.source,
                'drive_session_id': s.drive_session_id,
                'trace_id': str(s.trace_id) if s.trace_id else None,
                'user_type': s.user_type,
                'sample_count': s.sample_count,
                'started_at': s.started_at,
                'last_sample_at': s.last_sample_at,
                'ended_at': s.ended_at,
            }
            if can_see_identity:
                row['device_hash'] = s.device_hash or None
            rows.append(row)
        return Response({'results': rows}, status=status.HTTP_200_OK)
