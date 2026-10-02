"""Active IP blocking (2026-10-02, Phase E2 -- "can we block the ip, if
mistakenly blocked, superadmin can unblock"). Escalates `core/audit.py`'s
existing attack-attempt DETECTION (a visible flag on the Audit Log) into
actual ENFORCEMENT (further local-login attempts from that IP are
rejected before `authenticate()` is ever called) -- while giving a
superadmin a durable, reversible way to correct a false positive (e.g. a
shared office/NAT IP where several people mistype their own passwords in
the same few minutes).

Reuses `core/audit.py`'s `_SUSPICIOUS_FAILURE_EVENTS`/`_SUSPICIOUS_WINDOW`/
`_SUSPICIOUS_THRESHOLD` directly -- one definition of "what counts as a
burst," shared by the Audit Log's passive flag and this module's active
block, so they can never silently drift apart. Those constants are
upper-cased (matching the merged Audit Log row shape); `maybe_auto_block()`
queries `AuthEventLog` directly, whose `event` column is lower-case, hence
the one `.lower()` normalization below.

Scope: **local login only** (`core/views.py`'s `LoginView`), not SSO --
same boundary Phase C's MFA already draws, for the same reason (Keycloak
owns SSO's own brute-force posture; blocking DT-WATCH's own
`/auth/sso/login/` redirect entry point adds real complexity for a path
that isn't where local credential-stuffing actually happens).
`SSO_LOGIN_FAILED` still counts toward the Audit Log's own detection as it
already did -- only the enforcement in this module is local-login-scoped.
"""
from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import _SUSPICIOUS_FAILURE_EVENTS, _SUSPICIOUS_THRESHOLD, _SUSPICIOUS_WINDOW, log_audit_event
from .models import AuthEventLog, BlockedIP
from .views import IsSuperadminOnly

_LOWER_FAILURE_EVENTS = {e.lower() for e in _SUSPICIOUS_FAILURE_EVENTS}


def is_ip_blocked(ip):
    if not ip:
        return False
    return BlockedIP.objects.filter(ip_address=ip, is_active=True).exists()


def maybe_auto_block(request, ip):
    """Called right after a local-login failure is logged. Counts this
    IP's failure-type events in the trailing `_SUSPICIOUS_WINDOW` and, if
    the burst has reached `_SUSPICIOUS_THRESHOLD`, creates (or
    reactivates, if a superadmin had previously unblocked this same IP)
    an active `BlockedIP` row -- same moment the Audit Log would start
    showing this IP as suspicious. Swallows its own errors -- same
    posture as `log_auth_event()`/`log_audit_event()`: a blocking-decision
    bug must never break the login response itself."""
    if not ip:
        return
    try:
        window_start = timezone.now() - _SUSPICIOUS_WINDOW
        count = AuthEventLog.objects.filter(
            ip_address=ip, event__in=_LOWER_FAILURE_EVENTS, created_at__gte=window_start,
        ).count()
        if count < _SUSPICIOUS_THRESHOLD:
            return

        reason = f'Auto: {count} failed login attempts from this IP within 15 minutes'
        obj, created = BlockedIP.objects.get_or_create(
            ip_address=ip, defaults={'reason': reason},
        )
        if not created and not obj.is_active:
            # Previously unblocked, now re-triggering -- reactivate rather
            # than leaving the stale unblock record looking current.
            obj.is_active = True
            obj.reason = reason
            obj.unblocked_at = None
            obj.unblocked_by = None
            obj.save(update_fields=['is_active', 'reason', 'unblocked_at', 'unblocked_by'])
        elif not created:
            # Already active -- just keep the reason/count current.
            obj.reason = reason
            obj.save(update_fields=['reason'])

        from .auth_log import log_auth_event
        log_auth_event(request, AuthEventLog.EVENT_LOGIN_IP_BLOCKED, detail=reason)
        log_audit_event(request, 'IP.AUTO_BLOCKED', resource='blocked_ip', resource_id=ip, detail=reason)
    except Exception:
        import logging
        logging.getLogger(__name__).exception('maybe_auto_block failed for ip=%s', ip)


class BlockedIPSerializer(serializers.ModelSerializer):
    blocked_by_username = serializers.SerializerMethodField()
    unblocked_by_username = serializers.SerializerMethodField()

    class Meta:
        model = BlockedIP
        fields = [
            'id', 'ip_address', 'reason', 'blocked_at', 'blocked_by_username',
            'is_active', 'unblocked_at', 'unblocked_by_username',
        ]

    def get_blocked_by_username(self, obj):
        return obj.blocked_by.username if obj.blocked_by else None

    def get_unblocked_by_username(self, obj):
        return obj.unblocked_by.username if obj.unblocked_by else None


class BlockedIPListView(APIView):
    """GET/POST /api/v2/blocked-ips/ -- same combined-verbs-on-one-class
    shape as BrandingSettingsView/SecuritySettingsView elsewhere in this
    app.

    GET: every BlockedIP row, newest-first, active and historical both, so
    a superadmin can see past, since-corrected blocks too, not just
    currently-active ones.

    POST: body {"ip_address": "...", "reason": "..."} -- lets a
    superadmin proactively block an IP noticed in the Audit Log without
    waiting for the 3-in-15-minutes auto-trigger. `blocked_by=request.user`
    always (never null) -- that's what distinguishes a manual block from
    an automatic one in the UI."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        rows = BlockedIP.objects.select_related('blocked_by', 'unblocked_by').all()
        return Response(BlockedIPSerializer(rows, many=True).data)

    def post(self, request):
        ip = (request.data.get('ip_address') or '').strip()
        reason = (request.data.get('reason') or '').strip() or 'Manually blocked'
        if not ip:
            return Response({'ip_address': ['This field is required.']}, status=status.HTTP_400_BAD_REQUEST)

        obj, created = BlockedIP.objects.get_or_create(
            ip_address=ip, defaults={'reason': reason, 'blocked_by': request.user},
        )
        if not created:
            obj.is_active = True
            obj.reason = reason
            obj.blocked_by = request.user
            obj.unblocked_at = None
            obj.unblocked_by = None
            obj.save(update_fields=['is_active', 'reason', 'blocked_by', 'unblocked_at', 'unblocked_by'])

        log_audit_event(request, 'IP.MANUALLY_BLOCKED', resource='blocked_ip', resource_id=ip, detail=reason)
        return Response(BlockedIPSerializer(obj).data, status=status.HTTP_201_CREATED)


class BlockedIPUnblockView(APIView):
    """POST /api/v2/blocked-ips/<ip>/unblock/ -- the actual "mistakenly
    blocked, superadmin can unblock" mechanism. Sets is_active=False and
    stamps unblocked_at/unblocked_by rather than deleting the row, so the
    correction stays visible in the list afterward."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def post(self, request, ip):
        obj = BlockedIP.objects.filter(ip_address=ip, is_active=True).first()
        if obj is None:
            return Response({'detail': 'No active block for this IP.'}, status=status.HTTP_404_NOT_FOUND)

        obj.is_active = False
        obj.unblocked_at = timezone.now()
        obj.unblocked_by = request.user
        obj.save(update_fields=['is_active', 'unblocked_at', 'unblocked_by'])

        log_audit_event(request, 'IP.UNBLOCKED', resource='blocked_ip', resource_id=ip)
        return Response(BlockedIPSerializer(obj).data)
