"""
RF Audit — gets its own module rather than living in reports.py for the
same reason KPI Trend does: it's backed by a real model (AuditHistory),
not pure aggregation over Site.

Ported from bts_monitor.html's RF Audit tool (openAuditModal() and
friends, ~line 11655-12167), with one deliberate, documented departure
from a literal port: the "Sector Analysis" pane.

v1's renderAuditSectors() (~11897) invents three sectors' worth of
RSRP/RSRQ/SINR/PRB/HO/DL/UL by taking a site-level KPI and adding an
arbitrary per-sector offset, with RSRQ additionally jittered by
`Math.random()` on every render. That's fabrication twice over: (1) this
system has no real per-sector RSRP/RSRQ/SINR anywhere — those only exist
in Drive Test session point data (netwatch_dt_db), never attached to a
Sector row — so inventing them for an audit report is actively
misleading; and (2) even the site-level KPIs it starts from get random
noise added, so the same audit re-opened twice shows different numbers
for the same real site. Both conflict with this project's "never
fabricate data" rule (see the RSRP boundary/hull and KpiSnapshot
precedents).

What sectors *do* have for real: `Sector.kpi_json`, a per-sector KPI
dict keyed by the same field names as Site (rrc, call_drop, intra_ho,
ip_thru, ip_lat, prb, cell_avail, ...) — see bts_monitor.html ~13698
(`sec.kpi[k] = r[k]` for k in ALL_KPI_KEYS) and seed_legacy_data.py's
straight copy of that JSON blob. So build_audit_sectors() below reports
real per-sector values from kpi_json where a sector actually has its
own entry, and falls back to the site's own aggregate value — labeled
as such, never invented — when it doesn't. No randomness anywhere.
"""
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import AuditHistory, Site
from .serializers import AuditHistorySerializer
from .views import IsAdminOrSuperadmin

# Consolidation of v1's two slightly-drifted KPI check lists — findings
# (generateFindings()'s kpiChecks, 9 items, ~11979) and scoring
# (generateAuditReport()'s inline kpiProblems, 7 items, ~12054) covered
# almost-but-not-quite the same KPIs with almost-but-not-quite the same
# thresholds. Rather than reproduce that internal drift, both findings
# and the KPI score below are computed from this one list — a strictly
# broader, not narrower, version (superset of both v1 lists), so nothing
# a v1 user could see disappears, some gets checked that v1's report-
# scorer silently skipped (erab, inter_ho).
KPI_CHECKS = [
    {'key': 'rrc', 'label': 'RRC Setup SR', 'ok': 95, 'crit': 90, 'hi': True,
     'title': 'Low RRC Setup SR',
     'detail': 'RRC connection setup rate below threshold. Possible S1-MME issues or RRC configuration fault.',
     'action': 'Review S1 interface. Check RRC reject cause codes. Verify RACH parameters.'},
    {'key': 'erab', 'label': 'E-RAB Setup SR', 'ok': 95, 'crit': 90, 'hi': True,
     'title': 'Low E-RAB Setup SR',
     'detail': 'E-RAB establishment failures. Check S1-U and SGW connectivity.',
     'action': 'Verify S1-U interface. Check SGW/PGW reachability. Review QCI parameters.'},
    {'key': 'call_drop', 'label': 'Call Drop Rate', 'ok': 2, 'crit': 4, 'hi': False,
     'title': 'High Call Drop Rate',
     'detail': 'Call drop rate exceeds acceptable threshold indicating coverage or handover issues.',
     'action': 'Review coverage map. Check A3 event parameters. Inspect feeder for PIM.'},
    {'key': 'intra_ho', 'label': 'Intra-Freq HO SR', 'ok': 93, 'crit': 88, 'hi': True,
     'title': 'Low Intra-Freq HO SR',
     'detail': 'Intra-frequency handover failures suggest missing neighbours or misconfigured offsets.',
     'action': 'Update neighbour cell list. Verify A3 offset and TTT. Check X2 connectivity.'},
    {'key': 'inter_ho', 'label': 'Inter-Freq HO SR', 'ok': 90, 'crit': 85, 'hi': True,
     'title': 'Low Inter-Freq HO SR',
     'detail': 'Inter-frequency handover failing. Measurement gaps or frequency config issues.',
     'action': 'Check IRAT measurement gap patterns. Verify inter-freq neighbour config.'},
    {'key': 'ip_thru', 'label': 'IP Throughput', 'ok': 20, 'crit': 12, 'hi': True,
     'title': 'Low IP Throughput',
     'detail': 'Data throughput significantly below target. Interference or capacity issue likely.',
     'action': 'Check SINR distribution. Review PRB allocation. Inspect antenna alignment.'},
    {'key': 'ip_lat', 'label': 'IP Latency', 'ok': 35, 'crit': 60, 'hi': False,
     'title': 'High IP Latency',
     'detail': 'Round-trip latency above acceptable limit. Backhaul or scheduling issue.',
     'action': 'Inspect backhaul link. Check QoS configuration. Verify timing synchronisation.'},
    {'key': 'prb', 'label': 'PRB Utilisation', 'ok': 75, 'crit': 90, 'hi': False,
     'title': 'High PRB Utilisation',
     'detail': 'Cell is congested. User experience will be degraded during peak hours.',
     'action': 'Consider capacity expansion. Enable CA if available. Review load balancing.'},
    {'key': 'cell_avail', 'label': 'Cell Availability', 'ok': 97, 'crit': 95, 'hi': True,
     'title': 'Low Cell Availability',
     'detail': 'Cell availability below target — hardware fault or software crash suspected.',
     'action': 'Check hardware alarms in EMS. Review software crash logs. Inspect power supply.'},
]

