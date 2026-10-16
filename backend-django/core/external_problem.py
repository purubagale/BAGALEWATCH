"""Problem reports from other NTC systems (2026-10-15).

A system that takes customer complaints (complaint desk, CRM, call centre)
sends them here with an API key that has the `problems:write` scope, and
reads back what DT-WATCH found with `problems:read`. The key's name is the
system's name: every report it sends is filed under that name, and it reads
back only those. A replacement key given the same name carries on.

    POST /api/external/v1/problem-reports/      one report, or a list of up to 200
    GET  /api/external/v1/problem-reports/      this system's reports: status and likely cause
         ?since=<ISO time>  only those changed since then
         ?ref=<ticket>      one ticket

A report needs the system's own ticket number (`external_ref`), what the
problem is (`category`: no_signal, slow_data, call_drop, stuck_2g3g, other)
and where: `lat` and `lng`, or `site_id`, or the 4G `cell_id` (eNodeB ID x
256 + local cell ID). With only a site or cell the spot is taken as the
mast, and the check around it is less precise; the report says so.
Optional: `happened_at` (ISO time, within the last 30 days; default now),
`note` (up to 500 characters), `network_type` (LTE, NR, UMTS, GSM) and
`msisdn`, the customer's number in any spelling (stored as 977...), which
puts the report on that number's Subscriber Profile.

Sending the same ticket number again updates the report while it is still
new. Once an engineer has checked or closed it, a re-send changes nothing
and the answer says so.

The customer's number is accepted because every linked system is NTC's own
(the user's decision, 2026-10-15). It is shown to a superadmin only, like
the number of a phone that reported from the app. The read back carries no
engineer's note and does not repeat the number.

Status updates can also be sent to the system as they happen
(core/problem_notify.py).
"""
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from .api_auth import ApiKeyAuthentication, ApiKeyRateThrottle, require_scope
from .audit import log_audit_event
from .dt_serving_cell import sectors_by_cell_identity
from .models import ProblemReport, Site
from .problem_report import _TECH, CAUSE_LABELS, CUSTOMER_REPLY, MAX_NOTE_CHARS, _num
from .rescue import _clean_msisdn

MAX_PER_REQUEST = 200
MAX_PER_DAY = 5000                  # new reports from one system per day
MAX_AGE_DAYS = 30
MAX_LIST = 500



def _clean_note(value):
    return str(value or '')[:MAX_NOTE_CHARS]


def _place(item):
    """(lat, lng, located_by) from the item, or an error message."""
    lat, lng = _num(item.get('lat'), -90, 90), _num(item.get('lng'), -180, 180)
    if lat is not None and lng is not None:
        return lat, lng, 'point', None
    site_id = str(item.get('site_id') or '').strip()
    if site_id:
        site = Site.objects.filter(pk=site_id).values('lat', 'lng').first()
        if not site or site['lat'] is None:
            return None, None, '', f'Unknown site {site_id}, or it has no position.'
        return site['lat'], site['lng'], 'site', None
    cell_id = _num(item.get('cell_id'), 0, 2 ** 36)
    if cell_id is not None:
        sector = sectors_by_cell_identity({int(cell_id)}).get(int(cell_id))
        if sector is None:
            return None, None, '', f'Unknown cell {int(cell_id)}.'
        if sector.lat is not None and sector.lng is not None:
            return sector.lat, sector.lng, 'cell', None
        if sector.site.lat is not None:
            return sector.site.lat, sector.site.lng, 'cell', None
        return None, None, '', f'Cell {int(cell_id)} has no position.'
    return None, None, '', 'Give lat and lng, a site_id, or a 4G cell_id.'


def _status_row(report):
    return {
        'external_ref': report.external_ref,
        'id': report.pk,
        'status': report.status,
        'category': report.category,
        'likely_cause': report.cause or None,
        'likely_cause_label': CAUSE_LABELS.get(report.cause) if report.cause else None,
        'customer_reply': CUSTOMER_REPLY.get(report.cause) if report.cause else None,
        'site_id': report.site_id,
        'located_by': report.located_by,
        'checked_at': report.checked_at.isoformat() if report.checked_at else None,
        'updated_at': report.updated_at.isoformat(),
    }


