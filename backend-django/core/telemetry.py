"""
Crowdsourced network-telemetry ingestion — the backend half of the pilot
in samples/nepal_telecom_network_planning_brief_2.docx. Receives batched
samples from the provided `netplanning-telemetry-sdk` Android module and
stores them for coverage analysis.

Everything here follows the brief's "Data governance" bar as a hard
requirement, not a policy afterthought:
  * data minimisation — only the SDK's defined metric set is accepted;
    any extra keys in a sample are ignored, and there is deliberately no
    field for IMEI / Android-ID / MSISDN;
  * idempotency — the SDK re-POSTs the same batch on any non-2xx, so a
    content hash (TelemetryBatch) makes a retry a no-op rather than a
    duplicate;
  * rate limiting — per ingest key, against the Django cache;
  * retention — NOT here: enforced automatically by
    core/management/commands/prune_telemetry.py (aggregate-then-drop).

Auth is a SEPARATE mechanism from the partner ApiKey / `/api/external/v1/`
surface (explicit decision) — see TelemetryIngestKey in models.py.
"""
import hashlib
import io
import json
import secrets
from datetime import datetime, timezone as dt_timezone

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import TelemetryBatch, TelemetryIngestKey, _point_or_none

# The SDK batches at 200 (UploadWorker.BATCH_SIZE); accept a generous
# multiple so a client that batches differently still works, but cap it so
# one request can't be unbounded.
MAX_SAMPLES_PER_REQUEST = 2000
KEY_PREFIX_LEN = 12  # hex chars of the full key kept in the clear for lookup


# ── Pseudonymous key generation / verification ─────────────────────────

def generate_ingest_key():
    """Returns (full_key, prefix, key_hash). Full key is shown once."""
    raw = secrets.token_hex(24)
    full = f'tel_{raw}'
    prefix = raw[:KEY_PREFIX_LEN]
    return full, prefix, hashlib.sha256(full.encode()).hexdigest()


def _key_from_request(request):
    """`Authorization: Bearer <key>` (what the SDK's TelemetryApi.kt
    sends) or `X-API-Key: <key>`. Returns the raw key string or None."""
    auth = request.META.get('HTTP_AUTHORIZATION', '')
    if auth.lower().startswith('bearer '):
        return auth[7:].strip()
    return request.META.get('HTTP_X_API_KEY') or None


def _resolve_key(raw):
    """Look the key up by its non-secret prefix, verify the full hash,
    check active/expiry. Returns the TelemetryIngestKey or None."""
    if not raw or not raw.startswith('tel_'):
        return None
    body = raw[4:]
    if len(body) < KEY_PREFIX_LEN:
        return None
    try:
        obj = TelemetryIngestKey.objects.get(key_prefix=body[:KEY_PREFIX_LEN], is_active=True)
    except TelemetryIngestKey.DoesNotExist:
        return None
    if not secrets.compare_digest(obj.key_hash, hashlib.sha256(raw.encode()).hexdigest()):
        return None
    if obj.expires_at and obj.expires_at < timezone.now():
        return None
    return obj


# ── Geohash (pure Python, no dependency) ───────────────────────────────

_GH32 = '0123456789bcdefghjkmnpqrstuvwxyz'


def geohash_encode(lat, lng, precision=7):
    """Standard geohash. Precision 7 ≈ 153 m x 153 m — the coverage-bin
    resolution the retention job aggregates raw points down to."""
    lat_lo, lat_hi, lng_lo, lng_hi = -90.0, 90.0, -180.0, 180.0
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lng_lo + lng_hi) / 2
            if lng >= mid:
                ch = (ch << 1) | 1
                lng_lo = mid
            else:
                ch <<= 1
                lng_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat >= mid:
                ch = (ch << 1) | 1
                lat_lo = mid
            else:
                ch <<= 1
                lat_hi = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(_GH32[ch])
            bit, ch = 0, 0
    return ''.join(out)


