"""
Phase 3 — reporting suite. Read-only aggregation over Site data already
migrated in Phases 1-2 (per the migration plan's §6: "no new data model,
no Go/Node involvement yet, mostly Django query + React chart work").
That holds for every view in this file — each formula is ported
field-for-field from bts_monitor.html, not reinvented, with the exact
source location noted in its own docstring. Monthly Report and Scatter
Plot land here too once built (same "no new model" category). KPI Trend
(needs the new KpiSnapshot model, since v1's own version fabricates data
with Math.random() when no real history exists — rejected, see
models.py) and RF Audit (needs the new AuditHistory model) will live in
their own modules instead, since they're not "no new data model" work.
"""
from datetime import datetime

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Site
from .serializers import SiteScatterSerializer

# ── SLA Tracker ──────────────────────────────────────────────────────────
# Ported from bts_monitor.html's SLA_TARGETS constant (~line 8355).
SLA_TARGETS = [
    {'key': 'cell_avail', 'label': 'Cell Availability', 'unit': '%', 'target': 98.0, 'op': 'gte', 'weight': 25},
    {'key': 'rrc', 'label': 'RRC Setup Success Rate', 'unit': '%', 'target': 95.0, 'op': 'gte', 'weight': 20},
    {'key': 'erab', 'label': 'E-RAB Setup SR', 'unit': '%', 'target': 95.0, 'op': 'gte', 'weight': 15},
    {'key': 'call_drop', 'label': 'Call Drop Rate', 'unit': '%', 'target': 2.0, 'op': 'lte', 'weight': 15},
    {'key': 'ip_thru_dl', 'label': 'DL Throughput', 'unit': 'Mbps', 'target': 10.0, 'op': 'gte', 'weight': 10},
    {'key': 'prb_dl', 'label': 'PRB Utilisation', 'unit': '%', 'target': 80.0, 'op': 'lte', 'weight': 10},
    {'key': 'intra_ho', 'label': 'Intra-HO Success Rate', 'unit': '%', 'target': 93.0, 'op': 'gte', 'weight': 5},
]


def _sla_kpi_pass(value, target, op):
    if value is None:
        return None
    return value >= target if op == 'gte' else value <= target


def site_sla_score(site):
    """Matches v1's siteSlaScore() exactly: each target KPI is weighted;
    only KPIs that actually have a recorded value count toward the score's
    denominator (data_weight), so a site missing some KPIs isn't unfairly
    penalized for data it was never given — it's scored on what it has."""
    data_w = pass_w = 0
    kpi_results = []
    for t in SLA_TARGETS:
        value = getattr(site, t['key'])
        passed = _sla_kpi_pass(value, t['target'], t['op'])
        if passed is not None:
            data_w += t['weight']
            if passed:
                pass_w += t['weight']
        kpi_results.append({**t, 'value': value, 'pass': passed})
    score = round(pass_w / data_w * 100) if data_w > 0 else None
    return score, kpi_results


def build_sla_report(region='all'):
    sites = Site.objects.filter(kpi_entered=True)
    if region != 'all':
        sites = sites.filter(region=region)

    rows = []
    for site in sites:
        score, kpi_results = site_sla_score(site)
        rows.append({
            'id': site.id, 'name': site.name or site.id, 'region': site.region,
            'score': score, 'kpi_results': kpi_results,
        })
    # Worst-first, same as v1's renderSlaTracker sort.
    rows.sort(key=lambda r: r['score'] if r['score'] is not None else -1)

    scored = [r for r in rows if r['score'] is not None]
    compliant = sum(1 for r in scored if r['score'] >= 80)
    partial = sum(1 for r in scored if 50 <= r['score'] < 80)
    breach = sum(1 for r in scored if r['score'] < 50)
    nodata = len(rows) - len(scored)
    avg_score = round(sum(r['score'] for r in scored) / len(scored), 1) if scored else None

    return {
        'targets': SLA_TARGETS,
        'summary': {
            'total': len(rows), 'compliant': compliant, 'partial': partial,
            'breach': breach, 'nodata': nodata, 'avg_score': avg_score,
        },
        'sites': rows,
    }


