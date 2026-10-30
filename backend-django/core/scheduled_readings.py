"""'Help improve NTC's network' readings (2026-10-29).

A phone whose owner turned this on in the app sends four short readings a
day, around 00:00, 10:00, 14:00 and 19:00 Nepal time (quiet and busy hours):
the network, band, signal and the serving cell's number, and, only when the
owner allowed location "all the time", the phone's position and the centre
of the ~500 m square it is in (exact position since 2026-10-30, the user's
decision; the map still draws squares). It uses the shared ingest key, never its registration, under a random id it
changes every 30 days; the server keeps only a hash of that id, and keeps
the serving cell only as its site and sector. So a reading says how the
network was at a site, a place and an hour, with no number attached.

    POST /api/telemetry/v1/scheduled-readings/   one reading (shared key)
    GET  /api/v2/telemetry/scheduled-readings/?days=30   summary (admin, superadmin)
    GET  /api/v2/telemetry/scheduled-readings/map/?days=30&slot=19&tech=4G
         sectors and squares for the map (admin, superadmin)
"""
import hashlib
import math
from datetime import datetime, timedelta, timezone as dt_timezone

from django.core.cache import cache
from django.db.models import Avg, Count
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .collection import NEPAL_TZ
from .models import ScheduledReading, Sector, Site
from .problem_report import GOOD_DBM, WEAK_DBM
from .serving_site_lookup import lookup_serving_site
from .telemetry import resolve_ingest_caller
from .views import IsAdminOrSuperadmin

SLOTS = (0, 10, 14, 19)
SLOT_LABELS = {0: 'Midnight', 10: '10 am', 14: '2 pm', 19: '7 pm'}
MAX_PER_PHONE_PER_DAY = 8
KEEP_DAYS = 90      # 90 days since the exact position came (2026-10-30, the user's choice)
_TECH = {'LTE': '4G', 'NR': '5G', 'UMTS': '3G', 'GSM': '2G'}
_NETWORKS = {'4G': ('LTE',), '5G': ('NR',), '3G': ('UMTS',), '2G': ('GSM',)}
AREA_DEG = 0.005     # the ~500 m square; the same grid as the phone's


def _area(lat_raw, lng_raw):
    """The centre of the AREA_DEG square, or (None, None). Rounded here
    as well, so nothing finer than the square is ever stored."""
    try:
        lat, lng = float(lat_raw), float(lng_raw)
    except (TypeError, ValueError):
        return None, None
    if not (26 <= lat <= 31 and 80 <= lng <= 89):   # Nepal and its edges
        return None, None
    return (round((math.floor(lat / AREA_DEG) + 0.5) * AREA_DEG, 4),
            round((math.floor(lng / AREA_DEG) + 0.5) * AREA_DEG, 4))


def _position(lat_raw, lng_raw):
    """The exact position inside Nepal and its edges, or (None, None)."""
    try:
        lat, lng = float(lat_raw), float(lng_raw)
    except (TypeError, ValueError):
        return None, None
    if not (26 <= lat <= 31 and 80 <= lng <= 89):
        return None, None
    return round(lat, 6), round(lng, 6)


def _int(value, low, high):
    try:
        v = int(float(value))
    except (TypeError, ValueError):
        return None
    return v if low <= v <= high else None


def _slot(raw, ts):
    slot = _int(raw, 0, 23)
    if slot in SLOTS:
        return slot
    hour = ts.astimezone(NEPAL_TZ).hour
    return min(SLOTS, key=lambda s: min(abs(s - hour), 24 - abs(s - hour)))


def _place(data):
    """Exact position and its square (2026-10-30). Older apps send only the
    square; a new one sends both, and the square is worked out here when
    only the position came."""
    lat, lng = _position(data.get('lat'), data.get('lng'))
    area = _area(data.get('area_lat'), data.get('area_lng'))
    if area == (None, None) and lat is not None:
        area = _area(lat, lng)
    acc = None
    try:
        acc = float(data.get('gps_accuracy_m'))
        acc = acc if 0 <= acc <= 100_000 else None
    except (TypeError, ValueError):
        pass
    return {'lat': lat, 'lng': lng, 'gps_accuracy_m': acc if lat is not None else None,
            'area_lat': area[0], 'area_lng': area[1]}


