"""Drive-test retention (2026-10-14).

Decided with the user: NTA asks for a drive every year, complaint and
optimization drives come in between, and routes differ from drive to drive.
So the rule works per 50 m square (DtPlotSquare) and per technology, not per
session. A session "measured" a square when it has at least `min_readings`
readings there. In each square a session's readings are kept in full when:

  1. it is one of the `yearly_keep` most recent yearly drives that measured
     the square (at any age);
  2. it is one of the `per_square_keep` most recent sessions of any purpose
     that measured the square, and is at most `detail_months` old;
  3. it is pinned (Keep) or linked to an optimization activity;
  4. no session would otherwise keep readings in the square: the most recent
     one does (the last full readings of a place are never removed).

Elsewhere its readings are removed and the square's summary stays. A session
with no kept readings left, older than `summary_years` and not protected, is
erased with its squares.

Nothing runs on its own: a superadmin runs a dry run, reads the plan, and
approves it while the rule is switched on. The maintenance worker then
carries it out (`apply_dt_retention`). Every session changed gets a
DtPruneRecord, kept indefinitely, besides the audit log.

    GET/PUT /api/v2/dt-retention/settings/
    GET     /api/v2/dt-retention/runs/            runs and their records
    POST    /api/v2/dt-retention/runs/            dry run
    POST    /api/v2/dt-retention/runs/<id>/approve/
    POST    /api/v2/dt-retention/runs/<id>/discard/
"""
from collections import defaultdict
from datetime import date

from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from . import dt_plot_squares
from .audit import log_audit_event
from .models import DriveTestSession, DtPruneRecord, DtPruneRun, DtRetentionSettings
from .views import IsSuperadminOnly

SETTING_FIELDS = ('enabled', 'yearly_keep', 'per_square_keep', 'detail_months', 'summary_years', 'min_readings')
SETTING_LIMITS = {'yearly_keep': (1, 10), 'per_square_keep': (1, 10), 'detail_months': (3, 120),
                  'summary_years': (1, 30), 'min_readings': (1, 50)}
PLAN_LIST_MAX = 2000        # sessions shown in one plan


def get_settings():
    obj, _ = DtRetentionSettings.objects.get_or_create(pk=1)
    return obj


def _months_between(earlier, later):
    return (later.year - earlier.year) * 12 + (later.month - earlier.month) - (later.day < earlier.day)


def build_plan(cfg, today=None):
    """The plan: per session, the squares whose readings go and whether the
    session is erased. Reads only the squares and the sessions."""
    today = today or timezone.localdate()
    dt_plot_squares.rebuild_stale()

    sessions = {}
    linked = set(DriveTestSession.objects.filter(activity_links__isnull=False).values_list('id', flat=True))
    for s in DriveTestSession.objects.values('id', 'name', 'tech', 'date', 'saved_at', 'purpose', 'keep',
                                             'readings_pruned'):
        drive_date = s['date'] or s['saved_at'].date()
        sessions[s['id']] = {
            **s, 'drive_date': drive_date,
            'age_months': _months_between(drive_date, today),
            'protected': s['keep'] or s['id'] in linked,
        }

    squares = defaultdict(list)     # (tech, sx, sy) -> [(session id, n)]
    with connection.cursor() as cursor:
        # Squares whose readings are already gone take no part: they hold
        # no full readings to keep or to remove.
        cursor.execute('SELECT session_id, sx, sy, n FROM v2_dt_plot_squares WHERE NOT detail_removed')
        for session_id, sx, sy, n in cursor.fetchall():
            s = sessions.get(session_id)
            if s is not None:
                squares[(s['tech'] or '4G', sx, sy)].append((session_id, n))

    def newest_first(entry):
        s = sessions[entry[0]]
        return (s['drive_date'], s['saved_at'])

    remove = defaultdict(list)      # session id -> [(sx, sy, n)]
    keeps_some = set()
    for (tech, sx, sy), entries in squares.items():
        entries.sort(key=newest_first, reverse=True)
        measured = [e for e in entries if e[1] >= cfg.min_readings]
        yearly = [e for e in measured if sessions[e[0]]['purpose'] == 'yearly'][:cfg.yearly_keep]
        recent = [e for e in measured[:cfg.per_square_keep]
                  if sessions[e[0]]['age_months'] < cfg.detail_months]
        kept = {e[0] for e in yearly} | {e[0] for e in recent}
        kept |= {e[0] for e in entries if sessions[e[0]]['protected']}
        # Below the reading threshold a session does not count in the
        # square, but its few readings stay while it is still recent.
        kept |= {e[0] for e in entries if e[1] < cfg.min_readings and e[0] not in kept
                 and sessions[e[0]]['age_months'] < cfg.detail_months and not measured[:cfg.per_square_keep]}
        if not kept:
            # The last full readings of this place are never removed.
            kept.add((measured or entries)[0][0])
        for session_id, n in entries:
            if session_id in kept:
                keeps_some.add(session_id)
            else:
                remove[session_id].append((sx, sy, n))

    plan = []
    for session_id, s in sessions.items():
        gone = remove.get(session_id, [])
        erase = (not s['protected'] and session_id not in keeps_some
                 and s['age_months'] >= cfg.summary_years * 12)
        if not gone and not erase:
            continue
        plan.append({
            'session_id': session_id, 'name': s['name'], 'tech': s['tech'], 'purpose': s['purpose'],
            'drive_date': s['drive_date'].isoformat(), 'action': 'erased' if erase else 'reduced',
            'readings_removed': sum(n for _, _, n in gone), 'squares': [[sx, sy] for sx, sy, _ in gone],
        })
    plan.sort(key=lambda p: (p['action'] != 'erased', p['drive_date']))
    return plan


