"""
Site/Sector Issue tracker (2026-09-14) — gets its own module for the same
reason drive_test.py/kpi_trend.py/rf_audit.py do: a real new model
(Issue), not aggregation over Site like reports.py, and a distinct
feature area from the Drive-Test Data Manager even though it links to
OptimizationActivity there. See Issue's docstring in models.py for the
full workflow this exists for.
"""
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from .models import Issue
from .serializers import IssueSerializer
from .views import IsAdminOrSuperadmin


class IssueViewSet(viewsets.ModelViewSet):
    """`/api/v2/issues/` — standard CRUD for site/sector issues.

    Read (list/retrieve): any authenticated role, matching every other
    O&M read surface in this app (DriveTestSessionViewSet,
    OptimizationActivityViewSet) -- any engineer should be able to see
    what issues are open, not just admins. Write (create/update/partial_
    update/destroy): superadmin or admin only, same tier as creating/
    editing an OptimizationActivity or a DriveTestSession.

    Filtering via query params (`?status=`, `?site=`, `?assignee=`) —
    same plain `get_queryset()` override pattern SiteViewSet already
    uses (views.py), not a separate django-filter dependency this repo
    doesn't otherwise use.
    """
    queryset = Issue.objects.select_related('site', 'sector', 'assignee', 'created_by', 'resolved_by_activity')
    serializer_class = IssueSerializer

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsAuthenticated(), IsAdminOrSuperadmin()]
        return [IsAuthenticated()]

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        status_param = params.get('status')
        site_param = params.get('site')
        assignee_param = params.get('assignee')
        severity_param = params.get('severity')
        if status_param:
            qs = qs.filter(status=status_param)
        if site_param:
            qs = qs.filter(site_id=site_param)
        if assignee_param:
            qs = qs.filter(assignee_id=assignee_param)
        if severity_param:
            qs = qs.filter(severity=severity_param)
        return qs

    def perform_create(self, serializer):
        user = self.request.user
        serializer.save(created_by=user if user and user.is_authenticated else None)

    def perform_update(self, serializer):
        # Keep `resolved_at` in sync with `status` on a direct PATCH too
        # (not just the OptimizationActivitySerializer.create() side
        # effect path) -- same "business logic sets the timestamp"
        # convention Issue.resolved_at's own comment in models.py
        # documents. Stamps resolved_at the moment status *becomes*
        # 'resolved' and clears it the moment status moves *away* from
        # 'resolved', and leaves it alone otherwise (e.g. re-saving an
        # already-resolved issue with just a new description shouldn't
        # bump resolved_at).
        instance = self.get_object()
        was_resolved = instance.status == 'resolved'
        new_status = serializer.validated_data.get('status', instance.status)
        if new_status == 'resolved' and not was_resolved:
            serializer.save(resolved_at=timezone.now())
        elif new_status != 'resolved' and was_resolved:
            serializer.save(resolved_at=None)
        else:
            serializer.save()
