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
        writer.writerow(['Timestamp', 'Actor', 'Action', 'Resource', 'Detail', 'IP Address', 'Payload'])
        for r in rows:
            writer.writerow([
                r['created_at'].isoformat(), r['actor'], r['action'], r['resource'],
                r['detail'], r['ip_address'] or '', r['payload'] or '',
            ])
        return response
