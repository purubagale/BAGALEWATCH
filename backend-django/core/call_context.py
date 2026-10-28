"""Phone calls as an ordinary app sees them (2026-10-14).

The call-quality lane (core/volte_quality.py) needs a carrier-privileged
app and has no data. This lane needs only READ_PHONE_STATE, which the app
already holds: for each call the phone sends the voice network it used
(sampled every few seconds), the data network just before the call, the
duration, and the serving cell and level at the start and end. No number,
no call direction, no audio figures.

From that the server tells whether a call stayed on VoLTE or fell back to
2G/3G (CSFB or SRVCC), which is an RF indicator per place and cell: calls
falling back where 4G is available point at VoLTE coverage or IMS issues.

Ingest: `POST /api/telemetry/v1/call-samples/`, same key or signed-device
auth as the sample batch, only sent while the user is sharing. Review:
`GET /api/v2/telemetry/call-samples/`, superadmin, on the VoLTE Quality page.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone as dt_timezone

from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .dt_serving_cell import sectors_by_cell_identity
from .models import CallContextSample
from .telemetry import _f, _int, _scope_by_operator, hash_device_id, ingest_row_device_id, resolve_ingest_caller
from .call_cells import name_calls
from .views import IsSuperadminOnly

MAX_CALLS_PER_REQUEST = 100
# A call longer than this is taken as a stuck call state, not a call.
MAX_DURATION_S = 6 * 3600

_FOURG = {'LTE', 'NR'}
_LEGACY = {'UMTS', 'HSPA', 'HSDPA', 'HSUPA', 'HSPAP', 'TD_SCDMA', 'GSM', 'EDGE', 'GPRS', 'CDMA', '1XRTT', 'EVDO'}
_NET_MAX = 12


def _net(v):
    return str(v or '').strip().upper()[:_NET_MAX]


def call_outcome(voice_networks, data_network_before):
    """`volte` when every voice reading was 4G/5G; `vowifi` on Wi-Fi calling;
    `fallback` when the call used 2G/3G voice while the phone was on 4G/5G
    just before, or started on 4G and moved down (CSFB or SRVCC); `legacy`
    when it was on 2G/3G before the call too (no 4G there to fall back
    from); else `unknown`."""
    seen = [n for n in voice_networks if n and n != 'UNKNOWN']
    if not seen:
        return 'unknown'
    if any(n == 'IWLAN' for n in seen) and not any(n in _LEGACY for n in seen):
        return 'vowifi'
    if all(n in _FOURG for n in seen):
        return 'volte'
    if any(n in _LEGACY for n in seen):
        if data_network_before in _FOURG or seen[0] in _FOURG:
            return 'fallback'
        return 'legacy'
    return 'unknown'


def _when(ms):
    try:
        return datetime.fromtimestamp(float(ms) / 1000.0, tz=dt_timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _coerce(raw, received_at):
    if not isinstance(raw, dict):
        return None
    device_id = str(raw.get('device_id') or '').strip()
    started_at = _when(raw.get('started_at'))
    ended_at = _when(raw.get('ended_at'))
    if not device_id or started_at is None or ended_at is None or ended_at < started_at:
        return None
    duration = int((ended_at - started_at).total_seconds())
    if duration > MAX_DURATION_S or started_at > received_at + timedelta(minutes=10):
        return None
    networks = [_net(n) for n in (raw.get('voice_networks') or []) if isinstance(n, str)][:20]
    start_net = _net(raw.get('voice_network_start')) or (networks[0] if networks else '')
    end_net = _net(raw.get('voice_network_end')) or (networks[-1] if networks else '')
    if not networks:
        networks = [n for n in (start_net, end_net) if n]
    data_before = _net(raw.get('data_network_before'))
    start = raw.get('start') if isinstance(raw.get('start'), dict) else {}
    end = raw.get('end') if isinstance(raw.get('end'), dict) else {}
    return {
        'device_id': hash_device_id(device_id),
        'started_at': started_at,
        'ended_at': ended_at,
        'received_at': received_at,
        'duration_s': duration,
        'voice_network_start': start_net,
        'voice_network_end': end_net,
        'voice_networks': ','.join(networks)[:80],
        'data_network_before': data_before,
        'outcome': call_outcome(networks, data_before),
        'lat': _f(start.get('lat')),
        'lng': _f(start.get('lon')),
        'network_type': _net(start.get('network_type')),
        'cell_id': _int(start.get('cell_id')),
        'pci': _int(start.get('pci')),
        'tac': _int(start.get('tac')),
        'mcc': str(start.get('mcc') or '')[:6],
        'mnc': str(start.get('mnc') or '')[:6],
        'level_dbm': _int(start.get('level_dbm')),
        'end_lat': _f(end.get('lat')),
        'end_lng': _f(end.get('lon')),
        'end_network_type': _net(end.get('network_type')),
        'end_cell_id': _int(end.get('cell_id')),
        'end_pci': _int(end.get('pci')),
        'end_level_dbm': _int(end.get('level_dbm')),
    }


class CallContextIngestView(APIView):
    """`POST /api/telemetry/v1/call-samples/` -- a JSON array, one object per
    finished call. A malformed call is skipped, not the batch. Returns
    `202 {"accepted": N, "skipped": M}`."""
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own ingest-key check

    def post(self, request):
        device, _key, err = resolve_ingest_caller(request)
        if err:
            return Response({'detail': err}, status=status.HTTP_401_UNAUTHORIZED)
        payload = request.data
        if not isinstance(payload, list):
            return Response({'detail': 'body must be a JSON array of calls'}, status=status.HTTP_400_BAD_REQUEST)
        if len(payload) > MAX_CALLS_PER_REQUEST:
            return Response({'detail': f'max {MAX_CALLS_PER_REQUEST} calls per request'},
                            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        now = timezone.now()
        rows = [r for r in (_coerce(c, now) for c in payload) if r is not None]
        for r in rows:
            if device:  # a signed device writes rows for itself only
                r['device_id'] = ingest_row_device_id(device)
            # Per-row save() so the model fills `location` (low volume).
            CallContextSample(**r).save()
        return Response({'accepted': len(rows), 'skipped': len(payload) - len(rows)},
                        status=status.HTTP_202_ACCEPTED)


_DEFAULT_DAYS = 7
_MAX_DAYS = 90
_ROW_LIMIT = 200
_TOP_CELLS = 20


class CallContextListView(APIView):
    """`GET /api/v2/telemetry/call-samples/?days=7` -- superadmin. Counts by
    outcome, the cells where calls started that most often fell back, and
    the latest calls (device shown as a short code only)."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        try:
            days = int(request.query_params.get('days', _DEFAULT_DAYS))
        except (TypeError, ValueError):
            days = _DEFAULT_DAYS
        days = max(1, min(_MAX_DAYS, days))
        since = timezone.now() - timedelta(days=days)
        qs = _scope_by_operator(CallContextSample.objects.filter(started_at__gte=since), request.user)

        counts = Counter(qs.values_list('outcome', flat=True))
        total = sum(counts.values())

        per_cell = {}
        for cell_id, pci, net, outcome in qs.exclude(cell_id__isnull=True).values_list(
                'cell_id', 'pci', 'network_type', 'outcome'):
            key = (cell_id, net)
            entry = per_cell.setdefault(key, {'cell_id': cell_id, 'pci': pci, 'network_type': net,
                                              'calls': 0, 'fallback': 0})
            entry['calls'] += 1
            if outcome == 'fallback':
                entry['fallback'] += 1
        top = sorted((e for e in per_cell.values() if e['fallback']),
                     key=lambda e: (-e['fallback'], -e['calls']))[:_TOP_CELLS]
        sectors = sectors_by_cell_identity({e['cell_id'] for e in top if e['network_type'] == 'LTE'})
        for e in top:
            sec = sectors.get(e['cell_id']) if e['network_type'] == 'LTE' else None
            e['site_id'] = sec.site.id if sec else None
            e['cell_name'] = sec.cell_name if sec else ''

        rows = list(qs.order_by('-started_at')[:_ROW_LIMIT])
        names = name_calls(rows)   # "KTM856 J3" at start and end (2026-10-27)
        return Response({
            'days': days,
            'total': total,
            'by_outcome': {key: counts.get(key, 0) for key, _label in CallContextSample.OUTCOMES},
            'top_fallback_cells': top,
            'calls': [{
                'device': r.device_id[:8],
                'started_at': r.started_at,
                'duration_s': r.duration_s,
                'outcome': r.outcome,
                'voice_networks': r.voice_networks,
                'data_network_before': r.data_network_before,
                'network_type': r.network_type,
                'cell_id': r.cell_id,
                'pci': r.pci,
                'level_dbm': r.level_dbm,
                'end_network_type': r.end_network_type,
                'end_level_dbm': r.end_level_dbm,
                'lat': r.lat,
                'lng': r.lng,
                'start_site': n[0],
                'end_site': n[1],
            } for r, n in zip(rows, names)],
        })
