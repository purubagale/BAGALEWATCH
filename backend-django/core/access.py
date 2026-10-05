"""Fine-grained permission codes (2026-10-05).

A user can hold a legacy builtin role (superadmin, admin, viewer,
rescue_operator) and any number of custom roles. The builtin checks in
views.py stay as they are. This module adds named capabilities on top:

    device.view_identity   per-device identity (MSISDN, IMEI, model) and the
                           operator's identified-data view
    drive.view             drive-test and collection sessions, without identity
    trace.investigate      start and manage a subscriber investigation
    trace.case             start and manage a case trace (rescue lookup)
    rescue.search          rescue location search (also needs an active emergency)

Superadmin holds every code. The rescue_operator builtin keeps the three
trace and rescue codes it already had, so nothing it does today is lost.
"""
from django.db.models import Q
from rest_framework import permissions

from .models import RolePermission

PERM_VIEW_IDENTITY = 'device.view_identity'
PERM_DRIVE_VIEW = 'drive.view'
PERM_TRACE_INVESTIGATE = 'trace.investigate'
PERM_TRACE_CASE = 'trace.case'
PERM_RESCUE_SEARCH = 'rescue.search'

ALL_CODES = (
    PERM_VIEW_IDENTITY,
    PERM_DRIVE_VIEW,
    PERM_TRACE_INVESTIGATE,
    PERM_TRACE_CASE,
    PERM_RESCUE_SEARCH,
)

# Grants that builtin roles already carry, kept so nothing loses access.
LEGACY_ROLE_GRANTS = {
    'rescue_operator': {PERM_TRACE_INVESTIGATE, PERM_TRACE_CASE, PERM_RESCUE_SEARCH},
}


def user_has(user, code):
    """True when the user holds `code`: superadmin always does, otherwise
    through a legacy grant or a custom role carrying it."""
    if not user or not user.is_authenticated:
        return False
    if user.role == 'superadmin':
        return True
    if code in LEGACY_ROLE_GRANTS.get(user.role, set()):
        return True
    return RolePermission.objects.filter(code=code).filter(
        Q(role__name=user.role) | Q(role__users=user)
    ).exists()


class HasPermission(permissions.BasePermission):
    """Base for DRF permission classes: subclasses set `code`."""
    code = None

    def has_permission(self, request, view):
        return user_has(request.user, self.code)


class CanViewIdentity(HasPermission):
    code = PERM_VIEW_IDENTITY


class CanViewDrives(HasPermission):
    code = PERM_DRIVE_VIEW


class CanRescueSearch(HasPermission):
    code = PERM_RESCUE_SEARCH


class IsTraceOperator(permissions.BasePermission):
    """Either trace kind. The kind-specific check happens in the view, so a
    user with only investigate can't create a case, and vice versa."""

    def has_permission(self, request, view):
        return user_has(request.user, PERM_TRACE_INVESTIGATE) or user_has(request.user, PERM_TRACE_CASE)
