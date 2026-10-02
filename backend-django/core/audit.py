"""Generic data-change audit trail (2026-10-01, "Audit Log" follow-up to
core/auth_log.py's login/access trail -- "all system activity, data
changes, and access events" in one searchable place). See AuditEvent's
own docstring in core/models.py for the full design rationale.

`log_audit_event()` is the one write path. **Deliberately NOT a shared
ModelViewSet mixin** -- the first draft of this feature tried exactly
that (override perform_create/perform_update/perform_destroy once, mix it
into every ModelViewSet), but a close read of all 10 target ViewSets found
nearly every one already overrides at least one of those same hook points
for its own reasons (SiteViewSet/RoleViewSet.destroy() bypass them
entirely with a hand-written create()/update()/destroy(); ApiKeyViewSet/
TelemetryIngestKeyViewSet/IssueViewSet/RfOptimizationReportViewSet/
OptimizationActivityViewSet already define perform_create and sometimes
perform_update themselves). A method defined directly on a subclass
always wins over anything from a mixin regardless of MRO order, so a
mixin here would have silently failed to fire for most of these --
worse than not having one at all, since it would look covered without
being covered. Each ViewSet instead gets one explicit `log_audit_event(...)`
call added at its own existing (or newly added) perform_create/
perform_update/perform_destroy -- more lines touched, but every single one
independently verified to actually fire.
"""
import csv
import logging
from datetime import timedelta

from django.db.models import Q
from rest_framework import pagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from django.http import HttpResponse

from .auth_log import _client_ip
from .models import AuditEvent, AuthEventLog
from .views import IsSuperadminOnly

logger = logging.getLogger(__name__)


def log_audit_event(request, action, resource='', resource_id='', detail='', payload=None):
    """Writes one AuditEvent row. Swallows its own errors -- same posture
    as log_auth_event() in core/auth_log.py: an audit-trail write must
    never break the real action it's recording."""
    try:
        user = getattr(request, 'user', None)
        AuditEvent.objects.create(
            actor=user if user and user.is_authenticated else None,
            actor_username=(user.username if user and user.is_authenticated else '')[:150],
            action=action[:60],
            resource=resource[:40],
            resource_id=str(resource_id)[:40] if resource_id else '',
            ip_address=_client_ip(request),
            detail=detail[:200],
            payload=payload,
        )
    except Exception:
        logger.exception('Failed to write AuditEvent row (action=%s)', action)


# ── Unified read API ──────────────────────────────────────────────────────

def _normalize_access_row(row):
    return {
        'source': 'access',
        'id': f'access-{row.id}',
        'created_at': row.created_at,
        'actor': (row.user.name or row.user.username) if row.user else (row.username or '(unknown)'),
        'action': row.event.upper(),
        'resource': 'auth',
        'detail': row.detail,
        'ip_address': row.ip_address,
        'payload': None,
    }


def _normalize_audit_row(row):
    return {
        'source': 'data_change',
        'id': f'data_change-{row.id}',
        'created_at': row.created_at,
        'actor': (row.actor.name or row.actor.username) if row.actor else (row.actor_username or '(unknown)'),
        'action': row.action,
        'resource': row.resource,
        'detail': row.detail,
        'ip_address': row.ip_address,
        'payload': row.payload,
    }


# Attack-attempt detection (2026-10-02, Phase E of the auth-hardening
# pass) -- a lower bar (3) than the existing per-USERNAME lockout's 5
# (core/views.py's LoginView), deliberately: this catches a DIFFERENT
# pattern -- one IP trying many different accounts -- which the per-
# account lockout never sees until each individual username separately
# hits 5. One IP hammering several accounts is generally a more alarming
# signal than one person mistyping their own password repeatedly.
_SUSPICIOUS_FAILURE_EVENTS = {'LOGIN_FAILED', 'LOGIN_LOCKED', 'SSO_LOGIN_FAILED'}
_SUSPICIOUS_WINDOW = timedelta(minutes=15)
_SUSPICIOUS_THRESHOLD = 3


