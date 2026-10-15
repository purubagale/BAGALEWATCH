"""Status updates to linked systems (2026-10-15).

A linked NTC system (complaint desk, CRM, call centre) sends problem reports
through the external API (core/external_problem.py). Here a superadmin
gives each system the address where DT-WATCH tells it about its reports,
and chooses how:

    Automatic  an update is sent whenever a report's status or likely cause
               changes
    Manual     only when an engineer presses "Send update" on a report
    Off        never (the system can still ask with GET problem-reports/)

An update is a POST of JSON to the system's address:

    {"event": "status" | "cause" | "manual" | "test", "system": "<name>",
     "sent_at": "<ISO time>", "report": {external_ref, id, status, category,
     likely_cause, likely_cause_label, customer_reply, site_id, located_by,
     checked_at, updated_at}}

with the headers X-DTWatch-Timestamp (Unix seconds) and X-DTWatch-Signature
("sha256=" + hex HMAC-SHA256 of "<timestamp>.<body>" with the system's
secret), so the receiver can check it came from DT-WATCH and is fresh. Any
2xx answer counts as delivered. Otherwise it is tried again after
RETRY_MINUTES, up to MAX_ATTEMPTS, then marked failed (a superadmin can
send it again). Updates waiting for the same report are merged, and the
body is built from the report as it is at sending time.

    GET/POST   /api/v2/linked-systems/                   superadmin
    PATCH/DELETE /api/v2/linked-systems/<id>/            superadmin
    POST       /api/v2/linked-systems/<id>/secret/       new secret, shown once
    POST       /api/v2/linked-systems/<id>/test/         send a test update now
    GET        /api/v2/problem-notifications/            delivery log, superadmin
    POST       /api/v2/problem-notifications/<id>/retry/ superadmin
    POST       /api/v2/problem-reports/<id>/notify/      "Send update", admin
"""
import hashlib
import hmac
import json
import secrets
import time
from datetime import timedelta

import requests
from django.db import IntegrityError
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .models import LinkedSystem, ProblemNotification, ProblemReport
from .views import IsAdminOrSuperadmin, IsSuperadminOnly

SEND_TIMEOUT_SECONDS = 10
RETRY_MINUTES = (1, 5, 15, 60, 180, 360, 720)   # waits after the 1st, 2nd, ... failure
MAX_ATTEMPTS = len(RETRY_MINUTES) + 1
SEND_PER_PASS = 100
LOG_LIMIT = 200


def new_secret():
    return secrets.token_hex(24)


def _payload(report, event, system):
    from .external_problem import _status_row
    return {'event': event, 'system': system, 'sent_at': timezone.now().isoformat(),
            'report': _status_row(report)}