def _prune():
    if cache.add('scheduled_readings:pruned', 1, timeout=86400):
        ScheduledReading.objects.filter(ts__lt=timezone.now() - timedelta(days=KEEP_DAYS)).delete()


class ScheduledReadingIngestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]   # checks the shared ingest key itself, like the sample upload

    def post(self, request):
        if request.META.get('HTTP_X_SIGNATURE'):
            # These readings must not name the phone, so a signed call is refused.
            return Response({'detail': 'send with the shared key'}, status=400)
        _device, key, err = resolve_ingest_caller(request)
        if key is None:
            return Response({'detail': err or 'invalid key'}, status=401)
        data = request.data if isinstance(request.data, dict) else {}
        anon = str(data.get('anon_id') or '').strip()
        network = str(data.get('network_type') or '').upper()[:12]
        if not anon or len(anon) > 64 or network not in _TECH:
            return Response({'detail': 'anon_id and a known network_type are required'}, status=400)
        anon_hash = hashlib.sha256(f'scheduled:{anon}'.encode()).hexdigest()[:32]
        day = f'{timezone.now():%Y%m%d}'
        bucket = f'scheduled_readings:{anon_hash}:{day}'
        cache.add(bucket, 0, timeout=90000)
        if cache.incr(bucket) > MAX_PER_PHONE_PER_DAY:
            return Response({'detail': 'daily limit reached'}, status=429)

        now = timezone.now()
        ts = now
        ms = _int(data.get('ts'), 0, 4_000_000_000_000)
        if ms is not None:
            ts = datetime.fromtimestamp(ms / 1000, tz=dt_timezone.utc)
            if not now - timedelta(days=2) <= ts <= now + timedelta(minutes=10):
                ts = now
        site = lookup_serving_site(network, cell_id=_int(data.get('cell_id'), 0, 2 ** 40),
                                   tac=_int(data.get('tac'), 0, 2 ** 24))
        ScheduledReading.objects.create(
            anon_hash=anon_hash, ts=ts, slot=_slot(data.get('slot'), ts), network_type=network,
            band=str(data.get('band') or '')[:24], level_dbm=_int(data.get('level_dbm'), -160, 0),
            rsrq_db=_int(data.get('rsrq_db'), -40, 10), sinr_db=_int(data.get('sinr_db'), -30, 50),
            mcc=str(data.get('mcc') or '')[:6], mnc=str(data.get('mnc') or '')[:6],
            serving_site_id=(site or {}).get('site_id') or '', serving_sector=(site or {}).get('sector') or '',
            **_place(data),
        )
        _prune()
        return Response({'stored': True}, status=201)


def _quality(tech, level):
    if level is None or tech not in WEAK_DBM:
        return None
    return 'weak' if level < WEAK_DBM[tech] else 'good' if level >= GOOD_DBM[tech] else 'fair'


class ScheduledReadingSummaryView(APIView):
    """Quality by hour of day and technology, and the sites weakest at those
    hours. Counts and averages only; nothing per phone."""
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        try:
            days = max(1, min(int(request.query_params.get('days', 30)), KEEP_DAYS))
        except ValueError:
            days = 30
        since = timezone.now() - timedelta(days=days)
        qs = ScheduledReading.objects.filter(ts__gte=since)
        totals = qs.aggregate(n=Count('id'), phones=Count('anon_hash', distinct=True))

        slots = {s: {'slot': s, 'label': SLOT_LABELS[s], 'readings': 0, 'techs': {}} for s in SLOTS}
        sites = {}
        for slot, net, level, site in qs.values_list('slot', 'network_type', 'level_dbm', 'serving_site_id').iterator():
            tech = _TECH.get(net, net)
            entry = slots.get(slot)
            if entry is None:
                continue
            entry['readings'] += 1
            t = entry['techs'].setdefault(tech, {'readings': 0, 'level_sum': 0, 'levels': 0,
                                                 'weak': 0, 'fair': 0, 'good': 0})
            t['readings'] += 1
            q = _quality('4G' if tech == '5G' else tech, level)
            if level is not None:
                t['level_sum'] += level
                t['levels'] += 1
            if q:
                t[q] += 1
            if site:
                s = sites.setdefault(site, {'readings': 0, 'weak': 0, 'by_slot': {}})
                s['readings'] += 1
                s['weak'] += 1 if q == 'weak' else 0
                b = s['by_slot'].setdefault(slot, [0, 0])
                b[0] += 1
                b[1] += 1 if q == 'weak' else 0
        for entry in slots.values():
            for t in entry['techs'].values():
                t['level_avg'] = round(t.pop('level_sum') / t['levels'], 1) if t['levels'] else None
                t.pop('levels')
        names = {s['pk']: s for s in Site.objects.filter(pk__in=list(sites)).values('pk', 'name', 'district')}
        weakest = sorted(
            ({'site_id': k, 'name': names.get(k, {}).get('name'), 'district': names.get(k, {}).get('district'),
              'readings': v['readings'], 'weak_pct': round(100 * v['weak'] / v['readings']),
              'weak_pct_by_slot': {str(sl): round(100 * w / n) for sl, (n, w) in v['by_slot'].items() if n}}
             for k, v in sites.items() if v['readings'] >= 5),
            key=lambda r: (-r['weak_pct'], -r['readings']))[:30]
        return Response({
            'days': days, 'readings': totals['n'], 'phones': totals['phones'],
            'matched_to_site': sum(v['readings'] for v in sites.values()),
            'slots': [slots[s] for s in SLOTS], 'weakest_sites': weakest,
        })