def _summary(plan):
    return {
        'readings_to_remove': sum(p['readings_removed'] for p in plan if p['action'] == 'reduced'),
        'sessions_reduced': sum(1 for p in plan if p['action'] == 'reduced'),
        'sessions_erased': sum(1 for p in plan if p['action'] == 'erased'),
    }


def _same_plan(a, b):
    key = lambda p: (p['session_id'], p['action'], p['readings_removed'])
    return sorted(map(key, a)) == sorted(map(key, b))


def apply_run(run):
    """Carries out an approved run, if the data still gives the same plan."""
    cfg = get_settings()
    if not cfg.enabled:
        run.status, run.error = 'failed', 'Retention was switched off before the run started.'
        run.save(update_fields=['status', 'error'])
        return
    run.status = 'running'
    run.save(update_fields=['status'])
    try:
        fresh = build_plan(_cfg_from(run.settings_snapshot))
        if not _same_plan(fresh, run.plan):
            raise RuntimeError('The drive-test data changed after the dry run. Run a new dry run.')
        approver = run.approved_by.username if run.approved_by_id else ''
        cells = dt_plot_squares.CELLS_PER_DEGREE
        for p in run.plan:
            with transaction.atomic():
                session = DriveTestSession.objects.filter(pk=p['session_id']).first()
                if session is None:
                    continue
                if p['action'] == 'erased':
                    session.delete()
                    removed = p['readings_removed']
                else:
                    xs = [sq[0] for sq in p['squares']]
                    ys = [sq[1] for sq in p['squares']]
                    with connection.cursor() as cursor:
                        cursor.execute(f"""
                            DELETE FROM v2_dt_samples s
                            USING (SELECT unnest(%s::int[]) AS sx, unnest(%s::int[]) AS sy) q
                            WHERE s.session_id = %s
                              AND floor(s.lat * {cells})::int = q.sx AND floor(s.lng * {cells})::int = q.sy
                        """, [xs, ys, session.pk])
                        removed = cursor.rowcount
                        cursor.execute("""
                            UPDATE v2_dt_plot_squares q SET detail_removed = true
                            FROM (SELECT unnest(%s::int[]) AS sx, unnest(%s::int[]) AS sy) d
                            WHERE q.session_id = %s AND q.sx = d.sx AND q.sy = d.sy
                        """, [xs, ys, session.pk])
                    session.readings_pruned += removed
                    session.save(update_fields=['readings_pruned'])
                DtPruneRecord.objects.create(
                    run=run, session_id_value=p['session_id'], session_name=p['name'][:255], tech=p['tech'] or '',
                    drive_date=date.fromisoformat(p['drive_date']), purpose=p['purpose'], action=p['action'],
                    readings_removed=removed, squares_reduced=len(p['squares']), approved_by_name=approver,
                )
        run.status, run.finished_at = 'done', timezone.now()
        run.save(update_fields=['status', 'finished_at'])
    except Exception as exc:     # the run stays visible with its reason
        run.status, run.error = 'failed', str(exc)[:2000]
        run.save(update_fields=['status', 'error'])


def apply_approved_runs():
    """Called by the maintenance worker: carries out approved runs, oldest first."""
    for run in DtPruneRun.objects.filter(status='approved').order_by('approved_at'):
        apply_run(run)


def _cfg_from(snapshot):
    cfg = DtRetentionSettings(**{k: v for k, v in snapshot.items() if k in SETTING_FIELDS})
    cfg.enabled = True
    return cfg


def _settings_out(cfg):
    out = {f: getattr(cfg, f) for f in SETTING_FIELDS}
    out['updated_by'] = cfg.updated_by.username if cfg.updated_by_id else None
    out['updated_at'] = cfg.updated_at.isoformat() if cfg.updated_at else None
    return out