# Fields shown in the Sector Analysis cross-sector comparison table —
# the subset of KPI_CHECKS keys that sectors can realistically carry
# their own kpi_json entry for (matches ALL_KPI_KEYS' overlap with what
# CSV KPI imports actually populate per-sector in practice).
SECTOR_COMPARISON_FIELDS = ['rrc', 'call_drop', 'intra_ho', 'ip_thru', 'prb', 'cell_avail']


def audit_kpi_checks(site):
    """Returns (findings, score, problems). One pass over KPI_CHECKS
    instead of v1's two separate passes — see module docstring."""
    findings = []
    problems = []
    for c in KPI_CHECKS:
        v = getattr(site, c['key'])
        if v is None:
            continue
        bad = v < c['crit'] if c['hi'] else v > c['crit']
        warn = (v < c['ok'] if c['hi'] else v > c['ok']) and not bad
        if bad:
            problems.append({'sev': 'CRIT', 'key': c['key'], 'label': c['label'], 'value': v})
            findings.append({
                'sev': 'CRITICAL', 'cat': 'KPI', 'title': c['title'],
                'detail': c['detail'], 'action': c['action'], 'note': f'Current: {v:.1f}',
            })
        elif warn:
            problems.append({'sev': 'WARN', 'key': c['key'], 'label': c['label'], 'value': v})
            findings.append({
                'sev': 'MAJOR', 'cat': 'KPI', 'title': c['title'],
                'detail': c['detail'], 'action': c['action'], 'note': f'Current: {v:.1f}',
            })
    crit_n = sum(1 for p in problems if p['sev'] == 'CRIT')
    warn_n = sum(1 for p in problems if p['sev'] == 'WARN')
    score = max(0, 100 - crit_n * 18 - warn_n * 8)
    return findings, score, problems


def build_audit_sectors(site):
    """Real per-sector KPI comparison — see module docstring for why this
    replaces v1's fabricated RSRP/RSRQ/SINR sector breakdown."""
    rows = []
    for sec in site.sectors.all().order_by('sector', 'cell_name'):
        kpi = sec.kpi_json or {}
        values = {}
        for key in SECTOR_COMPARISON_FIELDS:
            if key in kpi and kpi[key] is not None:
                values[key] = {'value': kpi[key], 'source': 'sector'}
            else:
                site_v = getattr(site, key)
                values[key] = {'value': site_v, 'source': 'site'} if site_v is not None else {'value': None, 'source': None}
        rows.append({
            'id': sec.id,
            'cell_name': sec.cell_name,
            'sector': sec.sector,
            'pci': sec.pci,
            'azimuth': sec.azimuth,
            'mech_tilt': sec.mech_tilt,
            'elec_tilt': sec.elec_tilt,
            'values': values,
        })
    return rows