def _annotate_suspicious(rows):
    """Flags any row that is part of a burst of >= `_SUSPICIOUS_THRESHOLD`
    failure-type ACCESS events from the SAME `ip_address` within a
    trailing `_SUSPICIOUS_WINDOW` -- mutates every row in place, adding
    `is_suspicious`/`suspicious_reason` (every row gets `is_suspicious:
    False` even when not flagged, so a caller never has to treat a
    missing key as "not suspicious" itself).

    The window is evaluated per EVENT, not once for the whole list: for
    each failure event, count how many of that same IP's failure events
    (including itself) fall within the preceding 15 minutes. This
    correctly flags multiple independent bursts across a longer-ranged
    view (e.g. "last 24 hours") rather than only ever checking one
    whole-list-wide window.

    Deliberate, documented scope limit: this runs over whatever `rows`
    the caller already assembled for the current view/filter -- not a
    separate always-full-history scan. Most meaningful on the default
    (recent, unfiltered) view, exactly when a security admin would
    actually be looking. No persisted alert, no outbound notification --
    this is a visible flag on the Audit Log itself, not a push alert;
    this app has no channel to hang one on beyond the email infrastructure
    Phase A/B added, which a future pass could wire up, not built here."""
    by_ip = {}
    for row in rows:
        row['is_suspicious'] = False
        row['suspicious_reason'] = ''
        if row['source'] != 'access' or not row['ip_address']:
            continue
        if row['action'] not in _SUSPICIOUS_FAILURE_EVENTS:
            continue
        by_ip.setdefault(row['ip_address'], []).append(row)

    for ip, ip_rows in by_ip.items():
        # Oldest-first for the sliding window below -- the overall `rows`
        # list is newest-first (the API's own sort order), but walking a
        # per-IP window needs to move forward through time.
        ip_rows.sort(key=lambda r: r['created_at'])
        window_start = 0
        for i, row in enumerate(ip_rows):
            while row['created_at'] - ip_rows[window_start]['created_at'] > _SUSPICIOUS_WINDOW:
                window_start += 1
            count = i - window_start + 1
            if count >= _SUSPICIOUS_THRESHOLD:
                row['is_suspicious'] = True
                row['suspicious_reason'] = f'{count} failed login attempts from {ip} within 15 minutes'
    return rows


def _filtered_rows(params):
    """Shared filter + merge logic for both AuditLogListView and
    AuditLogExportView -- fetches AuthEventLog + AuditEvent rows matching
    the request's `q`/`date_from`/`date_to`/`source` query params,
    normalizes both into one common shape, and returns them merged and
    sorted newest-first. Loaded fully into Python rather than a raw SQL
    UNION -- the Audit Log's own 1-month retention cap (prune_audit_log.py)
    keeps both tables small enough that this is simpler and safer than
    hand-rolled cross-table pagination, at the cost of not scaling past
    that assumption -- acceptable for a superadmin-only diagnostic page,
    not a high-QPS endpoint."""
    q = (params.get('q') or '').strip()
    date_from = params.get('date_from')
    date_to = params.get('date_to')
    source = params.get('source')

    access_qs = AuthEventLog.objects.select_related('user').all()
    audit_qs = AuditEvent.objects.select_related('actor').all()

    if date_from:
        access_qs = access_qs.filter(created_at__date__gte=date_from)
        audit_qs = audit_qs.filter(created_at__date__gte=date_from)
    if date_to:
        access_qs = access_qs.filter(created_at__date__lte=date_to)
        audit_qs = audit_qs.filter(created_at__date__lte=date_to)
    if q:
        access_qs = access_qs.filter(
            Q(username__icontains=q) | Q(user__username__icontains=q)
            | Q(event__icontains=q) | Q(detail__icontains=q)
        )
        audit_qs = audit_qs.filter(
            Q(actor_username__icontains=q) | Q(actor__username__icontains=q)
            | Q(action__icontains=q) | Q(resource__icontains=q) | Q(detail__icontains=q)
        )

    rows = []
    if source != 'data_change':
        rows.extend(_normalize_access_row(r) for r in access_qs)
    if source != 'access':
        rows.extend(_normalize_audit_row(r) for r in audit_qs)
    rows.sort(key=lambda r: r['created_at'], reverse=True)
    # Annotated here, not separately in each caller, so both
    # AuditLogListView and AuditLogExportView always get it -- see
    # _annotate_suspicious()'s own docstring.
    _annotate_suspicious(rows)
    return rows


class AuditLogPagination(pagination.PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500


class AuditLogListView(APIView):
    """GET /api/v2/audit-log/ -- superadmin-only, merges AuthEventLog
    (access events) and AuditEvent (data-change events) into one
    newest-first paginated feed. Query params: `q` (free text across
    actor/action/resource/detail), `date_from`/`date_to` (YYYY-MM-DD,
    inclusive), `source` (`access`/`data_change`/omit for both),
    `page`/`page_size` (default 50, matching the old AccessLogPage's own
    default)."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]
    pagination_class = AuditLogPagination

    def get(self, request):
        rows = _filtered_rows(request.query_params)
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(rows, request, view=self)
        return paginator.get_paginated_response(page)


class AuditLogExportView(APIView):
    """GET /api/v2/audit-log/export.csv -- same filters as AuditLogListView
    minus pagination; returns every matching row (not just the current
    page) as a CSV download. First server-side CSV export in this
    codebase -- the existing Advanced Site Search export is client-side
    only (built from whatever's already in React state), which doesn't
    fit here since "export" should mean the full filtered result set
    within the 1-month retention window, not just the 50 rows on screen."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        rows = _filtered_rows(request.query_params)
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="audit_log.csv"'
        writer = csv.writer(response)
        writer.writerow([
            'Timestamp', 'Actor', 'Action', 'Resource', 'Detail', 'IP Address', 'Payload',
            'Suspicious', 'Suspicious Reason',
        ])
        for r in rows:
            writer.writerow([
                r['created_at'].isoformat(), r['actor'], r['action'], r['resource'],
                r['detail'], r['ip_address'] or '', r['payload'] or '',
                'yes' if r['is_suspicious'] else '', r['suspicious_reason'],
            ])
        return response