class ExternalProblemReportView(APIView):
    authentication_classes = [ApiKeyAuthentication]
    throttle_classes = [ApiKeyRateThrottle]

    def get_permissions(self):
        scope = 'problems:write' if self.request.method == 'POST' else 'problems:read'
        return [require_scope(scope)()]

    def get(self, request):
        system = request.auth.name
        qs = ProblemReport.objects.filter(source=ProblemReport.SOURCE_EXTERNAL, external_system=system)
        ref = request.query_params.get('ref')
        if ref:
            qs = qs.filter(external_ref=ref)
        since = request.query_params.get('since')
        if since:
            when = parse_datetime(since)
            if when is None:
                return Response({'detail': 'since must be an ISO date and time.'}, status=400)
            if timezone.is_naive(when):
                when = timezone.make_aware(when)
            qs = qs.filter(updated_at__gt=when)
        rows = list(qs.order_by('updated_at')[:MAX_LIST])
        return Response({'system': system, 'results': [_status_row(r) for r in rows],
                         'more': len(rows) == MAX_LIST})

    def post(self, request):
        key = request.auth
        system = key.name
        items = request.data if isinstance(request.data, list) else [request.data]
        if not items or len(items) > MAX_PER_REQUEST or not all(isinstance(i, dict) for i in items):
            return Response({'detail': f'Send one report, or a list of 1 to {MAX_PER_REQUEST}.'}, status=400)

        now = timezone.now()
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        made_today = ProblemReport.objects.filter(source=ProblemReport.SOURCE_EXTERNAL, external_system=system,
                                                  created_at__gte=day_start).count()
        categories = dict(ProblemReport.CATEGORIES)
        results, counts = [], {'created': 0, 'updated': 0, 'unchanged': 0, 'rejected': 0}
        for item in items:
            ref = str(item.get('external_ref') or '').strip()[:80]
            error = None
            if not ref:
                error = 'external_ref (your ticket number) is required.'
            category = str(item.get('category') or '')
            if not error and category not in categories:
                error = f'category must be one of: {", ".join(categories)}.'
            happened_at = now
            if not error and item.get('happened_at'):
                happened_at = parse_datetime(str(item['happened_at']))
                if happened_at is None:
                    error = 'happened_at must be an ISO date and time.'
                else:
                    if timezone.is_naive(happened_at):
                        happened_at = timezone.make_aware(happened_at)
                    if not now - timedelta(days=MAX_AGE_DAYS) <= happened_at <= now + timedelta(minutes=10):
                        error = f'happened_at must be within the last {MAX_AGE_DAYS} days.'
            lat = lng = None
            located_by = ''
            if not error:
                lat, lng, located_by, error = _place(item)
            msisdn = ''
            if not error and item.get('msisdn'):
                msisdn = _clean_msisdn(str(item['msisdn'])) or ''
                if not msisdn:
                    error = 'msisdn is not a valid mobile number.'
            if error:
                counts['rejected'] += 1
                results.append({'external_ref': ref or None, 'result': 'rejected', 'error': error})
                continue

            network = str(item.get('network_type') or '').upper()
            fields = dict(
                category=category, note=_clean_note(item.get('note')), happened_at=happened_at,
                lat=lat, lng=lng, located_by=located_by,
                network_type=network if network in _TECH else '', msisdn=msisdn,
            )
            existing = ProblemReport.objects.filter(
                source=ProblemReport.SOURCE_EXTERNAL, external_system=system, external_ref=ref).first()
            if existing is not None and existing.status != ProblemReport.STATUS_NEW:
                counts['unchanged'] += 1
                results.append({'external_ref': ref, 'id': existing.pk, 'result': 'unchanged',
                                'status': existing.status,
                                'note': 'Already checked by an engineer; the re-send was not applied.'})
                continue
            if existing is not None:
                # A re-send changes only what it carries: a missing note,
                # time or network type keeps the one sent before.
                for name, value in fields.items():
                    if name == 'note' and 'note' not in item:
                        continue
                    if name == 'happened_at' and not item.get('happened_at'):
                        continue
                    if name == 'network_type' and 'network_type' not in item:
                        continue
                    if name == 'msisdn' and not item.get('msisdn'):
                        continue
                    setattr(existing, name, value)
                existing.api_key = key
                existing.classified_at = None   # work out the cause again
                existing.save()
                counts['updated'] += 1
                results.append({'external_ref': ref, 'id': existing.pk, 'result': 'updated', 'status': existing.status})
                continue
            if made_today >= MAX_PER_DAY:
                counts['rejected'] += 1
                results.append({'external_ref': ref, 'result': 'rejected',
                                'error': f'Daily limit of {MAX_PER_DAY} new reports reached. Try again tomorrow.'})
                continue
            try:
                with transaction.atomic():
                    report = ProblemReport.objects.create(
                        source=ProblemReport.SOURCE_EXTERNAL, external_system=system, external_ref=ref,
                        api_key=key, **fields)
            except IntegrityError:
                # The same ticket in the same request, or sent twice at once.
                counts['unchanged'] += 1
                results.append({'external_ref': ref, 'result': 'unchanged', 'note': 'Sent twice; kept once.'})
                continue
            made_today += 1
            counts['created'] += 1
            results.append({'external_ref': ref, 'id': report.pk, 'result': 'created', 'status': report.status})

        log_audit_event(request, 'problem_report_external', resource='problem_report', resource_id=system[:40],
                        detail=f'{system}: ' + ', '.join(f'{n} {k}' for k, n in counts.items() if n))
        return Response({'system': system, **counts, 'results': results})