def build_rf_audit_data(site):
    findings, kpi_score, kpi_problems = audit_kpi_checks(site)
    return {
        'site': {
            'id': site.id, 'name': site.name or site.id, 'region': site.region,
            'type': site.type, 'tech': site.tech, 'status': site.status,
            'lat': site.lat, 'lng': site.lng,
        },
        'kpi_findings': findings,
        'kpi_score': kpi_score,
        'kpi_problems': kpi_problems,
        'kpi_fields': [
            {'key': c['key'], 'label': c['label'], 'ok': c['ok'], 'crit': c['crit'], 'hi': c['hi']}
            for c in KPI_CHECKS
        ],
        'sector_fields': SECTOR_COMPARISON_FIELDS,
        'sectors': build_audit_sectors(site),
    }


class RfAuditDataView(APIView):
    """GET /api/v2/rf-audit/data/?site=<id> — real KPI findings, KPI
    score, and per-sector KPI comparison for one site. Checklist items,
    measurement RAG thresholds, VSWR/PIM evaluation, and antenna/feeder
    config fields stay client-side (RfAuditPage.tsx), matching v1: those
    are fixed reference data / pure-arithmetic evaluators with no DB
    dependency, not read from anywhere. Only what needs real Site/Sector
    data lives here."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        site_id = request.query_params.get('site')
        if not site_id:
            return Response({'detail': 'site is required'}, status=400)
        try:
            site = Site.objects.get(id=site_id)
        except Site.DoesNotExist:
            return Response({'detail': 'Site not found'}, status=404)
        return Response(build_rf_audit_data(site))


class AuditHistoryListView(APIView):
    """GET/POST /api/v2/rf-audit/history/ — matches v1's /audit-history
    exactly, including gating BOTH read and write to superadmin/admin
    (bagalewatch_api.py: `_require_auth(conn, headers, roles=('superadmin',
    'admin'))` on both the GET and the POST — 'rfaudit' is admin+ by
    default in DEFAULT_PERMS, viewers never see this menu at all)."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        site_id = request.query_params.get('site')
        qs = AuditHistory.objects.all()
        if site_id:
            qs = qs.filter(site_id=site_id)
        return Response(AuditHistorySerializer(qs[:50], many=True).data)

    def post(self, request):
        site_id = request.data.get('site')
        site = Site.objects.filter(id=site_id).first() if site_id else None
        entry = AuditHistory.objects.create(
            site=site,
            site_name=(site.name or site.id) if site else (request.data.get('site_name') or ''),
            content=request.data.get('content') or '',
            score=request.data.get('score'),
            created_by=request.user,
        )
        return Response(AuditHistorySerializer(entry).data, status=201)


class AuditHistoryDetailView(APIView):
    """DELETE /api/v2/rf-audit/history/<id>/ — v1 has no delete for
    audit-history (only report_history gets one), but leaving 10-deep
    saved audits to grow unbounded forever in a real Postgres table
    (instead of v1's client-side-capped `if(auditSaved.length>10)pop()`
    array) isn't a reasonable v2 default. Same admin+ gate as the list
    view."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request, pk):
        try:
            entry = AuditHistory.objects.get(pk=pk)
        except AuditHistory.DoesNotExist:
            return Response({'detail': 'Not found'}, status=404)
        return Response(AuditHistorySerializer(entry).data)

    def delete(self, request, pk):
        deleted, _ = AuditHistory.objects.filter(pk=pk).delete()
        if not deleted:
            return Response({'detail': 'Not found'}, status=404)
        return Response(status=204)