def _run_out(run, with_plan=False):
    out = {
        'id': run.id, 'status': run.status, 'settings': run.settings_snapshot,
        'readings_to_remove': run.readings_to_remove, 'sessions_reduced': run.sessions_reduced,
        'sessions_erased': run.sessions_erased, 'created_at': run.created_at.isoformat(),
        'created_by': run.created_by.username if run.created_by_id else None,
        'approved_by': run.approved_by.username if run.approved_by_id else None,
        'approved_at': run.approved_at.isoformat() if run.approved_at else None,
        'finished_at': run.finished_at.isoformat() if run.finished_at else None,
        'error': run.error,
    }
    if with_plan:
        out['plan'] = [{k: v for k, v in p.items() if k != 'squares'} | {'squares': len(p['squares'])}
                       for p in run.plan[:PLAN_LIST_MAX]]
        out['plan_total'] = len(run.plan)
        out['records'] = [
            {'session_id': r.session_id_value, 'name': r.session_name, 'tech': r.tech, 'purpose': r.purpose,
             'drive_date': r.drive_date.isoformat() if r.drive_date else None, 'action': r.action,
             'readings_removed': r.readings_removed, 'created_at': r.created_at.isoformat()}
            for r in run.records.all()[:PLAN_LIST_MAX]
        ]
    return out


class RetentionSettingsView(APIView):
    permission_classes = [IsSuperadminOnly]

    def get(self, request):
        return Response(_settings_out(get_settings()))

    def put(self, request):
        cfg = get_settings()
        data = request.data if isinstance(request.data, dict) else {}
        for field in SETTING_FIELDS:
            if field not in data:
                continue
            if field == 'enabled':
                cfg.enabled = bool(data[field])
                continue
            try:
                value = int(data[field])
            except (TypeError, ValueError):
                return Response({'detail': f'{field} must be a whole number.'}, status=400)
            lo, hi = SETTING_LIMITS[field]
            if not lo <= value <= hi:
                return Response({'detail': f'{field} must be between {lo} and {hi}.'}, status=400)
            setattr(cfg, field, value)
        cfg.updated_by = request.user
        cfg.save()
        log_audit_event(request, 'dt_retention_settings', resource='dt_retention', resource_id='1',
                        detail=', '.join(f'{f}={getattr(cfg, f)}' for f in SETTING_FIELDS))
        return Response(_settings_out(cfg))


class RetentionRunListView(APIView):
    permission_classes = [IsSuperadminOnly]

    def get(self, request):
        runs = DtPruneRun.objects.select_related('created_by', 'approved_by')[:50]
        return Response({'results': [_run_out(r) for r in runs]})

    def post(self, request):
        """A dry run with the current settings: nothing is removed."""
        cfg = get_settings()
        plan = build_plan(cfg)
        run = DtPruneRun.objects.create(
            settings_snapshot={f: getattr(cfg, f) for f in SETTING_FIELDS}, plan=plan,
            created_by=request.user, **_summary(plan),
        )
        log_audit_event(request, 'dt_retention_dry_run', resource='dt_retention', resource_id=str(run.id),
                        detail=f'{run.sessions_reduced} to reduce, {run.sessions_erased} to erase, '
                               f'{run.readings_to_remove} readings')
        return Response(_run_out(run, with_plan=True), status=201)


class RetentionRunDetailView(APIView):
    permission_classes = [IsSuperadminOnly]

    def get(self, request, pk):
        run = get_object_or_404(DtPruneRun.objects.select_related('created_by', 'approved_by'), pk=pk)
        return Response(_run_out(run, with_plan=True))


class RetentionRunApproveView(APIView):
    permission_classes = [IsSuperadminOnly]

    def post(self, request, pk):
        run = get_object_or_404(DtPruneRun, pk=pk)
        if run.status != 'planned':
            return Response({'detail': 'Only a planned dry run can be approved.'}, status=400)
        if not get_settings().enabled:
            return Response({'detail': 'Retention is switched off. Switch it on in the settings first.'}, status=400)
        if DtPruneRun.objects.filter(pk__gt=run.pk, status__in=('planned', 'done')).exists():
            return Response({'detail': 'A newer dry run exists. Approve the newest one.'}, status=400)
        run.status, run.approved_by, run.approved_at = 'approved', request.user, timezone.now()
        run.save(update_fields=['status', 'approved_by', 'approved_at'])
        log_audit_event(request, 'dt_retention_approve', resource='dt_retention', resource_id=str(run.id),
                        detail=f'{run.sessions_reduced} to reduce, {run.sessions_erased} to erase, '
                               f'{run.readings_to_remove} readings')
        return Response(_run_out(run))


class RetentionRunDiscardView(APIView):
    permission_classes = [IsSuperadminOnly]

    def post(self, request, pk):
        run = get_object_or_404(DtPruneRun, pk=pk)
        if run.status not in ('planned', 'approved'):
            return Response({'detail': 'This run can no longer be discarded.'}, status=400)
        run.status = 'discarded'
        run.save(update_fields=['status'])
        log_audit_event(request, 'dt_retention_discard', resource='dt_retention', resource_id=str(run.id))
        return Response(_run_out(run))