# ── NTA Regulatory Compliance ───────────────────────────────────────────
# Ported from bts_monitor.html's NTA_THRESHOLDS constant (~line 12399).
NTA_THRESHOLDS = [
    {'key': 'rrc', 'label': 'RRC Connection Setup SR', 'min': 95, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Accessibility', 'penalty': 'Warning + fine if <90%'},
    {'key': 'erab', 'label': 'E-RAB Setup SR', 'min': 95, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Accessibility', 'penalty': 'Warning if <93%'},
    {'key': 'call_setup', 'label': 'Call Setup SR', 'min': 93, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Accessibility', 'penalty': 'Warning if <90%'},
    {'key': 'call_drop', 'label': 'Call Drop Rate', 'min': None, 'max': 2, 'unit': '%', 'hi': False, 'cat': 'Retainability', 'penalty': 'Warning + fine if >3%'},
    {'key': 'svc_drop', 'label': 'Service Drop Rate', 'min': None, 'max': 2, 'unit': '%', 'hi': False, 'cat': 'Retainability', 'penalty': 'Warning if >3%'},
    {'key': 'intra_ho', 'label': 'Intra-Freq HO SR', 'min': 90, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Mobility', 'penalty': 'Warning if <88%'},
    {'key': 'inter_ho', 'label': 'Inter-Freq HO SR', 'min': 88, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Mobility', 'penalty': 'Advisory if <85%'},
    {'key': 'ip_thru', 'label': 'IP Throughput (DL)', 'min': 10, 'max': None, 'unit': 'Mbps', 'hi': True, 'cat': 'Integrity', 'penalty': 'QoS review if <5Mbps'},
    {'key': 'ip_lat', 'label': 'IP Latency (RTT)', 'min': None, 'max': 50, 'unit': 'ms', 'hi': False, 'cat': 'Integrity', 'penalty': 'QoS review if >80ms'},
    {'key': 'cell_avail', 'label': 'Cell Availability', 'min': 95, 'max': None, 'unit': '%', 'hi': True, 'cat': 'Availability', 'penalty': 'Fine if <90% sustained'},
]


def nta_check(value, definition):
    """Matches v1's ntaCheck() exactly — the warn band is 5%/10% of the
    limit itself (min*0.95 / max*1.10), not a fixed offset.

    CORRECTED 2026-07-28 (caught while building Monthly Report, before
    the earlier version below was ever verified against a data-sparse
    region): v1's renderNtaReport() has `if(v===undefined)return
    {st:'pass'...}`, which reads like "no data = automatic pass". It
    isn't, in practice. v1's site objects come straight off the API
    (`sitesResp.sites.forEach(s=>SITES.push(s))`, bts_monitor.html
    ~14635) via `_site_row_to_dict()` (bagalewatch_api.py), which does
    `dict(row)` over every SQL column — every key is always present, so
    an unset KPI is JSON `null`, never a genuinely absent/`undefined`
    property. `v===undefined` therefore never actually fires for real
    data; what actually runs is `ntaCheck(null, def)`, and JS coerces
    `null` to `0` in a numeric comparison. For a `hi:true` KPI (needs to
    be >= a minimum), that means missing data reads as FAIL, not pass.
    For a `hi:false` KPI (needs to be <= a maximum), it reads as PASS
    (0 is always <= a positive max). Replicated here by coercing `None`
    to `0` before comparing, matching the real behavior rather than the
    misleadingly-dead `undefined` branch."""
    v = value if value is not None else 0
    if definition['hi']:
        return 'pass' if v >= definition['min'] else ('warn' if v >= definition['min'] * 0.95 else 'fail')
    return 'pass' if v <= definition['max'] else ('warn' if v <= definition['max'] * 1.1 else 'fail')


def nta_site_rows():
    """Matches v1's renderNtaReport() exactly — see nta_check()'s
    docstring for why there's no "missing value = automatic pass"
    special case here: that branch is dead code against real data, so
    reproducing it would be a deviation, not a faithful port."""
    rows = []
    for site in Site.objects.all().order_by('name'):
        site_fail = site_warn = False
        cells = []
        for definition in NTA_THRESHOLDS:
            value = getattr(site, definition['key'], None)
            status = nta_check(value, definition)
            if status == 'fail':
                site_fail = True
            elif status == 'warn':
                site_warn = True
            cells.append({'key': definition['key'], 'status': status, 'value': value})
        overall = 'fail' if site_fail else ('warn' if site_warn else 'pass')
        rows.append({
            'id': site.id, 'name': site.name or site.id, 'region': site.region,
            'cells': cells, 'overall': overall,
        })
    return rows


def build_nta_report(pane='all-sites'):
    rows = nta_site_rows()
    total = len(rows)
    pass_n = sum(1 for r in rows if r['overall'] == 'pass')
    warn_n = sum(1 for r in rows if r['overall'] == 'warn')
    fail_n = sum(1 for r in rows if r['overall'] == 'fail')

    filtered = [r for r in rows if r['overall'] != 'pass'] if pane == 'violations' else rows

    return {
        'thresholds': NTA_THRESHOLDS,
        'summary': {
            'compliant': pass_n, 'warning': warn_n, 'violation': fail_n,
            'rate': round(pass_n / total * 100) if total else 0,
        },
        'sites': filtered,
    }


# ── Monthly Report ───────────────────────────────────────────────────────
# Ported from bts_monitor.html's generateMonthlyReport() (~line 12664-
# 12738) — a generated markdown document, not a data table. Note (kept
# from v1, not a v2 bug): the month picker is a LABEL ONLY. v1 has no
# time-series storage, so "January 2026" vs "July 2026" produces an
# identical report from the same current snapshot — this isn't wired up
# to KpiSnapshot (Phase 3e) either, deliberately, to stay a faithful port
# of what v1 actually does rather than silently promising monthly
# history v1 never had.

def _monthly_avg(sites, key):
    return sum((getattr(s, key) or 0) for s in sites) / len(sites)


def _monthly_min(sites, key):
    return min((getattr(s, key) or 0) for s in sites)


def _monthly_max(sites, key):
    return max((getattr(s, key) or 0) for s in sites)


def _monthly_rank_key(site):
    # Matches v1's sort key exactly: (rrc + intraHO + cellAvail*10).
    return (site.rrc or 0) + (site.intra_ho or 0) + (site.cell_avail or 0) * 10


def _fmt1(value, unit=''):
    """v1 calls `.toFixed(1)` directly on these fields with no null
    check — which would throw in the browser for a site with no KPI data
    at all (a real latent bug, not intentional behavior; confirmed by
    the same "sites can have null KPI fields" fact that drove the
    nta_check() fix above). Rendering "—" instead of crashing the
    request is the one deliberate deviation from a literal port in this
    file — the ranking/selection logic itself (which sites end up in
    the worst/best 5) is unchanged."""
    return f'{value:.1f}{unit}' if value is not None else '—'


def build_monthly_report(month=None, style='executive', region='all'):
    sites = list(Site.objects.all().order_by('name'))
    if region != 'all':
        sites = [s for s in sites if s.region == region]

    now = datetime.now()
    month_name = now.strftime('%B %Y')
    if month:
        try:
            yr, mo = month.split('-')
            month_name = datetime(int(yr), int(mo), 1).strftime('%B %Y')
        except (ValueError, IndexError):
            pass
    date_str = now.strftime('%d %b %Y')
    region_label = 'All Regions' if region == 'all' else region

    if not sites:
        markdown = (
            f'# NEPAL TELECOM — MONTHLY NETWORK PERFORMANCE REPORT\n## {month_name}\n\n'
            f'No sites found for {region_label}.'
        )
        return {'markdown': markdown, 'meta': {'site_count': 0, 'region': region, 'month_name': month_name}}

    total = len(sites)
    ok = sum(1 for s in sites if s.status == 'ok')
    warn = sum(1 for s in sites if s.status == 'warn')
    crit = sum(1 for s in sites if s.status == 'crit')
    avail = (ok + warn * 0.7) / total * 100

    ranked = sorted(sites, key=_monthly_rank_key)
    worst = ranked[:5]
    best = list(reversed(ranked))[:5]

    nta_pass = sum(1 for s in sites if not any(nta_check(getattr(s, d['key'], None), d) == 'fail' for d in NTA_THRESHOLDS))
    nta_fail = total - nta_pass

    L = [
        f'# NEPAL TELECOM — MONTHLY NETWORK PERFORMANCE REPORT\n## {month_name}',
        f'**Generated:** {date_str} | **Region:** {region_label} | **Sites:** {total}',
        '---\n',
        '## 1. Executive Summary',
        '| Metric | Value |\n|--------|-------|',
        (
            f'| Total Sites | {total} |\n'
            f'| Operational | {ok} ({ok / total * 100:.0f}%) |\n'
            f'| Warning | {warn} ({warn / total * 100:.0f}%) |\n'
            f'| Critical | {crit} ({crit / total * 100:.0f}%) |\n'
            f'| Network Availability | **{avail:.1f}%** |\n'
            f'| NTA Compliant | {nta_pass}/{total} |'
        ),
        '\n## 2. KPI Performance Summary',
        '| KPI | Average | Min | Max | NTA Standard | Status |\n|-----|---------|-----|-----|--------------|--------|',
    ]
    for d in NTA_THRESHOLDS:
        avg, lo, hi = _monthly_avg(sites, d['key']), _monthly_min(sites, d['key']), _monthly_max(sites, d['key'])
        status = nta_check(avg, d)
        icon = {'pass': '✓ OK', 'warn': '⚠ WARN', 'fail': '✗ FAIL'}[status]
        standard = f"≥{d['min']}" if d['hi'] else f"≤{d['max']}"
        label = d['label'].split('(')[0].strip()
        L.append(f"| {label} | {avg:.1f}{d['unit']} | {lo:.1f}{d['unit']} | {hi:.1f}{d['unit']} | {standard}{d['unit']} | {icon} |")

    if style != 'board':
        L.append('\n## 3. Worst Performing Sites')
        L.append('| Rank | Site | Region | RRC SR | Call Drop | HO SR | IP Thru | Status |\n|------|------|--------|--------|-----------|-------|---------|--------|')
        for i, s in enumerate(worst, start=1):
            L.append(
                f'| {i} | {s.name or s.id} | {s.region} | {_fmt1(s.rrc, "%")} | {_fmt1(s.call_drop, "%")} | '
                f'{_fmt1(s.intra_ho, "%")} | {_fmt1(s.ip_thru, "M")} | {s.status.upper()} |'
            )
        L.append('\n## 4. Best Performing Sites')
        L.append('| Rank | Site | Region | RRC SR | Cell Avail | IP Thru |\n|------|------|--------|--------|-----------|---------|')
        for i, s in enumerate(best, start=1):
            L.append(f'| {i} | {s.name or s.id} | {s.region} | {_fmt1(s.rrc, "%")} | {_fmt1(s.cell_avail, "%")} | {_fmt1(s.ip_thru, "M")} |')

    if style == 'technical':
        L.append('\n## 5. Regional Breakdown')
        seen_regions = []
        for s in sites:
            if s.region and s.region not in seen_regions:
                seen_regions.append(s.region)
        for r in seen_regions:
            rs = [s for s in sites if s.region == r]
            L.append(
                f"### {r} ({len(rs)} sites) — RRC:{_monthly_avg(rs, 'rrc'):.1f}% | "
                f"CDR:{_monthly_avg(rs, 'call_drop'):.1f}% | HO:{_monthly_avg(rs, 'intra_ho'):.1f}% | "
                f"Thru:{_monthly_avg(rs, 'ip_thru'):.1f}M | PRB:{_monthly_avg(rs, 'prb'):.1f}%"
            )

    sec_n = '3' if style == 'board' else '6' if style == 'technical' else '5'
    L.append(f'\n## {sec_n}. NTA Regulatory Compliance')
    L.append(f'**Compliant:** {nta_pass} ({nta_pass / total * 100:.0f}%) | **Non-compliant:** {nta_fail}')
    if nta_fail > 0:
        L.append('\n**Sites requiring NTA attention:**')
        for s in sites:
            issues = [
                ' '.join(d['label'].split(' ')[:3])
                for d in NTA_THRESHOLDS
                if nta_check(getattr(s, d['key'], None), d) == 'fail'
            ]
            if issues:
                L.append(f"- **{s.name or s.id}**: {', '.join(issues)}")

    L.append('\n## Recommendations')
    if crit > 0:
        L.append(f'- **P1 IMMEDIATE:** {crit} critical site(s) — dispatch field teams within 24 hours')
    if nta_fail > 0:
        L.append(f'- **P1 REGULATORY:** {nta_fail} NTA violation(s) — initiate corrective action plans immediately')
    high_prb = [s for s in sites if s.prb is not None and s.prb > 85]
    if high_prb:
        L.append(f'- **P2 CAPACITY:** {len(high_prb)} site(s) with PRB >85% — capacity upgrade planning required')
    L.append('- **P3 ROUTINE:** Continue drive test programme and quarterly RF audit schedule')
    L.append(f'\n---\n*{month_name} — Nepal Telecom DT-WATCH BTS — {date_str}*')

    return {
        'markdown': '\n'.join(L),
        'meta': {'site_count': total, 'region': region, 'month_name': month_name},
    }


# ── Scatter Plot ─────────────────────────────────────────────────────────
# Ported from bts_monitor.html's SCATTER_KPIS constant (~line 12785-12792).
# Unlike SLA/NTA/Monthly, v1's Scatter Plot does no server-side
# aggregation at all — renderScatterPlot() reads straight from the
# client's in-memory SITES[] array and draws directly to a <canvas> (axis
# scaling, linear regression, Pearson correlation, hover tooltip, click-
# to-select all computed client-side). So this endpoint's only job is to
# hand the frontend the raw per-site KPI values (via SiteScatterSerializer)
# — the chart math itself is ported into ScatterPlotPage.tsx instead of
# living here, mirroring where v1 actually does the work.
SCATTER_KPIS = [
    {'key': 'rrc', 'label': 'RRC Setup SR (%)'},
    {'key': 'call_drop', 'label': 'Call Drop Rate (%)'},
    {'key': 'intra_ho', 'label': 'Intra-HO SR (%)'},
    {'key': 'ip_thru', 'label': 'IP Throughput (Mbps)'},
    {'key': 'ip_lat', 'label': 'IP Latency (ms)'},
    {'key': 'prb', 'label': 'PRB Utilization (%)'},
    {'key': 'cell_avail', 'label': 'Cell Availability (%)'},
    {'key': 'rssi', 'label': 'RSSI (dBm)'},
    {'key': 'load', 'label': 'Traffic Load (%)'},
    {'key': 'erab', 'label': 'E-RAB SR (%)'},
    {'key': 'bearer_util', 'label': 'Bearer Util (%)'},
    {'key': 'lic_util', 'label': 'License Util (%)'},
]

# v1's REGION_COLORS (~line 12793) — v2's Site.region already stores the
# same 5 traditional NTC operational regions (Central/Eastern/Western/
# Mid-West/Far-West), not the 7 modern provinces, per the Phase 1 sidebar-
# tree region fix — so this palette ports as-is, no remapping needed.
REGION_COLORS = {
    'Central': '#7f77dd', 'Western': '#14b8a6', 'Eastern': '#f97316',
    'Mid-West': '#eab308', 'Far-West': '#ef4444', 'Himalayan': '#38bdf8',
}


def build_scatter_data():
    return {
        'kpis': SCATTER_KPIS,
        'region_colors': REGION_COLORS,
        'sites': SiteScatterSerializer(Site.objects.all(), many=True).data,
    }


# ── Views ────────────────────────────────────────────────────────────────
# Read: any authenticated role for all reporting endpoints, matching v1
# (these are view-only menus in DEFAULT_PERMS — no CRUD write side to any
# of them, so there's nothing to gate more finely than "logged in").

class SlaReportView(APIView):
    """Matches v1's SLA Tracker exactly (openSlaModal/renderSlaTracker/
    siteSlaScore, bts_monitor.html ~line 8355-8480): weighted per-site
    score against SLA_TARGETS, banded into compliant (>=80) / partial
    (50-79) / breach (<50) / no-data, worst-first."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        region = request.query_params.get('region', 'all')
        return Response(build_sla_report(region))


class NtaReportView(APIView):
    """Matches v1's NTA Regulatory Compliance report exactly
    (renderNtaReport/ntaCheck, bts_monitor.html ~line 12399-12503).
    `pane=all-sites` (default) or `pane=violations` (warn/fail only)."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pane = request.query_params.get('pane', 'all-sites')
        return Response(build_nta_report(pane))


class MonthlyReportView(APIView):
    """Matches v1's generateMonthlyReport() exactly (bts_monitor.html
    ~line 12664-12738), including the one deliberate deviation noted in
    _fmt1()'s docstring (render "—" instead of crashing on a null KPI
    field a v1 browser would `.toFixed()` straight into a TypeError).
    Query params: `month` (YYYY-MM, label only — see module docstring),
    `style` (executive/board/technical, default executive), `region`
    (default all)."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        month = request.query_params.get('month')
        style = request.query_params.get('style', 'executive')
        region = request.query_params.get('region', 'all')
        return Response(build_monthly_report(month, style, region))


class ScatterDataView(APIView):
    """Raw per-site KPI data for the Scatter Plot report — see the module
    section above for why this endpoint does no aggregation, unlike its
    SLA/NTA/Monthly Report siblings in this file."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(build_scatter_data())
