"""Multi-role RBAC admin surface (2026-10-01, "full parity" with a
reference app's Manage Roles / Assign Roles / dynamic Permission Matrix /
Menu Visibility screens). See Role/MenuItemRoleVisibility's own docstrings
in core/models.py for the schema this sits on top of, and
get_visible_menu_items()/PermissionsMatrixView in core/views.py for how
the rest of the app's existing access control was extended (additively,
not replaced) to use it.

Two distinct concerns, same one-file-per-feature convention as
api_auth.py/rescue.py/issues.py:

1. `RoleViewSet` — superadmin-only CRUD for custom role DEFINITIONS
   (name/label/description), backing the Manage Roles page. Protects the
   4 builtin roles from rename (RoleSerializer.validate()) and delete
   (destroy() below) — every DRF permission class and MenuItem access
   tier hardcodes those literal strings.
2. `UserRolesView` — superadmin-only GET/PUT of one user's full `roles`
   set, backing the Assign Roles page. Full-replace (not per-chip add/
   remove), since AssignRolesPage always has the complete target set in
   hand when it saves — same convention TreeView/PermissionsMatrixView
   already use elsewhere in this app for "send your whole current state"
   endpoints. Refuses to leave a user with zero builtin-tier roles (the
   "don't lock an account out of every privilege-tier check" guard)."""
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .models import MenuPermission, Role
from .serializers import RoleSerializer
from .views import IsSuperadminOnly, User

BUILTIN_ROLE_NAMES = {'superadmin', 'admin', 'viewer', 'rescue_operator'}


class RoleViewSet(viewsets.ModelViewSet):
    """`/api/v2/roles/` — superadmin-only, matching this app's usual
    superadmin-gated-admin-page convention (Users, Menu Admin,
    Permissions, Branding, API Access)."""
    queryset = Role.objects.all()
    serializer_class = RoleSerializer
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def perform_create(self, serializer):
        serializer.save()
        log_audit_event(self.request, 'ROLE.CREATED', resource='role',
                         resource_id=serializer.instance.pk, detail=serializer.instance.name)

    def perform_update(self, serializer):
        serializer.save()
        log_audit_event(self.request, 'ROLE.UPDATED', resource='role',
                         resource_id=serializer.instance.pk, detail=serializer.instance.name)

    def update(self, request, *args, **kwargs):
        # Renaming a custom role must carry its MenuPermission rows along
        # (that table keys on the plain role-name string, not an FK — see
        # Role's own docstring for why) — otherwise a renamed role's
        # permissions silently vanish, looking like a bug rather than the
        # rename's own side effect. Builtin roles can't reach this path
        # with a changed name at all (RoleSerializer.validate() already
        # blocks it), so this only ever fires for a real custom-role
        # rename.
        role = self.get_object()
        old_name = role.name
        with transaction.atomic():
            response = super().update(request, *args, **kwargs)
            role.refresh_from_db()
            if role.name != old_name:
                MenuPermission.objects.filter(role=old_name).update(role=role.name)
        return response

    def destroy(self, request, *args, **kwargs):
        role = self.get_object()
        if role.is_builtin:
            return Response(
                {'detail': 'Builtin roles cannot be deleted.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            # MenuItemRoleVisibility rows cascade via their real FK to
            # Role already (on_delete=CASCADE) — only MenuPermission,
            # which keys on the plain name string, needs an explicit
            # cleanup pass here.
            role_id, role_name = role.pk, role.name
            MenuPermission.objects.filter(role=role.name).delete()
            role.delete()
        # role.pk is None after .delete() (Django clears it) -- captured
        # above, before the delete, not read off the now-cleared instance.
        log_audit_event(request, 'ROLE.DELETED', resource='role', resource_id=role_id, detail=role_name)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserRolesView(APIView):
    """GET/PUT /api/v2/users/<pk>/roles/ — see module docstring."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request, pk):
        user = get_object_or_404(User, pk=pk)
        return Response(list(user.roles.values('id', 'name', 'label')))

    def put(self, request, pk):
        user = get_object_or_404(User, pk=pk)
        old_names = list(user.roles.values_list('name', flat=True))
        names = request.data.get('roles') or []
        roles = list(Role.objects.filter(name__in=names))
        if not any(r.name in BUILTIN_ROLE_NAMES for r in roles):
            return Response(
                {'roles': ['User must keep at least one builtin role (superadmin/admin/viewer/rescue_operator).']},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user.roles.set(roles)
        log_audit_event(
            request, 'USER_ROLES.UPDATED', resource='user_roles', resource_id=user.pk, detail=user.username,
            payload={'before': old_names, 'after': [r.name for r in roles]},
        )
        return Response(list(user.roles.values('id', 'name', 'label')))