def geohash_center(gh):
    """Centre (lat, lng) of a geohash cell — for a bin's map marker."""
    lat_lo, lat_hi, lng_lo, lng_hi = -90.0, 90.0, -180.0, 180.0
    even = True
    for c in gh:
        cd = _GH32.index(c)
        for mask in (16, 8, 4, 2, 1):
            if even:
                mid = (lng_lo + lng_hi) / 2
                if cd & mask:
                    lng_lo = mid
                else:
                    lng_hi = mid
            else:
                mid = (lat_lo + lat_hi) / 2
                if cd & mask:
                    lat_lo = mid
                else:
                    lat_hi = mid
            even = not even
    return (lat_lo + lat_hi) / 2, (lng_lo + lng_hi) / 2


# ── Per-sample coercion (fast, fixed shape — same posture as the DT
#    _coerce_dt_sample path) ─────────────────────────────────────────────

_NET_TYPES = {'LTE', 'NR', 'UMTS', 'GSM', 'UNKNOWN'}
_TRIGGERS = {'periodic', 'handover', 'manual'}


def _f(v):
    if v is None or v == '':
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x and x not in (float('inf'), float('-inf')) else None


def _i16(v):
    x = _f(v)
    if x is None:
        return None
    x = int(x)
    return x if -32768 <= x <= 32767 else None


def _int(v):
    x = _f(v)
    return int(x) if x is not None else None


def hash_device_id(raw):
    """One-way, salted hash of whatever `device_id` a client sent, so the
    stored value can never be a recoverable subscriber identifier even if
    a misconfigured client put an MSISDN / IMEI there instead of the SDK's
    pseudonymous UUID. Stable per device (same input -> same output) so
    distinct-device counts still work; not reversible without the salt
    (settings.TELEMETRY_DEVICE_ID_SALT). See that setting's comment."""
    return hashlib.sha256(
        (settings.TELEMETRY_DEVICE_ID_SALT + '::' + raw).encode()
    ).hexdigest()[:32]


def _scope_by_operator(queryset, user, field='mnc'):
    """Restricts `queryset` to `user.operator_mncs` when set — the access
    control behind "an operator's own staff only see their own
    subscribers' data" (User.operator_mncs' docstring, core/models.py).
    An empty operator_mncs (the default; also every NTA/government-style
    unrestricted account) means no filter at all: unrestricted access
    across every operator, matching "if used by NTA or government, fetch
    data on any mobile operator." Shared by telemetry_admin.py's Coverage/
    Stats/Live-samples/Drive-test views and rescue.py's RescueLookupView so
    the same rule applies everywhere data actually leaves the anonymous
    pipeline, rather than each endpoint reimplementing it slightly
    differently."""
    mncs = getattr(user, 'operator_mncs', None)
    if not mncs:
        return queryset
    return queryset.filter(**{f'{field}__in': mncs})


