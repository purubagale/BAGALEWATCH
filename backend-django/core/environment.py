"""Outdoors, inside a building or in a vehicle, set afterwards (2026-10-26).

Phones tag each reading as they take it (SDK collector/Environment.kt): the
person's tap ('user'), or an estimate from speed and GPS accuracy
('estimated'). A forgotten tap is fixed here: pick a stretch of a session on
the web and say where it was. Those readings become 'edited'.

    POST /api/v2/telemetry/environment/
         {"collection_session": "<uuid>" | "telemetry_session": <id>,
          "from": "<iso>", "to": "<iso>", "environment": "outdoor" | "indoor" | "vehicle" | ""}

An empty environment clears the tag. Admin and superadmin; every change is
written to the Audit Log.
"""
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .models import CollectionSession, TelemetryDriveTestSession, TelemetrySample
from .views import IsAdminOrSuperadmin

ENVIRONMENTS = ('outdoor', 'indoor', 'vehicle')
LABELS = {'outdoor': 'Outdoors', 'indoor': 'Inside a building', 'vehicle': 'In a vehicle'}


class EnvironmentEditView(APIView):
    permission_classes = [IsAdminOrSuperadmin]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        env = str(data.get('environment') or '')
        if env and env not in ENVIRONMENTS:
            return Response({'detail': 'Choose outdoors, inside a building or in a vehicle.'}, status=400)
        start, end = parse_datetime(str(data.get('from') or '')), parse_datetime(str(data.get('to') or ''))
        if start is None or end is None or end < start:
            return Response({'detail': 'Give the start and end of the stretch.'}, status=400)
        if data.get('collection_session'):
            s = get_object_or_404(CollectionSession, pk=data['collection_session'])
            if not s.drive_session_id:
                return Response({'detail': 'This session has no phone readings to tag.'}, status=400)
            qs = TelemetrySample.objects.filter(device_id=s.device_hash, drive_session_id=s.drive_session_id)
            what = f'collection {s.pk}'
        elif data.get('telemetry_session'):
            from .telemetry_admin import session_samples_qs
            s = get_object_or_404(TelemetryDriveTestSession, pk=data['telemetry_session'])
            qs = TelemetrySample.objects.filter(pk__in=session_samples_qs(s, request.user)[0].values('pk'))
            what = f'telemetry session {s.pk}'
        else:
            return Response({'detail': 'Say which session.'}, status=400)
        n = qs.filter(ts__gte=start, ts__lte=end).update(
            environment=env or None, environment_source='edited' if env else None)
        log_audit_event(request, 'TELEMETRY.ENVIRONMENT_SET', resource='telemetry_samples', resource_id=what,
                        detail=f'{env or "cleared"} {start.isoformat()} to {end.isoformat()} ({n} readings)')
        return Response({'updated': n, 'environment': env or None})
