"""Login/access audit trail (2026-10-01, "create one menu item to display
current log or history of the application with user or any unauthentic
access tried in the application. add this feature with efficient
tracking").

`log_auth_event()` is the one write path — called from the handful of
real decision points inside LoginView (core/views.py) and the SSO views
(core/sso_views.py), never from middleware or a background job (see
AuthEventLog's own docstring in models.py for why that's the "efficient"
part of this). It never lets a logging failure break a real login: any
exception writing the row is caught and logged to the normal Python
logger instead of propagating, since an audit-trail write is strictly
secondary to the actual authentication decision it's recording.

`AuthEventLogListView` is the one read path — a real server-side-paginated
GET (not a flat capped list like AuditHistoryListView's `[:50]`, since
this table is expected to accumulate every attempt indefinitely,
including failed/bot-driven ones, and could grow much larger than a
handful of saved audits). Superadmin-only: this is the exact feed a
brute-force/enumeration investigation would read, same sensitivity tier
as Permissions/Menu Admin/API Access.
"""
import logging

from django.db.models import Q
from rest_framework import pagination, serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import AuthEventLog
from .views import IsSuperadminOnly

logger = logging.getLogger(__name__)


def _client_ip(request):
    # Same X-Forwarded-For-first convention as every other client-IP read
    # in this codebase would need behind the nginx reverse proxy (see
    # nginx.conf's X-Real-IP/X-Forwarded-For headers on the /api/ location)
    # -- REMOTE_ADDR alone would just be the docker network's internal
    # nginx container address, not the real client.
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    if xff:
        return xff.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR')


def log_auth_event(request, event, username='', user=None, detail=''):
    """Writes one AuthEventLog row. `username` is the raw attempted value;
    if omitted and `user` is given, the resolved account's own username is
    used instead. Swallows its own errors -- see module docstring."""
    try:
        AuthEventLog.objects.create(
            event=event,
            username=(username or (user.username if user else ''))[:150],
            user=user,
            ip_address=_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:255],
            detail=detail[:200],
        )
    except Exception:
        logger.exception('Failed to write AuthEventLog row (event=%s)', event)


class AuthEventLogSerializer(serializers.ModelSerializer):
    # Resolved account's display name when there is one, else the raw
    # attempted username -- lets the frontend show one "who" column
    # regardless of whether the attempt ever resolved to a real account,
    # without a second round-trip to look up a deleted/renamed user.
    user_display = serializers.SerializerMethodField()
    is_success = serializers.SerializerMethodField()

    class Meta:
        model = AuthEventLog
        fields = [
            'id', 'event', 'username', 'user', 'user_display', 'is_success',
            'ip_address', 'user_agent', 'detail', 'created_at',
        ]

    def get_user_display(self, obj):
        if obj.user:
            return obj.user.name or obj.user.username
        return obj.username or '(unknown)'

    def get_is_success(self, obj):
        return obj.event in AuthEventLog.SUCCESS_EVENTS


class AuthEventLogPagination(pagination.PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500


class AuthEventLogListView(APIView):
    """GET /api/v2/auth-events/ -- superadmin-only, server-side paginated
    (see module docstring for why). Query params: `page`/`page_size`
    (pagination), `event` (exact match against AuthEventLog.EVENT_CHOICES),
    `username` (substring, matches the raw attempted value OR the resolved
    account's own username), `success` (`1` restricts to
    AuthEventLog.SUCCESS_EVENTS, `0` to everything else -- the quick
    "show me only the failures" toggle an investigation actually wants)."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]
    pagination_class = AuthEventLogPagination

    def get(self, request):
        qs = AuthEventLog.objects.select_related('user').all()

        event = request.query_params.get('event')
        if event:
            qs = qs.filter(event=event)

        username = (request.query_params.get('username') or '').strip()
        if username:
            qs = qs.filter(Q(username__icontains=username) | Q(user__username__icontains=username))

        success = request.query_params.get('success')
        if success == '1':
            qs = qs.filter(event__in=AuthEventLog.SUCCESS_EVENTS)
        elif success == '0':
            qs = qs.exclude(event__in=AuthEventLog.SUCCESS_EVENTS)

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request, view=self)
        serializer = AuthEventLogSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)
