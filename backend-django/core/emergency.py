"""Emergency switch for rescue search (2026-10-05).

Rescue search is off by default. A superadmin declares an emergency, which
turns it on for 7 days by default (up to 30). The superadmin can change the
reason or the end date while it's active, or end it early. It also switches
itself off when it expires.

This is a separate control from RescueConsentPolicy (core/models.py). That
one widens how strictly consent is checked. This one gates whether rescue
search is available at all.
"""
from datetime import timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import EmergencyDeclaration
from .views import IsSuperadminOnly
from .audit import log_audit_event

DEFAULT_DAYS = 7
MAX_DAYS = 30
EMERGENCY_OFF_DETAIL = 'Rescue search is off. A superadmin must declare an emergency to turn it on.'


def active_emergency(now=None):
    now = now or timezone.now()
    return (
        EmergencyDeclaration.objects
        .filter(ended_at__isnull=True, expires_at__gt=now)
        .order_by('-declared_at')
        .first()
    )


def rescue_search_enabled():
    return active_emergency() is not None


def _describe(decl):
    if decl is None:
        return {'active': False, 'default_days': DEFAULT_DAYS, 'max_days': MAX_DAYS}
    return {
        'active': True,
        'id': decl.id,
        'reason': decl.reason,
        'declared_at': decl.declared_at,
        'expires_at': decl.expires_at,
        'declared_by': decl.declared_by.username if decl.declared_by else None,
        'default_days': DEFAULT_DAYS,
        'max_days': MAX_DAYS,
    }


class EmergencyStatusView(APIView):
    """`GET /api/v2/emergency/` -- any signed-in user can see whether an
    emergency is active, so rescue operators know if search is on."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(_describe(active_emergency()))


class EmergencyDeclareView(APIView):
    """`POST /api/v2/emergency/declare/` -- body `{"reason": "...", "days": 7}`.
    Superadmin only. Declares an emergency, or modifies the one already
    active (new reason and/or end date). Every change is audited."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def post(self, request):
        reason = str(request.data.get('reason') or '').strip()[:255]
        if not reason:
            return Response({'detail': 'reason is required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            days = int(request.data.get('days', DEFAULT_DAYS))
        except (TypeError, ValueError):
            return Response({'detail': 'days must be a whole number'}, status=status.HTTP_400_BAD_REQUEST)
        if not 1 <= days <= MAX_DAYS:
            return Response({'detail': f'days must be between 1 and {MAX_DAYS}'},
                            status=status.HTTP_400_BAD_REQUEST)

        expires_at = timezone.now() + timedelta(days=days)
        current = active_emergency()
        if current is None:
            decl = EmergencyDeclaration.objects.create(
                reason=reason, declared_by=request.user, expires_at=expires_at,
            )
            action = 'EMERGENCY.DECLARED'
        else:
            current.reason = reason
            current.expires_at = expires_at
            current.save(update_fields=['reason', 'expires_at'])
            decl = current
            action = 'EMERGENCY.MODIFIED'

        log_audit_event(request, action, resource='emergency', resource_id=str(decl.id),
                        detail=f'days={days} reason={reason}')
        return Response(_describe(decl), status=status.HTTP_201_CREATED if action.endswith('DECLARED') else 200)


class EmergencyEndView(APIView):
    """`POST /api/v2/emergency/end/` -- superadmin only. Ends the active
    emergency now, so rescue search goes back off."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def post(self, request):
        current = active_emergency()
        if current is None:
            return Response({'detail': 'no active emergency'}, status=status.HTTP_404_NOT_FOUND)
        current.ended_at = timezone.now()
        current.ended_by = request.user
        current.save(update_fields=['ended_at', 'ended_by'])
        log_audit_event(request, 'EMERGENCY.ENDED', resource='emergency', resource_id=str(current.id),
                        detail=f'reason={current.reason}')
        return Response({'active': False})