def _post(system, body):
    """(response code or None, error text) for one signed POST."""
    stamp = str(int(time.time()))
    raw = json.dumps(body, separators=(',', ':')).encode('utf-8')
    signature = hmac.new(system.notify_secret.encode(), stamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
    try:
        resp = requests.post(system.notify_url, data=raw, timeout=SEND_TIMEOUT_SECONDS, headers={
            'Content-Type': 'application/json',
            'User-Agent': 'DT-WATCH problem updates',
            'X-DTWatch-Timestamp': stamp,
            'X-DTWatch-Signature': f'sha256={signature}',
        })
    except requests.RequestException as exc:
        return None, f'Could not reach the address: {exc.__class__.__name__}'
    if 200 <= resp.status_code < 300:
        return resp.status_code, ''
    return resp.status_code, f'The address answered {resp.status_code}.'


def queue_update(report, event, user=None, manual=False):
    """Queues an update for a report from a linked system, or returns None
    when nothing is to be sent: not from a linked system, no active system
    with an address, or (unless pressed by hand) the system is not on
    Automatic. A waiting update for the same report is reused."""
    if report.source != ProblemReport.SOURCE_EXTERNAL or not report.external_system:
        return None
    system = LinkedSystem.objects.filter(name=report.external_system, is_active=True).first()
    if system is None or not system.notify_url or system.notify_mode == LinkedSystem.MODE_OFF:
        return None
    if not manual and system.notify_mode != LinkedSystem.MODE_AUTO:
        return None
    waiting = ProblemNotification.objects.filter(report=report, status=ProblemNotification.STATUS_PENDING).first()
    if waiting is not None:
        waiting.event = event if manual else waiting.event
        waiting.next_try_at = timezone.now()
        waiting.save(update_fields=['event', 'next_try_at'])
        return waiting
    return ProblemNotification.objects.create(
        report=report, system=system.name, event=event, next_try_at=timezone.now(),
        requested_by=user if manual else None)


def send_one(note):
    """Sends one waiting update now; records the outcome on it and the system."""
    system = LinkedSystem.objects.filter(name=note.system).first()
    now = timezone.now()
    if system is None or not system.is_active or not system.notify_url:
        note.status, note.last_error = ProblemNotification.STATUS_FAILED, 'The linked system is gone or has no address.'
        note.save(update_fields=['status', 'last_error'])
        return note
    code, error = _post(system, _payload(note.report, note.event, system.name))
    note.attempts += 1
    note.response_code = code
    note.last_error = error[:300]
    if not error:
        note.status, note.sent_at, note.next_try_at = ProblemNotification.STATUS_SENT, now, None
        system.last_sent_at, system.last_error = now, ''
    elif note.attempts >= MAX_ATTEMPTS:
        note.status, note.next_try_at = ProblemNotification.STATUS_FAILED, None
        system.last_error = error[:300]
    else:
        note.next_try_at = now + timedelta(minutes=RETRY_MINUTES[note.attempts - 1])
        system.last_error = error[:300]
    note.save(update_fields=['attempts', 'response_code', 'last_error', 'status', 'sent_at', 'next_try_at'])
    system.save(update_fields=['last_sent_at', 'last_error'])
    return note


def send_due():
    """Sends every waiting update that is due. Run by send_problem_updates."""
    due = ProblemNotification.objects.filter(
        status=ProblemNotification.STATUS_PENDING, next_try_at__lte=timezone.now(),
    ).select_related('report').order_by('next_try_at')[:SEND_PER_PASS]
    done = 0
    for note in due:
        send_one(note)
        done += 1
    return done


# ── Views ──────────────────────────────────────────────────────────────────


def _system_row(s, secret=None):
    out = {
        'id': s.id, 'name': s.name, 'notify_url': s.notify_url, 'notify_mode': s.notify_mode,
        'is_active': s.is_active, 'note': s.note,
        'last_sent_at': s.last_sent_at.isoformat() if s.last_sent_at else None,
        'last_error': s.last_error,
        'reports': ProblemReport.objects.filter(source=ProblemReport.SOURCE_EXTERNAL, external_system=s.name).count(),
        'waiting': ProblemNotification.objects.filter(system=s.name, status=ProblemNotification.STATUS_PENDING).count(),
        'failed': ProblemNotification.objects.filter(system=s.name, status=ProblemNotification.STATUS_FAILED).count(),
        'created_at': s.created_at.isoformat(),
    }
    if secret:
        out['secret'] = secret     # only right after creating or replacing it
    return out


def _clean(data, partial):
    """Validated fields from a request body, or an error message."""
    out = {}
    if 'name' in data or not partial:
        name = str(data.get('name') or '').strip()[:100]
        if not name:
            return None, 'Give the system\'s name: the same as its API key\'s name.'
        out['name'] = name
    if 'notify_url' in data:
        url = str(data.get('notify_url') or '').strip()
        if url and not url.lower().startswith(('http://', 'https://')):
            return None, 'The address must start with http:// or https://.'
        out['notify_url'] = url[:500]
    if 'notify_mode' in data:
        mode = data.get('notify_mode')
        if mode not in dict(LinkedSystem.MODES):
            return None, 'Choose Automatic, Manual or Off.'
        out['notify_mode'] = mode
    if 'is_active' in data:
        out['is_active'] = bool(data.get('is_active'))
    if 'note' in data:
        out['note'] = str(data.get('note') or '')[:200]
    return out, None


class LinkedSystemListView(APIView):
    permission_classes = [IsSuperadminOnly]

    def get(self, request):
        from .models import ApiKey
        names = sorted({k.name for k in ApiKey.objects.filter(is_active=True)
                        if 'problems:write' in (k.scopes or [])})
        return Response({'results': [_system_row(s) for s in LinkedSystem.objects.all()],
                         'key_names': names})

    def post(self, request):
        fields, error = _clean(request.data if isinstance(request.data, dict) else {}, partial=False)
        if error:
            return Response({'detail': error}, status=400)
        secret = new_secret()
        try:
            system = LinkedSystem.objects.create(notify_secret=secret, created_by=request.user, **fields)
        except IntegrityError:
            return Response({'detail': 'A linked system with this name already exists.'}, status=400)
        log_audit_event(request, 'linked_system_create', resource='linked_system', resource_id=str(system.id),
                        detail=f'{system.name}: updates {system.notify_mode}')
        return Response(_system_row(system, secret=secret), status=201)


class LinkedSystemDetailView(APIView):
    permission_classes = [IsSuperadminOnly]

    def patch(self, request, pk):
        system = get_object_or_404(LinkedSystem, pk=pk)
        fields, error = _clean(request.data if isinstance(request.data, dict) else {}, partial=True)
        if error:
            return Response({'detail': error}, status=400)
        for name, value in fields.items():
            setattr(system, name, value)
        try:
            system.save()
        except IntegrityError:
            return Response({'detail': 'A linked system with this name already exists.'}, status=400)
        log_audit_event(request, 'linked_system_update', resource='linked_system', resource_id=str(pk),
                        detail=f'{system.name}: ' + ', '.join(sorted(fields)))
        return Response(_system_row(system))

    def delete(self, request, pk):
        system = get_object_or_404(LinkedSystem, pk=pk)
        log_audit_event(request, 'linked_system_delete', resource='linked_system', resource_id=str(pk),
                        detail=system.name)
        system.delete()
        return Response(status=204)


class LinkedSystemSecretView(APIView):
    permission_classes = [IsSuperadminOnly]

    def post(self, request, pk):
        system = get_object_or_404(LinkedSystem, pk=pk)
        secret = new_secret()
        system.notify_secret = secret
        system.save(update_fields=['notify_secret', 'updated_at'])
        log_audit_event(request, 'linked_system_secret', resource='linked_system', resource_id=str(pk),
                        detail=f'{system.name}: new signing secret')
        return Response(_system_row(system, secret=secret))


class LinkedSystemTestView(APIView):
    """Sends a test update now, with the newest report from that system (or
    an empty one), and says what the address answered. Not logged as a
    delivery."""
    permission_classes = [IsSuperadminOnly]

    def post(self, request, pk):
        system = get_object_or_404(LinkedSystem, pk=pk)
        if not system.notify_url:
            return Response({'detail': 'Set the address first.'}, status=400)
        report = ProblemReport.objects.filter(source=ProblemReport.SOURCE_EXTERNAL,
                                              external_system=system.name).order_by('-updated_at').first()
        body = (_payload(report, 'test', system.name) if report else
                {'event': 'test', 'system': system.name, 'sent_at': timezone.now().isoformat(), 'report': None})
        code, error = _post(system, body)
        log_audit_event(request, 'linked_system_test', resource='linked_system', resource_id=str(pk),
                        detail=f'{system.name}: {error or f"answered {code}"}')
        return Response({'ok': not error, 'response_code': code, 'error': error})


def _note_row(n):
    return {
        'id': n.id, 'report_id': n.report_id, 'external_ref': n.report.external_ref, 'system': n.system,
        'event': n.event, 'status': n.status, 'attempts': n.attempts, 'response_code': n.response_code,
        'last_error': n.last_error,
        'next_try_at': n.next_try_at.isoformat() if n.next_try_at else None,
        'created_at': n.created_at.isoformat(),
        'sent_at': n.sent_at.isoformat() if n.sent_at else None,
        'requested_by': n.requested_by.username if n.requested_by_id else None,
    }


class ProblemNotificationListView(APIView):
    permission_classes = [IsSuperadminOnly]

    def get(self, request):
        qs = ProblemNotification.objects.select_related('report', 'requested_by')
        for field in ('system', 'status'):
            value = request.query_params.get(field)
            if value:
                qs = qs.filter(**{field: value})
        return Response({'results': [_note_row(n) for n in qs[:LOG_LIMIT]]})


class ProblemNotificationRetryView(APIView):
    permission_classes = [IsSuperadminOnly]

    def post(self, request, pk):
        note = get_object_or_404(ProblemNotification.objects.select_related('report'), pk=pk)
        if note.status == ProblemNotification.STATUS_SENT:
            return Response({'detail': 'Already sent.'}, status=400)
        note.status, note.attempts, note.next_try_at = ProblemNotification.STATUS_PENDING, 0, timezone.now()
        note.save(update_fields=['status', 'attempts', 'next_try_at'])
        return Response(_note_row(send_one(note)))


class ProblemReportNotifyView(APIView):
    """"Send update" on one report: queued and sent straight away; a failure
    is tried again in the background like any other update."""
    permission_classes = [IsAdminOrSuperadmin]

    def post(self, request, pk):
        report = get_object_or_404(ProblemReport, pk=pk)
        note = queue_update(report, 'manual', user=request.user, manual=True)
        if note is None:
            return Response({'detail': 'This report has no linked system with an address to send to.'}, status=400)
        note = send_one(note)
        log_audit_event(request, 'problem_report_notify', resource='problem_report', resource_id=str(pk),
                        detail=f'{note.system}: {note.status}')
        return Response(_note_row(note))


def report_notify_info(report):
    """For one report's detail: how updates go to its system, and the last few sent."""
    if report.source != ProblemReport.SOURCE_EXTERNAL:
        return None
    system = LinkedSystem.objects.filter(name=report.external_system).first()
    notes = list(report.notifications.select_related('report', 'requested_by')[:5])
    return {
        'system': report.external_system,
        'linked': system is not None,
        'mode': system.notify_mode if system else None,
        'has_address': bool(system and system.notify_url and system.is_active),
        'recent': [_note_row(n) for n in notes],
    }