def coerce_sample(raw, received_at):
    """One SDK Sample.kt JSON object -> a dict of TelemetrySample column
    values. Requires `device_id` and `ts`; everything else degrades to
    NULL rather than rejecting the sample (a batch of 200 shouldn't fail
    on one bad optional field). `lon` is read as `lng`. `device_id` is
    replaced by hash_device_id() before storage."""
    if not isinstance(raw, dict):
        raise serializers.ValidationError('each sample must be a JSON object')
    raw_device_id = str(raw.get('device_id') or '').strip()
    if not raw_device_id:
        raise serializers.ValidationError('sample missing device_id')
    device_id = hash_device_id(raw_device_id)
    ts_ms = raw.get('ts')
    try:
        ts = datetime.fromtimestamp(float(ts_ms) / 1000.0, tz=dt_timezone.utc)
    except (TypeError, ValueError):
        raise serializers.ValidationError('sample missing or invalid ts (epoch ms)')

    lat, lng = _f(raw.get('lat')), _f(raw.get('lon'))
    nt = str(raw.get('network_type') or 'UNKNOWN').upper()
    tr = str(raw.get('trigger_reason') or 'periodic').lower()
    return {
        'device_id': device_id,
        'ts': ts,
        'received_at': received_at,
        'lat': lat,
        'lng': lng,
        'gps_accuracy_m': _f(raw.get('gps_accuracy_m')),
        'cell_id': _int(raw.get('cell_id')),
        'pci': _int(raw.get('pci')),
        'tac': _int(raw.get('tac')),
        'mcc': (str(raw.get('mcc') or ''))[:6],
        'mnc': (str(raw.get('mnc') or ''))[:6],
        'network_type': nt if nt in _NET_TYPES else 'UNKNOWN',
        'rsrp_dbm': _i16(raw.get('rsrp_dbm')),
        'rsrq_db': _i16(raw.get('rsrq_db')),
        'rssi_dbm': _i16(raw.get('rssi_dbm')),
        'sinr_db': _i16(raw.get('sinr_db')),
        # rx_qual (GSM RxQual 0-7) / rscp_dbm & ecio_db (WCDMA) -- see
        # models.py's TelemetrySample field comment for what these are and
        # why RSRP/RSRQ/SINR/RSSI alone aren't enough for 2G/3G.
        'rx_qual': _i16(raw.get('rx_qual')),
        'rscp_dbm': _i16(raw.get('rscp_dbm')),
        'ecio_db': _i16(raw.get('ecio_db')),
        'battery_pct': _i16(raw.get('battery_pct')),
        'trigger_reason': tr if tr in _TRIGGERS else 'periodic',
        'region': '',
    }


# ── COPY bulk insert (same pattern as _bulk_insert_dt_samples) ─────────

_COPY_COLS = (
    'device_id', 'ts', 'received_at', 'lat', 'lng', 'location', 'gps_accuracy_m',
    'cell_id', 'pci', 'tac', 'mcc', 'mnc', 'network_type',
    'rsrp_dbm', 'rsrq_db', 'rssi_dbm', 'sinr_db', 'rx_qual', 'rscp_dbm', 'ecio_db',
    'battery_pct', 'trigger_reason', 'region',
)
_COPY_SQL = 'COPY v2_telemetry_samples (' + ', '.join(_COPY_COLS) + ') FROM STDIN WITH (FORMAT text)'


def _cf(v):
    if v is None:
        return r'\N'
    if isinstance(v, str):
        return v.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n').replace('\r', '\\r')
    return str(v)


