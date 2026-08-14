"""
KPI Trend — gets its own module rather than living in reports.py because
it's backed by a real model (KpiSnapshot), not pure aggregation over
Site like SLA/NTA/Monthly Report. See KpiSnapshot's docstring in
models.py for the full "why": v1's own equivalent (IndexedDB
netwatch_trend_db) never actually accumulates real data in practice, so
v1's KPI Trend almost always shows Math.random()-fabricated history —
user-confirmed decision (2026-07-28) was to build a real
take_kpi_snapshot daily job instead and show "not enough data" when
history is thin, never fabricate.
"""
from datetime import timedelta

from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import KpiSnapshot, Site

# Ported from v1's catMap inside renderTrendCharts() (bts_monitor.html
# ~12282-12289) — same six category tabs, same KPI groupings per tab,
# just snake_case keys (matching Site/KpiSnapshot) instead of v1's
# camelCase.
TREND_CATEGORIES = {
    'overview': [
        {'key': 'rrc', 'label': 'RRC Setup SR'}, {'key': 'call_drop', 'label': 'Call Drop Rate'},
        {'key': 'intra_ho', 'label': 'Intra-HO SR'}, {'key': 'ip_thru', 'label': 'IP Throughput'},
        {'key': 'ip_lat', 'label': 'IP Latency'}, {'key': 'cell_avail', 'label': 'Cell Availability'},
    ],
    'accessibility': [
        {'key': 'rrc', 'label': 'RRC Setup SR'}, {'key': 'erab', 'label': 'E-RAB Setup SR'},
        {'key': 'call_setup', 'label': 'Call Setup SR'},
    ],
    'retainability': [
        {'key': 'call_drop', 'label': 'Call Drop Rate'}, {'key': 'svc_drop', 'label': 'Svc Drop Rate'},
    ],
    'mobility': [
        {'key': 'intra_ho', 'label': 'Intra-Freq HO SR'}, {'key': 'inter_ho', 'label': 'Inter-Freq HO SR'},
        {'key': 'inter_rat', 'label': 'Inter-RAT HO SR'},
    ],
    'integrity': [
        {'key': 'ip_thru', 'label': 'IP Throughput (Mbps)'}, {'key': 'ip_lat', 'label': 'IP Latency (ms)'},
    ],
    'utilization': [
        {'key': 'prb', 'label': 'PRB Utilization'}, {'key': 'bearer_util', 'label': 'EPS Bearer Util'},
        {'key': 'lic_util', 'label': 'License Util'}, {'key': 'cell_avail', 'label': 'Cell Availability'},
    ],
}

# Every KPI field a snapshot row carries, regardless of which category
# tab currently charts it (rssi/load aren't in any TREND_CATEGORIES entry
# — v1 doesn't chart them in KPI Trend either, they're Scatter-Plot-only
# — but the snapshot still records them for future use).
SNAPSHOT_FIELDS = [
    'rrc', 'erab', 'call_setup', 'call_drop', 'svc_drop', 'intra_ho',
    'inter_ho', 'inter_rat', 'ip_thru', 'ip_lat', 'prb', 'bearer_util',
    'lic_util', 'cell_avail', 'rssi', 'load',
]

# Matches v1's `snaps.length<3` fallback-to-fake-data threshold
# (bts_monitor.html ~12280) — reused here as the "not enough data yet"
# cutoff, just without the fabrication fallback on the wrong side of it.
MIN_SNAPSHOTS_FOR_TREND = 3


def build_kpi_trend(site_id, days=30):
    try:
        site = Site.objects.get(id=site_id)
    except Site.DoesNotExist:
        return None

    cutoff = timezone.localdate() - timedelta(days=days)
    snaps = list(KpiSnapshot.objects.filter(site=site, date__gte=cutoff).order_by('date'))
    has_enough_data = len(snaps) >= MIN_SNAPSHOTS_FOR_TREND

    series = []
    if has_enough_data:
        for s in snaps:
            row = {'date': s.date.isoformat()}
            for f in SNAPSHOT_FIELDS:
                row[f] = getattr(s, f)
            series.append(row)

    return {
        'site': {'id': site.id, 'name': site.name or site.id},
        'categories': TREND_CATEGORIES,
        'days': days,
        'has_enough_data': has_enough_data,
        'snapshot_count': len(snaps),
        'min_required': MIN_SNAPSHOTS_FOR_TREND,
        'series': series,
    }


class KpiTrendView(APIView):
    """GET /api/v2/kpi-trend/?site=<id>&days=7|30|90 — matches v1's
    openTrendModal()/setTrendPeriod() period options. Returns
    has_enough_data=False (and an empty series) instead of ever
    fabricating a fallback trend — see this module's docstring."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        site_id = request.query_params.get('site')
        if not site_id:
            return Response({'detail': 'site is required'}, status=400)
        try:
            days = int(request.query_params.get('days', 30))
        except ValueError:
            days = 30
        data = build_kpi_trend(site_id, days)
        if data is None:
            return Response({'detail': 'Site not found'}, status=404)
        return Response(data)
