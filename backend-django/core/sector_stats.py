"""Readings per serving sector (2026-10-19): how much each sector served and
how well, for the Subscriber Profile, a drive-test session, a phone drive on
Collections and a Telemetry Drive Test session.

One row per site + sector + technology: readings and their share,
weak / fair / good (the problem check's limits, problem_report.WEAK_DBM and
GOOD_DBM, so "weak" means the same on every page), average level, RSRQ,
SINR, CQI, download (drive tests), distance to the site, and when it served.
Only readings matched to a sector count; the rest are reported as a number.

    GET /api/v2/dt-sessions/<id>/sectors/                 any signed-in user
    GET /api/v2/collection-sessions/<id>/sectors/         drive.view
    GET /api/v2/telemetry/dt-sessions/<id>/sectors/       admin, superadmin

The two phone-reading answers also carry `neighbours`: the other cells the
phones heard, one row per cell (core/neighbour_cells.py, 2026-10-27).

Sectors are masts, not people, so these pages show them as they show the
readings themselves. On the Subscriber Profile they are the customer's
location history and follow its rule (emergency only), see
subscriber_analytics.py.
"""
from django.db.models.expressions import RawSQL
from django.db.models import Avg, Case, Count, F, FloatField, IntegerField, Max, Min, Q, When
from django.shortcuts import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import neighbour_cells, radio_band
from .access import CanViewDrives
from .cqi import sample_cqi_sql
from .models import CollectionSession, DriveTestSample, DriveTestSession, Site, TelemetrySample, TelemetryDriveTestSession
from .problem_report import GOOD_DBM, WEAK_DBM
from .views import IsAdminOrSuperadmin

SECTORS_MAX = 80
_NETS = {'4G': ('LTE', 'NR'), '3G': ('UMTS',), '2G': ('GSM',)}
_TECH_OF = {'LTE': '4G', 'NR': '4G', 'UMTS': '3G', 'GSM': '2G'}
_TEL_LEVEL = {'4G': 'rsrp_dbm', '3G': 'rscp_dbm', '2G': 'rssi_dbm'}


INDOOR_LOSS_MIN = 10   # readings of each kind before an indoor loss is given (2026-10-26)


def _r(v, digits=1):
    return round(float(v), digits) if v is not None else None


def _iso(v):
    """Phone readings keep a timestamp; drive-test rows keep the log's own text."""
    if v is None or v == '':
        return None
    return v.isoformat() if hasattr(v, 'isoformat') else str(v)


def _telemetry_level():
    return Case(When(network_type='UMTS', then=F('rscp_dbm')), When(network_type='GSM', then=F('rssi_dbm')),
                default=F('rsrp_dbm'), output_field=IntegerField())


def _telemetry_class(limits, below):
    q = Q()
    for tech, nets in _NETS.items():
        q |= Q(network_type__in=nets, **{f'{_TEL_LEVEL[tech]}__{"lt" if below else "gte"}': limits[tech]})
    return q


def _rows(qs, group, level, weak_q, good_q, with_level_q, extra):
    return list(
        qs.exclude(serving_site_id='').exclude(serving_site_id__isnull=True)
        .values('serving_site_id', 'serving_sector', *group)
        .annotate(n=Count('id'), weak=Count('id', filter=weak_q), good=Count('id', filter=good_q),
                  with_level=Count('id', filter=with_level_q), level=Avg(level), rsrq=Avg(extra['rsrq']),
                  sinr=Avg(extra['sinr']), cqi=Avg(extra['cqi']), dist=Avg('serving_dist_km'),
                  first=Min('ts'), last=Max('ts'), cell_name=Max('serving_cell_name'),
                  cell_id=Max('cell_id'), pci=Max('pci'), **({'tac': Max('tac')} if extra.get('tac') else {}),
                  **({'dl': Avg('dl')} if extra.get('dl') else {}),
                  # Indoor and outdoor levels of phone readings (2026-10-26):
                  # the gap is the building's loss for this sector.
                  **({'n_in': Count('id', filter=with_level_q & Q(environment='indoor')),
                      'lvl_in': Avg(level, filter=Q(environment='indoor')),
                      'n_out': Count('id', filter=with_level_q & Q(environment__in=('outdoor', 'vehicle'))),
                      'lvl_out': Avg(level, filter=Q(environment__in=('outdoor', 'vehicle')))}
                     if extra.get('env') else {}))
        .order_by('-n')[:SECTORS_MAX]
    )