def _upsert_rescue_locations(rows):
    """Opportunistic last-known-location update for the rescue-beacon lane
    (core/rescue.py) — runs after every accepted ingest batch, but reads
    and writes at most the handful of rows in THIS batch whose device is
    already enrolled+consented (core/rescue.py's RescueEnrollView), never
    the anonymous majority. One indexed IN-lookup to find which of this
    batch's (already-hashed) device_ids are enrolled, then one small
    per-device UPDATE for its most recent in-batch fix — negligible cost
    against a batch of up to MAX_SAMPLES_PER_REQUEST rows where
    enrollment is expected to be a tiny fraction of total devices, and
    zero cost (one empty-result query) for a batch with no enrolled
    devices at all, which is the overwhelmingly common case.

    Deliberately a plain `.update()` per matching device rather than a
    `.save()` per row or a bulk_update — SubscriberLastLocation isn't on
    GeoSyncQuerySet, so `last_location` is set explicitly here to keep it
    in sync with `last_lat`/`last_lng` exactly like TelemetrySample.save()
    does for the anonymous pipeline."""
    # Local import: avoids a module-import cycle (core.rescue imports
    # from this module) and keeps this rescue-specific branch visually
    # separate from the hot anonymous-ingest path above it.
    from .models import RescueConsentPolicy, SubscriberLastLocation

    device_ids = {r['device_id'] for r in rows}
    if not device_ids:
        return

    qs = SubscriberLastLocation.objects.filter(device_id__in=device_ids)
    policy = RescueConsentPolicy.objects.filter(pk=1).first()
    if policy and policy.is_optional_active():
        # Emergency override (RescueConsentPolicy.docstring): keep every
        # already-enrolled device's location fresh regardless of its
        # current rescue_consent value, not just the consenting ones —
        # this can only ever affect a device that has SOME enrollment
        # record on file (an msisdn was set at some point); it never
        # starts tracking a device that never went through
        # RescueEnrollView at all.
        qs = qs.exclude(msisdn__isnull=True).exclude(msisdn='')
    else:
        qs = qs.filter(rescue_consent=True)
    enrolled = set(qs.values_list('device_id', flat=True))
    if not enrolled:
        return

    latest = {}
    for r in rows:
        if r['device_id'] not in enrolled or r['lat'] is None or r['lng'] is None:
            continue
        prev = latest.get(r['device_id'])
        if prev is None or r['ts'] > prev['ts']:
            latest[r['device_id']] = r

    for device_id, r in latest.items():
        SubscriberLastLocation.objects.filter(device_id=device_id).update(
            last_lat=r['lat'],
            last_lng=r['lng'],
            last_location=_point_or_none(r['lat'], r['lng']),
            last_accuracy_m=r['gps_accuracy_m'],
            last_source='gps',
            last_seen_ts=r['ts'],
            # mnc/mcc from this same in-batch sample — lets RescueLookupView
            # apply the same operator scoping (User.operator_mncs /
            # _scope_by_operator) every other telemetry endpoint gets.
            last_mnc=r['mnc'],
            last_mcc=r['mcc'],
        )


def bulk_insert_samples(rows):
    if not rows:
        return
    buf = io.StringIO()
    for r in rows:
        lat, lng = r['lat'], r['lng']
        loc = f'SRID=4326;POINT({lng} {lat})' if (lat is not None and lng is not None) else None
        # Column order must match _COPY_COLS exactly.
        buf.write('\t'.join((
            _cf(r['device_id']), _cf(r['ts'].isoformat()), _cf(r['received_at'].isoformat()),
            _cf(lat), _cf(lng), _cf(loc), _cf(r['gps_accuracy_m']),
            _cf(r['cell_id']), _cf(r['pci']), _cf(r['tac']), _cf(r['mcc']), _cf(r['mnc']),
            _cf(r['network_type']),
            _cf(r['rsrp_dbm']), _cf(r['rsrq_db']), _cf(r['rssi_dbm']), _cf(r['sinr_db']),
            _cf(r['rx_qual']), _cf(r['rscp_dbm']), _cf(r['ecio_db']),
            _cf(r['battery_pct']), _cf(r['trigger_reason']), _cf(r['region']),
        )) + '\n')
    buf.seek(0)
    with connection.cursor() as cur:
        cur.copy_expert(_COPY_SQL, buf)


def _check_and_fulfill_remote_optout(device_ids):
    """Checks whether any device in this ingest batch has a pending
    TelemetryRemoteOptOutRequest, and if so marks it fulfilled and tells
    the caller to relay `opt_out: true` in the ingest response. One
    ingest batch is always a single device's own upload in practice (the
    SDK only ever uploads its own local queue) — `device_ids` is a set
    purely as a defensive measure, not because multi-device batches are
    expected. One extra indexed lookup per batch, negligible cost, and
    zero cost (an empty IN-query match) for the overwhelming majority of
    devices that have never had an opt-out requested."""
    # Local import: same reasoning as _upsert_rescue_locations's imports.
    from .models import TelemetryRemoteOptOutRequest

    pending = list(
        TelemetryRemoteOptOutRequest.objects
        .filter(device_id__in=device_ids, fulfilled_at__isnull=True)
    )
    if not pending:
        return False
    now = timezone.now()
    for req in pending:
        req.fulfilled_at = now
    TelemetryRemoteOptOutRequest.objects.bulk_update(pending, ['fulfilled_at'])
    return True