class ScheduledReadingMapView(APIView):
    """`GET .../scheduled-readings/map/?days=30&slot=19&tech=4G`: per serving
    sector (placed at its site, with its direction) and per ~500 m square,
    the readings, weak share and average level for that hour. `slot` empty
    means every hour. Counts only; nothing per phone."""
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        try:
            days = max(1, min(int(request.query_params.get('days', 30)), KEEP_DAYS))
        except ValueError:
            days = 30
        qs = ScheduledReading.objects.filter(ts__gte=timezone.now() - timedelta(days=days))
        slot = request.query_params.get('slot')
        if slot not in (None, ''):
            try:
                qs = qs.filter(slot=int(slot))
            except ValueError:
                pass
        tech = request.query_params.get('tech') or ''
        if tech in _NETWORKS:
            qs = qs.filter(network_type__in=_NETWORKS[tech])

        sectors, squares = {}, {}
        for net, level, site, sector, alat, alng in qs.values_list(
                'network_type', 'level_dbm', 'serving_site_id', 'serving_sector', 'area_lat', 'area_lng').iterator():
            t = _TECH.get(net, net)
            q = _quality('4G' if t == '5G' else t, level)
            for key, bucket in (((site, sector), sectors) if site else (None, None),
                                ((alat, alng), squares) if alat is not None else (None, None)):
                if key is None:
                    continue
                e = bucket.setdefault(key, [0, 0, 0, 0])   # readings, weak, level sum, levels
                e[0] += 1
                e[1] += 1 if q == 'weak' else 0
                if level is not None:
                    e[2] += level
                    e[3] += 1

        def figures(e):
            return {'readings': e[0], 'weak_pct': round(100 * e[1] / e[0]),
                    'level_avg': round(e[2] / e[3], 1) if e[3] else None}

        site_ids = {k[0] for k in sectors}
        sites = {s['pk']: s for s in Site.objects.filter(pk__in=site_ids).values('pk', 'name', 'district', 'lat', 'lng')}
        azimuths = {}
        for row in Sector.objects.filter(site_id__in=site_ids).values('site_id', 'sector', 'azimuth'):
            azimuths.setdefault((row['site_id'], row['sector']), row['azimuth'])
        out_sectors = []
        for (site_id, sector), e in sectors.items():
            s = sites.get(site_id)
            if not s or s['lat'] is None:
                continue
            out_sectors.append({'site_id': site_id, 'sector': sector, 'name': s['name'], 'district': s['district'],
                                'lat': s['lat'], 'lng': s['lng'], 'azimuth': azimuths.get((site_id, sector)),
                                **figures(e)})
        return Response({
            'days': days, 'slot': slot or None, 'tech': tech or None, 'area_deg': AREA_DEG,
            'sectors': out_sectors,
            'squares': [{'lat': k[0], 'lng': k[1], **figures(e)} for k, e in squares.items()],
        })