def _shape(rows, total, network_of, band_of):
    site_info = {s['id']: s for s in Site.objects.filter(id__in={r['serving_site_id'] for r in rows})
                 .values('id', 'name', 'district')}
    matched = sum(r['n'] for r in rows)
    out = []
    for r in rows:
        site = site_info.get(r['serving_site_id']) or {}
        net = network_of(r)
        out.append({
            'site_id': r['serving_site_id'], 'site_name': site.get('name') or None,
            'district': site.get('district') or None, 'sector': r['serving_sector'] or None,
            'cell_name': r['cell_name'] or None, 'cell_id': r.get('cell_id'), 'pci': r.get('pci'),
            'tac': r.get('tac'), 'network_type': net, 'tech': _TECH_OF.get(net, net),
            'band_label': band_of(r), 'readings': r['n'],
            'share_pct': _r(100.0 * r['n'] / matched) if matched else None,
            'weak': r['weak'], 'good': r['good'], 'fair': max(0, r['with_level'] - r['weak'] - r['good']),
            'no_level': r['n'] - r['with_level'], 'level_avg': _r(r['level']), 'rsrq_avg': _r(r['rsrq']),
            'sinr_avg': _r(r['sinr']), 'cqi_avg': _r(r['cqi']), 'dl_avg': _r(r.get('dl')),
            'dist_km_avg': _r(r['dist'], 2), 'first': _iso(r['first']), 'last': _iso(r['last']),
            'indoor_readings': r.get('n_in'), 'outdoor_readings': r.get('n_out'),
            'indoor_level_avg': _r(r.get('lvl_in')), 'outdoor_level_avg': _r(r.get('lvl_out')),
            # Shown only with enough of both (INDOOR_LOSS_MIN each).
            'indoor_loss_db': _r(r['lvl_out'] - r['lvl_in'])
            if r.get('n_in', 0) and r.get('n_out', 0) and r['n_in'] >= INDOOR_LOSS_MIN and r['n_out'] >= INDOOR_LOSS_MIN
            and r.get('lvl_in') is not None and r.get('lvl_out') is not None else None,
        })
    return {'sectors': out, 'total': total, 'matched': matched, 'unmatched': max(0, total - matched),
            'capped': len(rows) >= SECTORS_MAX, 'limits': {'weak_dbm': WEAK_DBM, 'good_dbm': GOOD_DBM}}


def telemetry_sectors(qs):
    """Per-sector rows for phone readings (TelemetrySample)."""
    rows = _rows(
        qs, ('network_type',), _telemetry_level(), _telemetry_class(WEAK_DBM, True), _telemetry_class(GOOD_DBM, False),
        Q(network_type__in=('LTE', 'NR'), rsrp_dbm__isnull=False) | Q(network_type='UMTS', rscp_dbm__isnull=False)
        | Q(network_type='GSM', rssi_dbm__isnull=False),
        # CQI as the reading lists show it (2026-10-27): the phone's own, else
        # estimated from SINR, else from RSRQ. Phones almost never report one.
        {'rsrq': 'rsrq_db', 'sinr': 'sinr_db', 'cqi': RawSQL(sample_cqi_sql(), []), 'tac': True, 'env': True},
    )
    bands = {}
    if rows:
        for b in (qs.exclude(serving_site_id='').values('serving_site_id', 'serving_sector', 'network_type')
                  .annotate(band=Max('band'), band_mhz=Max('band_mhz'))):
            bands[(b['serving_site_id'], b['serving_sector'], b['network_type'])] = b
    return _shape(
        rows, qs.count(), lambda r: r['network_type'],
        lambda r: (lambda b: radio_band.label(r['network_type'], b['band'], b['band_mhz']) if b else None)(
            bands.get((r['serving_site_id'], r['serving_sector'], r['network_type']))) or None,
    )


def drive_test_sectors(session):
    """Per-sector rows for one drive-test session (DriveTestSample)."""
    tech = session.tech or '4G'
    level_field = 'rscp' if tech == '3G' else 'rsrp'
    weak, good = WEAK_DBM.get(tech, WEAK_DBM['4G']), GOOD_DBM.get(tech, GOOD_DBM['4G'])
    qs = DriveTestSample.objects.filter(session=session)
    level = Case(When(**{f'{level_field}__isnull': False}, then=F(level_field)), default=F('rsrp'),
                 output_field=FloatField()) if tech == '3G' else F('rsrp')
    rows = _rows(
        qs, ('band',), level,
        Q(**{f'{level_field}__lt': weak}), Q(**{f'{level_field}__gte': good}), Q(**{f'{level_field}__isnull': False}),
        {'rsrq': 'rsrq', 'sinr': 'sinr', 'cqi': 'cqi', 'dl': True},
    )
    net = {'4G': 'LTE', '3G': 'UMTS', '2G': 'GSM'}.get(tech, tech)
    return _shape(rows, qs.count(), lambda r: net, lambda r: r.get('band') or None)


class DriveTestSessionSectorsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        return Response(drive_test_sectors(get_object_or_404(DriveTestSession, pk=pk)))


class CollectionSessionSectorsView(APIView):
    """The same readings the Collections plot draws (a phone drive or share);
    a trace session's positions carry no serving cell, so it has none."""
    permission_classes = [IsAuthenticated, CanViewDrives]

    def get(self, request, pk):
        session = get_object_or_404(CollectionSession, pk=pk)
        if session.trace_id:
            qs = TelemetrySample.objects.none()
        else:
            qs = TelemetrySample.objects.filter(device_id=session.device_hash,
                                                drive_session_id=session.drive_session_id or '__none__')
        return Response({**telemetry_sectors(qs), 'neighbours': neighbour_cells.session_summary(qs)})


class TelemetryDriveTestSessionSectorsView(APIView):
    """The readings the session's plot uses (devices, time, area, operator
    scope and consent; telemetry_admin.session_samples_qs)."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, pk):
        from .telemetry_admin import _auto_end_if_due, session_samples_qs
        session = _auto_end_if_due(get_object_or_404(TelemetryDriveTestSession, pk=pk))
        qs, _ = session_samples_qs(session, request.user)
        return Response({**telemetry_sectors(qs), 'neighbours': neighbour_cells.session_summary(qs)})