# ── Endpoints ─────────────────────────────────────────────────────────

class TelemetryIngestView(APIView):
    """`POST /api/telemetry/v1/samples/` — a JSON array of SDK Sample.kt
    objects. `Authorization: Bearer <tel_key>` (or `X-API-Key`).

    Responses:
      * 202 {"accepted": N, "opt_out": bool}     — batch stored; `opt_out`
        is true only when a superadmin/admin left a pending
        TelemetryRemoteOptOutRequest for this device (see that model and
        core/telemetry_admin.py's "End & opt out" action) — the SDK's
        UploadWorker calls NetTelemetry.optOut() locally when it sees this.
        This is the ONLY channel that exists for the backend to affect a
        device's local opt-in state; it can request, never directly set it.
      * 200 {"accepted": 0, "duplicate": true}   — identical batch already seen
      * 401 / 403 / 413 / 429 as appropriate
    """
    authentication_classes = []
    permission_classes = [AllowAny]  # this endpoint does its own key check

    def post(self, request):
        key = _resolve_key(_key_from_request(request))
        if key is None:
            return Response({'detail': 'invalid or missing telemetry ingest key'},
                            status=status.HTTP_401_UNAUTHORIZED)

        # Rate limit: batches/min per key, in the shared cache.
        bucket = f'tel:rl:{key.key_prefix}:{int(timezone.now().timestamp() // 60)}'
        try:
            n = cache.incr(bucket)
        except ValueError:
            cache.set(bucket, 1, timeout=120)
            n = 1
        if n > key.rate_limit_per_min:
            return Response({'detail': 'rate limit exceeded'},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)

        payload = request.data
        if not isinstance(payload, list):
            return Response({'detail': 'body must be a JSON array of samples'},
                            status=status.HTTP_400_BAD_REQUEST)
        if not payload:
            return Response({'accepted': 0}, status=status.HTTP_202_ACCEPTED)
        if len(payload) > MAX_SAMPLES_PER_REQUEST:
            return Response({'detail': f'max {MAX_SAMPLES_PER_REQUEST} samples per request'},
                            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        # Idempotency: hash the canonical (device_id, ts) content of the
        # batch. A WorkManager retry re-sends the exact same list.
        digest = hashlib.sha256(
            json.dumps(
                sorted((str(s.get('device_id')), s.get('ts')) for s in payload if isinstance(s, dict)),
                separators=(',', ':'), default=str,
            ).encode()
        ).hexdigest()

        now = timezone.now()
        try:
            rows = [coerce_sample(s, now) for s in payload]
        except serializers.ValidationError as e:
            return Response({'detail': e.detail}, status=status.HTTP_400_BAD_REQUEST)

        _batch, created = TelemetryBatch.objects.get_or_create(
            batch_hash=digest,
            defaults={
                'key_prefix': key.key_prefix,
                'device_count': len({r['device_id'] for r in rows}),
                'sample_count': len(rows),
            },
        )
        if not created:
            return Response({'accepted': 0, 'duplicate': True}, status=status.HTTP_200_OK)

        bulk_insert_samples(rows)
        _upsert_rescue_locations(rows)

        TelemetryIngestKey.objects.filter(pk=key.pk).update(last_used_at=now)
        opt_out = _check_and_fulfill_remote_optout({r['device_id'] for r in rows})
        return Response({'accepted': len(rows), 'opt_out': opt_out}, status=status.HTTP_202_ACCEPTED)


class TelemetryHealthView(APIView):
    """`GET /api/telemetry/v1/health/` — unauthenticated liveness probe
    for the SDK / ops, so a client can confirm the endpoint is reachable
    before it starts queueing uploads against a dead URL."""
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({'status': 'ok', 'service': 'telemetry-ingest', 'time': timezone.now().isoformat()})
