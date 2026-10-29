"""Per-cell network KPIs (2026-10-28).

NTC's KPI team is building an API for the counters their own dashboard shows
(PRB use, users, throughput, CQI, accessibility, drops, VoLTE). DT-WATCH is
ready for it in two ways, whichever they choose:

    pull   the daily job (fetch_cell_kpis) asks their API for yesterday:
           GET <api_url>?date=YYYY-MM-DD&level=day|bbh|hour&page=N&page_size=5000
           answered by a list, or {"results"|"data": [...], "next": ...}
    push   their system sends rows to POST /api/external/v1/cell-kpis/ with an
           API key holding the `kpis:write` scope (up to 5000 a request).

Until the API exists the source can be `demo`: it reads the daily network
exports ("Network 2 10-22.xlsx" = whole day, "... BBH.xlsx" = busy hour)
placed in MEDIA_ROOT/cell_kpi_demo/, so every page can be checked on real
figures.

Each row is matched to a 4G sector: by cell name (upper case, no spaces),
else site + sector label from the name (J3, K20 ...), else eNodeB ID + local
cell ID, else site + local cell ID. On the 22 October export that matched
12,157 of 12,248 cells; the rest are sectors the site list does not have.

A value that was not measured ("/0", "NIL", blank: no attempts) is stored as
null, never 0.

    GET  /api/v2/sites/<id>/cell-kpis/?days=7     a site's sectors (signed-in users)
    GET/PUT /api/v2/cell-kpis/source/             the connection (admin)
    POST /api/v2/cell-kpis/source/fetch/          fetch now, in the background (admin)
"""
import glob
import logging
import os
import re
import threading
from datetime import date as date_cls, datetime, timedelta

import requests
from django.conf import settings
from django.db import close_old_connections, transaction
from django.db.models import Avg, Count, Max
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .api_auth import ApiKeyAuthentication, ApiKeyRateThrottle, require_scope
from .audit import log_audit_event
from .collection import NEPAL_TZ
from .dt_serving_cell import site_of_enodeb
from .mfa import decrypt_secret, encrypt_secret
from .models import CellKpi, CellKpiSourceSettings, DriveTestSample, Sector, Site
from .views import IsAdminOrSuperadmin

logger = logging.getLogger(__name__)

PAGE_SIZE = 5000
MAX_PAGES = 200
MAX_PUSH_ROWS = 5000
HTTP_TIMEOUT_S = 90
RETRY_MINUTES = 30
BUSY_PRB = 80.0          # DL PRB at or above this is a busy cell (common planning line)
QUIET_PRB = 50.0         # below this the cell had room to spare
UNMATCHED_SHOWN = 100
DEMO_DIR = 'cell_kpi_demo'

# Our field names. Numeric unless listed in TEXT_FIELDS.
FIELDS = (
    'date', 'level', 'hour', 'busy_hour', 'cell_name', 'enodeb_id', 'local_cell_id', 'site_id', 'band',
    'bandwidth_mhz', 'prb_dl', 'prb_dl_peak', 'prb_ul', 'prb_dl_available', 'users_avg', 'users_max',
    'traffic_gb', 'thr_dl_cell', 'thr_ul_cell', 'thr_dl_user', 'thr_ul_user', 'cqi_avg', 'rrc_sr', 'erab_sr',
    'service_drop', 'volte_sr', 'volte_drop', 'availability', 'integrity',
)
TEXT_FIELDS = {'date', 'level', 'cell_name', 'site_id', 'band'}
INT_FIELDS = {'hour', 'busy_hour', 'enodeb_id', 'local_cell_id'}
NUMBER_FIELDS = [f for f in FIELDS if f not in TEXT_FIELDS and f not in INT_FIELDS]

# Column headings of NTC's daily network export (the MAE query behind the
# "Network 2" mails and the KTM856 sample), always understood.
EXPORT_COLUMNS = {
    'Cell Name': 'cell_name',
    'LocalCell Id': 'local_cell_id',
    'eNodeB Function Name': '_function_name',
    'Integrity': 'integrity',
    'RRC Setup Success Rate(%)': 'rrc_sr',
    'E-RAB Setup Success Rate(%)': 'erab_sr',
    'Service Drop Rate(%)': 'service_drop',
    'Cell Downlink Average Throughput(Mbps)': 'thr_dl_cell',
    'Cell Uplink Average Throughput(Mbps)': 'thr_ul_cell',
    'CELL Total Data Activity (Average DL &UL Volume)(GB)': 'traffic_gb',
    'Average DL Throughput per User(Mbps)': 'thr_dl_user',
    'Average UL Throughput per User(Mbps)': 'thr_ul_user',
    'Radio Network Availability Rate(%)': 'availability',
    'Resource Block Utilizing Rate (DL)(%)': 'prb_dl',
    'Resource Block Utilizing Rate (UL)(%)': 'prb_ul',
    'AverageCQI': 'cqi_avg',
    'Average number of users': 'users_avg',
    'Maximum number of users': 'users_max',
    'VOLTE setup success Rate(%)': 'volte_sr',
    'Call Drop Rate (VoIP)(%)': 'volte_drop',
}
_NOT_MEASURED = {'', '/0', 'NIL', 'NULL', 'N/A', 'NA', '-', '#DIV/0!'}
_LABEL = re.compile(r'-([A-Z]\d{1,2})$', re.I)
_SITE_ID = re.compile(r'^\s*((?:MWDR|FWDR|LEDR|KTM|EDR|CDR|WDR)\d+)', re.I)


# ---------------------------------------------------------------- cleaning

def _number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if text.upper() in _NOT_MEASURED:
        return None
    try:
        return float(text.rstrip('%'))
    except ValueError:
        return None


def _int(value):
    v = _number(value)
    return int(v) if v is not None else None


def cell_key(name):
    return re.sub(r'\s+', '', str(name or '')).upper()


def _date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date_cls):
        return value
    text = str(value or '').strip()
    for fmt in ('%Y-%m-%d', '%Y%m%d', '%d/%m/%Y', '%Y/%m/%d'):
        try:
            return datetime.strptime(text[:10] if fmt != '%Y%m%d' else text[:8], fmt).date()
        except ValueError:
            continue
    return None


def normalize(raw, field_map=None, default_level=None):
    """One incoming record as our fields, or (None, reason). `field_map` maps
    their name to ours; the export's column headings and our own names are
    always understood."""
    if not isinstance(raw, dict):
        return None, 'not an object'
    names = {**EXPORT_COLUMNS, **(field_map or {})}
    rec, extra = {}, {}
    for key, value in raw.items():
        ours = names.get(key, key if key in FIELDS else None)
        if ours is None:
            if key not in ('Date', 'Time'):
                extra[str(key)[:80]] = value if isinstance(value, (int, float, str)) or value is None else str(value)
            continue
        rec[ours] = value
    # The export's Date / Time columns: a Time ("2026-10-22 20:00") is a busy-hour row.
    if 'Time' in raw and 'date' not in rec:
        text = str(raw['Time'] or '')
        rec['date'] = text[:10]
        rec.setdefault('level', default_level or CellKpi.LEVEL_BBH)
        if len(text) >= 13 and text[11:13].isdigit():
            rec.setdefault('busy_hour', int(text[11:13]))
    elif 'Date' in raw and 'date' not in rec:
        rec['date'] = raw['Date']
        rec.setdefault('level', default_level or CellKpi.LEVEL_DAY)

    day = _date(rec.get('date'))
    if day is None:
        return None, 'no date'
    level = str(rec.get('level') or default_level or '').strip().lower()
    if level in ('busy_hour', 'busyhour', 'bh'):
        level = CellKpi.LEVEL_BBH
    if level not in dict(CellKpi.LEVELS):
        return None, 'unknown level'
    hour = _int(rec.get('hour'))
    if level == CellKpi.LEVEL_HOUR:
        if hour is None or not 0 <= hour <= 23:
            return None, 'hour row without an hour 0-23'
    else:
        hour = -1
    name = str(rec.get('cell_name') or '').strip()
    enodeb, lcid = _int(rec.get('enodeb_id')), _int(rec.get('local_cell_id'))
    if not name and enodeb is None:
        return None, 'no cell name or eNodeB ID'
    site_id = str(rec.get('site_id') or '').strip().upper()
    if not site_id:
        m = _SITE_ID.match(str(rec.get('_function_name') or name))
        site_id = m.group(1).upper() if m else (site_of_enodeb(enodeb) or '')
    out = {
        'date': day, 'level': level, 'hour': hour, 'busy_hour': _int(rec.get('busy_hour')),
        'cell_name': name[:160], 'cell_key': cell_key(name) or f'ENB{enodeb}-{lcid}',
        'enodeb_id': enodeb, 'local_cell_id': lcid, 'site_id': site_id,
        'band': str(rec.get('band') or '').strip()[:16],
    }
    for f in NUMBER_FIELDS:
        out[f] = _number(rec.get(f))
    out['extra'] = extra
    return out, None


# ---------------------------------------------------------------- matching

class Matcher:
    """Finds the 4G sector of a cell (see the module note for the order)."""

    def __init__(self):
        self.by_name, self.by_label, self.by_enb, self.by_site_lcid = {}, {}, {}, {}
        rows = (Sector.objects.filter(tech__iexact='4G')
                .values('id', 'site_id', 'cell_name', 'sector', 'local_cell_id', 'enodeb_id'))
        for s in rows:
            site = str(s['site_id']).upper()
            name = cell_key(s['cell_name'])
            if name:
                self.by_name.setdefault(name, s)
                m = _LABEL.search(name)
                if m:
                    self.by_label.setdefault((site, m.group(1).upper()), s)
            if s['sector']:
                self.by_label.setdefault((site, s['sector'].strip().upper()), s)
            if s['local_cell_id'] is not None:
                if s['enodeb_id'] is not None:
                    self.by_enb.setdefault((s['enodeb_id'], s['local_cell_id']), s)
                self.by_site_lcid.setdefault((site, s['local_cell_id']), s)
        self.sites = set(Site.objects.values_list('id', flat=True))

    def find(self, rec):
        site = rec['site_id']
        hit = self.by_name.get(rec['cell_key'])
        if hit is None and site:
            m = _LABEL.search(rec['cell_key'])
            if m:
                hit = self.by_label.get((site, m.group(1).upper()))
        if hit is None and rec['enodeb_id'] is not None and rec['local_cell_id'] is not None:
            hit = self.by_enb.get((rec['enodeb_id'], rec['local_cell_id']))
        if hit is None and site and rec['local_cell_id'] is not None:
            hit = self.by_site_lcid.get((site, rec['local_cell_id']))
        if hit is not None:
            return hit['id'], hit['site_id']
        return None, (site if site in self.sites else None)


# ---------------------------------------------------------------- storing

_UPDATE_FIELDS = ['busy_hour', 'cell_name', 'enodeb_id', 'local_cell_id', 'site', 'sector', 'band', 'extra',
                  'source', 'received_at'] + NUMBER_FIELDS


def store(records, source, field_map=None, default_level=None, matcher=None):
    """Normalizes, matches and upserts `records`. Returns counts and the
    names of cells no sector was found for."""
    matcher = matcher or Matcher()
    now = timezone.now()
    rows, rejected, unmatched, seen = [], {}, [], set()
    for raw in records:
        rec, why = normalize(raw, field_map, default_level)
        if rec is None:
            rejected[why] = rejected.get(why, 0) + 1
            continue
        key = (rec['cell_key'], rec['date'], rec['level'], rec['hour'])
        if key in seen:                       # the last copy of a period wins
            rows = [r for r in rows if (r.cell_key, r.date, r.level, r.hour) != key]
        seen.add(key)
        sector_id, site_id = matcher.find(rec)
        if sector_id is None:
            unmatched.append(rec['cell_name'] or rec['cell_key'])
        rows.append(CellKpi(
            date=rec['date'], level=rec['level'], hour=rec['hour'], busy_hour=rec['busy_hour'],
            cell_key=rec['cell_key'][:160], cell_name=rec['cell_name'], enodeb_id=rec['enodeb_id'],
            local_cell_id=rec['local_cell_id'], site_id=site_id, sector_id=sector_id, band=rec['band'],
            extra=rec['extra'], source=source, received_at=now,
            **{f: rec[f] for f in NUMBER_FIELDS},
        ))
    for start in range(0, len(rows), 2000):
        CellKpi.objects.bulk_create(rows[start:start + 2000], update_conflicts=True,
                                    unique_fields=['cell_key', 'date', 'level', 'hour'],
                                    update_fields=_UPDATE_FIELDS)
    _update_site_prb({r.site_id for r in rows if r.site_id})
    return {
        'rows': len(rows), 'matched': len(rows) - len(unmatched), 'unmatched': len(unmatched),
        'unmatched_cells': sorted(set(unmatched))[:UNMATCHED_SHOWN],
        'rejected': sum(rejected.values()), 'rejected_why': rejected,
        'dates': sorted({r.date.isoformat() for r in rows}), 'levels': sorted({r.level for r in rows}),
    }


def _update_site_prb(site_ids):
    """The site list's PRB figures (used by the monthly report and the site
    table) from the newest busy-hour rows, else whole-day rows: the busiest
    sector of each site."""
    if not site_ids:
        return
    for level in (CellKpi.LEVEL_BBH, CellKpi.LEVEL_DAY):
        newest = (CellKpi.objects.filter(site_id__in=site_ids, level=level)
                  .values('site_id').annotate(d=Max('date')))
        latest = {r['site_id']: r['d'] for r in newest}
        if not latest:
            continue
        figures = {}
        for r in (CellKpi.objects.filter(site_id__in=latest.keys(), level=level, date__in=set(latest.values()))
                  .values('site_id', 'date', 'prb_dl', 'prb_ul')):
            if r['date'] != latest[r['site_id']]:
                continue
            f = figures.setdefault(r['site_id'], [None, None])
            if r['prb_dl'] is not None:
                f[0] = max(f[0] or 0, r['prb_dl'])
            if r['prb_ul'] is not None:
                f[1] = max(f[1] or 0, r['prb_ul'])
        sites = list(Site.objects.filter(id__in=figures.keys()))
        for s in sites:
            dl, ul = figures[s.id]
            s.prb_dl, s.prb_ul, s.prb = dl, ul, dl
        Site.objects.bulk_update(sites, ['prb', 'prb_dl', 'prb_ul'], batch_size=1000)
        site_ids = set(site_ids) - set(figures)
        if not site_ids:
            return


def prune(keep_days):
    cutoff = timezone.now().astimezone(NEPAL_TZ).date() - timedelta(days=max(30, keep_days))
    return CellKpi.objects.filter(date__lt=cutoff).delete()[0]


# ---------------------------------------------------------------- sources

class SourceError(Exception):
    pass


def _row():
    return CellKpiSourceSettings.load() or CellKpiSourceSettings()


def _levels(row):
    wanted = [x.strip() for x in (row.levels or '').split(',') if x.strip()]
    return [x for x in wanted if x in dict(CellKpi.LEVELS)] or [CellKpi.LEVEL_DAY, CellKpi.LEVEL_BBH]


def _http_pages(row, day, level):
    token = ''
    if row.api_key_encrypted:
        try:
            token = decrypt_secret(row.api_key_encrypted)
        except Exception:
            raise SourceError('The saved key could not be read; enter it again.')
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = f'{row.auth_scheme or "Bearer"} {token}'
    url, params = row.api_url, {'date': day.isoformat(), 'level': level, 'page': 1, 'page_size': PAGE_SIZE}
    for _ in range(MAX_PAGES):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT_S, allow_redirects=False)
        except requests.RequestException as exc:
            raise SourceError(f'Could not reach the KPI service ({exc.__class__.__name__}).')
        if resp.status_code in (401, 403):
            raise SourceError('The KPI service refused the key.')
        if resp.status_code >= 400:
            raise SourceError(f'The KPI service answered {resp.status_code}.')
        try:
            body = resp.json()
        except ValueError:
            raise SourceError('The KPI service did not answer with JSON.')
        items = body if isinstance(body, list) else (body.get('results') or body.get('data') or [])
        if isinstance(items, dict):           # {"data": {"rows": [...]}}
            items = items.get('rows') or items.get('results') or []
        yield items
        nxt = body.get('next') if isinstance(body, dict) else None
        if nxt:
            url, params = nxt, None
        elif len(items) >= PAGE_SIZE:
            params['page'] += 1
        else:
            return
    raise SourceError(f'More than {MAX_PAGES} pages for one day; stopped.')


def _demo_files():
    folder = os.path.join(str(settings.MEDIA_ROOT), DEMO_DIR)
    return sorted(glob.glob(os.path.join(folder, '*.xlsx')))


def _demo_records(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=False, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = [str(h).strip() if h is not None else '' for h in next(rows, [])]
    for r in rows:
        if any(v not in (None, '') for v in r):
            yield dict(zip(head, r))


def fetch(day=None, row=None):
    """Fetch one day (default yesterday, Nepal time) from the configured
    source and store it. Returns the result saved on the settings row."""
    row = row or _row()
    day = day or (timezone.now().astimezone(NEPAL_TZ).date() - timedelta(days=1))
    started = timezone.now()
    result = {'date': day.isoformat(), 'backend': row.backend, 'ok': False}
    try:
        if row.backend == CellKpiSourceSettings.BACKEND_HTTP:
            if not row.api_url:
                raise SourceError('No address is set.')
            matcher, totals = Matcher(), None
            for level in _levels(row):
                for items in _http_pages(row, day, level):
                    got = store(items, 'pull', row.field_map, level, matcher)
                    totals = _add(totals, got)
            result.update(totals or {'rows': 0})
        elif row.backend == CellKpiSourceSettings.BACKEND_DEMO:
            files = _demo_files()
            if not files:
                raise SourceError('No demo files are in place.')
            matcher, totals = Matcher(), None
            for path in files:
                got = store(list(_demo_records(path)), 'demo', None, None, matcher)
                got['files'] = [os.path.basename(path)]
                totals = _add(totals, got)
            result.update(totals)
            result['note'] = 'Demo files hold their own dates; the date asked for is not used.'
        else:
            raise SourceError('The source is off.')
        result['ok'] = True
        result['pruned'] = prune(row.keep_days)
    except SourceError as exc:
        result['error'] = str(exc)
    except Exception as exc:  # noqa: BLE001 -- recorded for the page, never raised into the job loop
        logger.exception('cell KPI fetch failed')
        result['error'] = f'Fetch failed ({exc.__class__.__name__}).'
    result['seconds'] = round((timezone.now() - started).total_seconds(), 1)
    CellKpiSourceSettings.objects.filter(pk=1).update(
        last_run_at=timezone.now(), last_result=result, running_since=None,
        **({'last_success_date': day} if result['ok'] else {}))
    return result


def _add(total, got):
    if total is None:
        return dict(got)
    for k in ('rows', 'matched', 'unmatched', 'rejected'):
        total[k] = total.get(k, 0) + got.get(k, 0)
    total['unmatched_cells'] = sorted(set(total.get('unmatched_cells', [])) | set(got.get('unmatched_cells', [])))[:UNMATCHED_SHOWN]
    total['dates'] = sorted(set(total.get('dates', [])) | set(got.get('dates', [])))
    total['levels'] = sorted(set(total.get('levels', [])) | set(got.get('levels', [])))
    total['files'] = total.get('files', []) + got.get('files', [])
    for why, n in (got.get('rejected_why') or {}).items():
        total.setdefault('rejected_why', {})[why] = total.get('rejected_why', {}).get(why, 0) + n
    return total


def due(row, now=None):
    """The day the scheduled job should fetch now, or None."""
    if row is None or row.backend == CellKpiSourceSettings.BACKEND_OFF:
        return None
    local = (now or timezone.now()).astimezone(NEPAL_TZ)
    if local.hour < (row.fetch_hour or 0):
        return None
    yesterday = local.date() - timedelta(days=1)
    if row.last_success_date and row.last_success_date >= yesterday:
        return None
    if row.backend == CellKpiSourceSettings.BACKEND_DEMO and row.last_success_date:
        return None                           # demo files do not change by themselves
    if row.running_since and timezone.now() - row.running_since < timedelta(hours=2):
        return None
    if row.last_run_at and timezone.now() - row.last_run_at < timedelta(minutes=RETRY_MINUTES):
        return None
    return yesterday


# ---------------------------------------------------------------- reading

def load_at(when, sector_id=None, site_id=None):
    """The cell's load around `when`: the hour row for that hour, else the
    busy hour of that day, else the whole day, else the newest within the 3
    days before. With only a site, its busiest sector. None when nothing."""
    local = when.astimezone(NEPAL_TZ)
    qs = CellKpi.objects.filter(date__gte=local.date() - timedelta(days=3), date__lte=local.date())
    if sector_id:
        qs = qs.filter(sector_id=sector_id)
    elif site_id:
        qs = qs.filter(site_id=site_id)
    else:
        return None
    rows = list(qs.select_related('sector').order_by('-date'))
    if not rows:
        return None

    def pick(cands):
        return max(cands, key=lambda r: (r.prb_dl if r.prb_dl is not None else -1)) if cands else None

    same_day = [r for r in rows if r.date == local.date()]
    choice = (pick([r for r in same_day if r.level == CellKpi.LEVEL_HOUR and r.hour == local.hour])
              or pick([r for r in same_day if r.level == CellKpi.LEVEL_BBH])
              or pick([r for r in same_day if r.level == CellKpi.LEVEL_DAY]))
    earlier = False
    if choice is None:
        newest = rows[0].date
        older = [r for r in rows if r.date == newest]
        choice = pick([r for r in older if r.level == CellKpi.LEVEL_BBH]) or pick(
            [r for r in older if r.level == CellKpi.LEVEL_DAY]) or pick(older)
        earlier = True
    return {
        'date': choice.date.isoformat(), 'level': choice.level,
        'hour': choice.hour if choice.level == CellKpi.LEVEL_HOUR else choice.busy_hour,
        'earlier_day': earlier, 'basis': 'serving cell' if sector_id else 'busiest cell of the site',
        'cell_name': choice.cell_name, 'sector': choice.sector.sector if choice.sector_id else None,
        'site_id': choice.site_id, 'prb_dl': _r(choice.prb_dl), 'prb_ul': _r(choice.prb_ul),
        'users_avg': _r(choice.users_avg), 'thr_dl_user': _r(choice.thr_dl_user), 'cqi_avg': _r(choice.cqi_avg),
        'service_drop': _r(choice.service_drop, 2), 'volte_drop': _r(choice.volte_drop, 2),
        'availability': _r(choice.availability, 2), 'busy': choice.prb_dl is not None and choice.prb_dl >= BUSY_PRB,
        'quiet': choice.prb_dl is not None and choice.prb_dl < QUIET_PRB,
    }


def describe(load):
    """'DL PRB 87% (busy hour 20:00, 22 Oct)' for check evidence."""
    if not load:
        return ''
    when = {CellKpi.LEVEL_HOUR: f'hour {load["hour"]:02d}:00' if load['hour'] is not None else 'that hour',
            CellKpi.LEVEL_BBH: f'busy hour {load["hour"]:02d}:00' if load['hour'] is not None else 'busy hour',
            CellKpi.LEVEL_DAY: 'whole-day average'}[load['level']]
    day = datetime.fromisoformat(load['date']).strftime('%d %b')
    cell = load['cell_name'] or load['site_id']
    return f'{cell}: DL PRB {load["prb_dl"]}% ({when}, {day}{", the nearest day with figures" if load["earlier_day"] else ""})'


def site_busy_days(site_ids, days=7):
    """{site_id: {'prb_dl_max', 'sector', 'date', 'busy_days', 'days'}} from
    busy-hour rows of the last `days` days (problem hotspots)."""
    if not site_ids:
        return {}
    since = timezone.now().astimezone(NEPAL_TZ).date() - timedelta(days=days)
    per = {}
    for r in (CellKpi.objects.filter(site_id__in=site_ids, level=CellKpi.LEVEL_BBH, date__gt=since, prb_dl__isnull=False)
              .values('site_id', 'date', 'prb_dl', 'cell_name')):
        p = per.setdefault(r['site_id'], {'by_day': {}, 'latest': None})
        day = p['by_day'].setdefault(r['date'], (0, ''))
        if r['prb_dl'] > day[0]:
            p['by_day'][r['date']] = (r['prb_dl'], r['cell_name'])
    out = {}
    for site, p in per.items():
        newest = max(p['by_day'])
        prb, cell = p['by_day'][newest]
        out[site] = {'prb_dl_max': _r(prb), 'cell_name': cell, 'date': newest.isoformat(),
                     'busy_days': sum(1 for v, _ in p['by_day'].values() if v >= BUSY_PRB), 'days': len(p['by_day'])}
    return out


def _r(v, n=1):
    return round(v, n) if v is not None else None


def dashboard_link(row, cell_name, site_id, day):
    if not row or not row.dashboard_url:
        return None
    try:
        return row.dashboard_url.format(cell=requests.utils.quote(cell_name or ''), site=site_id or '', date=day or '')
    except (KeyError, IndexError, ValueError):
        return None


SERIES_FIELDS = ('prb_dl', 'prb_ul', 'thr_dl_user', 'users_avg', 'cqi_avg')
SHOWN_FIELDS = ('prb_dl', 'prb_dl_peak', 'prb_ul', 'users_avg', 'users_max', 'thr_dl_user', 'thr_dl_cell', 'traffic_gb',
                'cqi_avg', 'rrc_sr', 'erab_sr', 'service_drop', 'volte_drop', 'availability', 'integrity')


class SiteCellKpiView(APIView):
    """`GET /api/v2/sites/<site_id>/cell-kpis/?days=7` -- the site's 4G
    sectors with their newest busy-hour and whole-day figures, a per-day
    series, and the CQI drive tests measured on each sector for comparison."""
    permission_classes = [IsAuthenticated]

    def get(self, request, site_id):
        try:
            days = max(1, min(int(request.query_params.get('days', 7)), 31))
        except ValueError:
            days = 7
        row = CellKpiSourceSettings.load()
        newest = CellKpi.objects.filter(site_id=site_id).aggregate(d=Max('date'))['d']
        sectors = {s.id: s for s in Sector.objects.filter(site_id=site_id, tech__iexact='4G')}
        out = {'site_id': site_id, 'configured': bool(row and row.backend != CellKpiSourceSettings.BACKEND_OFF),
               'newest_date': newest.isoformat() if newest else None, 'busy_prb': BUSY_PRB, 'cells': []}
        if newest is None:
            return Response(out)
        since = newest - timedelta(days=days - 1)
        rows = list(CellKpi.objects.filter(site_id=site_id, date__gte=since, level__in=(CellKpi.LEVEL_DAY, CellKpi.LEVEL_BBH))
                    .order_by('date'))
        cells = {}
        for r in rows:
            c = cells.setdefault(r.cell_key, {'cell_name': r.cell_name, 'sector_id': r.sector_id, 'series': {}, 'day': None,
                                              'bbh': None, 'band': r.band})
            entry = c['series'].setdefault(r.date.isoformat(), {})
            entry[r.level] = {f: _r(getattr(r, f), 2) for f in SERIES_FIELDS}
            if r.date == newest:
                c[r.level] = {**{f: _r(getattr(r, f), 2) for f in SHOWN_FIELDS},
                              'busy_hour': r.busy_hour if r.level == CellKpi.LEVEL_BBH else None}
        # Drive tests' CQI on the same sectors (measured or worked out from SINR), last 365 days.
        lcids = {s.local_cell_id: s.id for s in sectors.values() if s.local_cell_id is not None}
        dt_cqi = {}
        if lcids:
            for a in (DriveTestSample.objects.filter(serving_site_id=site_id, serving_local_cell_id__in=lcids.keys(),
                                                     cqi__isnull=False,
                                                     session__saved_at__gte=timezone.now() - timedelta(days=365))
                      .values('serving_local_cell_id').annotate(n=Count('id'), avg=Avg('cqi'))):
                dt_cqi[lcids[a['serving_local_cell_id']]] = {'n': a['n'], 'avg': _r(a['avg'])}
        for key, c in sorted(cells.items(), key=lambda kv: _sector_order(sectors.get(kv[1]['sector_id']), kv[1]['cell_name'])):
            sec = sectors.get(c['sector_id'])
            out['cells'].append({
                **c, 'sector': sec.sector if sec else _label(c['cell_name']),
                'band': c['band'] or (sec.site_band if sec and sec.site_band else '') or _band_of_label(
                    (sec.sector if sec else '') or _label(c['cell_name'])),
                'azimuth': sec.azimuth if sec else None, 'matched': sec is not None,
                'series': [{'date': d, **v} for d, v in sorted(c['series'].items())],
                'drive_test_cqi': dt_cqi.get(c['sector_id']),
                'dashboard_url': dashboard_link(row, c['cell_name'], site_id, newest.isoformat()),
            })
        return Response(out)


def _label(name):
    m = _LABEL.search(cell_key(name))
    return m.group(1) if m else ''


def _band_of_label(label):
    """NTC's 4G sector labels carry the band: J3/K3/L3/M3/N3 = B3, J20... = B20."""
    m = re.match(r'[A-Z](\d{1,2})$', (label or '').strip().upper())
    return f'B{m.group(1)}' if m else ''


def _sector_order(sec, name):
    label = (sec.sector if sec else _label(name)) or ''
    m = re.match(r'([A-Z])(\d+)', label.upper())
    return (int(m.group(2)) if m else 999, m.group(1) if m else label)


# ---------------------------------------------------------------- connection

def _source_view(row):
    files = [os.path.basename(p) for p in _demo_files()]
    stored = CellKpi.objects.aggregate(n=Count('id'), newest=Max('date'))
    return {
        'backend': row.backend if row else CellKpiSourceSettings.BACKEND_OFF,
        'api_url': row.api_url if row else '', 'auth_scheme': row.auth_scheme if row else 'Bearer',
        'has_key': bool(row and row.api_key_encrypted), 'field_map': row.field_map if row else {},
        'levels': _levels(row) if row else [CellKpi.LEVEL_DAY, CellKpi.LEVEL_BBH],
        'fetch_hour': row.fetch_hour if row else 6, 'keep_days': row.keep_days if row else 400,
        'dashboard_url': row.dashboard_url if row else '',
        'last_run_at': row.last_run_at if row else None, 'last_result': row.last_result if row else {},
        'last_success_date': row.last_success_date if row else None,
        'running': bool(row and row.running_since and timezone.now() - row.running_since < timedelta(hours=2)),
        'demo_files': files, 'stored_rows': stored['n'], 'newest_date': stored['newest'],
        'fields': list(FIELDS),
        'updated_by': row.updated_by.username if row and row.updated_by else None,
        'updated_at': row.updated_at if row else None,
    }


class CellKpiSourceView(APIView):
    """`GET/PUT /api/v2/cell-kpis/source/` -- the KPI connection (admin and
    superadmin). PUT: backend off|demo|http, api_url, api_key (blank keeps the
    saved key; clear_key removes it), auth_scheme, field_map {their: ours},
    levels [day, bbh, hour], fetch_hour 0-23, keep_days 30-1100,
    dashboard_url with {cell} {site} {date}."""
    permission_classes = [IsAdminOrSuperadmin]

    def get(self, request):
        return Response(_source_view(CellKpiSourceSettings.load()))

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        row = _row()
        backend = str(data.get('backend', row.backend) or 'off')
        if backend not in dict(CellKpiSourceSettings.BACKENDS):
            return Response({'detail': 'Unknown source.'}, status=400)
        url = str(data.get('api_url', row.api_url) or '').strip()
        if url and not (url.startswith('http://') or url.startswith('https://')):
            return Response({'detail': 'The address must start with http:// or https://.'}, status=400)
        if backend == CellKpiSourceSettings.BACKEND_HTTP and not url:
            return Response({'detail': 'Enter the address of their API.'}, status=400)
        scheme = str(data.get('auth_scheme', row.auth_scheme) or 'Bearer')
        if scheme not in dict(CellKpiSourceSettings.AUTH_CHOICES):
            return Response({'detail': 'Unknown header type.'}, status=400)
        fmap = data.get('field_map', row.field_map) or {}
        if not isinstance(fmap, dict) or not all(isinstance(k, str) and v in FIELDS for k, v in fmap.items()):
            return Response({'detail': 'Field names: each of their names must point to one of ours.'}, status=400)
        levels = data.get('levels', _levels(row))
        if not isinstance(levels, list) or not levels or any(x not in dict(CellKpi.LEVELS) for x in levels):
            return Response({'detail': 'Pick at least one of whole day, busy hour, hour.'}, status=400)
        try:
            fetch_hour = max(0, min(int(data.get('fetch_hour', row.fetch_hour)), 23))
            keep_days = max(30, min(int(data.get('keep_days', row.keep_days)), 1100))
        except (TypeError, ValueError):
            return Response({'detail': 'Fetch hour and days to keep must be numbers.'}, status=400)
        dash = str(data.get('dashboard_url', row.dashboard_url) or '').strip()
        if dash and not (dash.startswith('http://') or dash.startswith('https://')):
            return Response({'detail': 'The dashboard address must start with http:// or https://.'}, status=400)
        changed_source = backend != row.backend or url != row.api_url
        row.backend, row.api_url, row.auth_scheme, row.field_map = backend, url[:500], scheme, fmap
        row.levels, row.fetch_hour, row.keep_days, row.dashboard_url = ','.join(levels), fetch_hour, keep_days, dash[:500]
        key = str(data.get('api_key') or '').strip()
        if data.get('clear_key'):
            row.api_key_encrypted = ''
        elif key:
            row.api_key_encrypted = encrypt_secret(key)
        if changed_source:
            row.last_success_date = None      # a new source fetches yesterday again
        row.updated_by = request.user
        row.save()
        log_audit_event(request, 'CELL_KPI_SOURCE.UPDATED', resource='cell_kpi_source', resource_id='1',
                        detail=f'backend={backend} url={url or "-"} key={"changed" if key else ("cleared" if data.get("clear_key") else "kept")} '
                               f'levels={row.levels} hour={fetch_hour}')
        return Response(_source_view(row))


class CellKpiFetchView(APIView):
    """`POST /api/v2/cell-kpis/source/fetch/` {date?} -- fetch now in the
    background (admin). The page reads the outcome from the source GET."""
    permission_classes = [IsAdminOrSuperadmin]

    def post(self, request):
        row = CellKpiSourceSettings.load()
        if not row or row.backend == CellKpiSourceSettings.BACKEND_OFF:
            return Response({'detail': 'Choose a source first.'}, status=400)
        day = None
        if request.data.get('date'):
            day = _date(request.data.get('date'))
            if day is None:
                return Response({'detail': 'The date must look like 2026-10-22.'}, status=400)
        with transaction.atomic():
            row = CellKpiSourceSettings.objects.select_for_update().get(pk=1)
            if row.running_since and timezone.now() - row.running_since < timedelta(hours=2):
                return Response({'detail': 'A fetch is already running.'}, status=409)
            row.running_since = timezone.now()
            row.save(update_fields=['running_since'])

        def run():
            close_old_connections()
            try:
                fetch(day)
            finally:
                close_old_connections()

        threading.Thread(target=run, daemon=True).start()
        log_audit_event(request, 'CELL_KPI_SOURCE.FETCH', resource='cell_kpi_source', resource_id='1',
                        detail=f'date={day.isoformat() if day else "yesterday"}')
        return Response({'started': True}, status=202)


class ExternalCellKpiView(APIView):
    """`POST /api/external/v1/cell-kpis/` (scope `kpis:write`) -- the KPI
    team's system sends rows itself: a list of up to 5000 records with our
    field names (see FIELDS) or the export's column headings. Answers how
    many were stored, matched and refused, and the cells not found."""
    authentication_classes = [ApiKeyAuthentication]
    throttle_classes = [ApiKeyRateThrottle]

    def get_permissions(self):
        return [require_scope('kpis:write')()]

    def post(self, request):
        items = request.data if isinstance(request.data, list) else (
            request.data.get('results') if isinstance(request.data, dict) else None)
        if not isinstance(items, list) or not items or len(items) > MAX_PUSH_ROWS:
            return Response({'detail': f'Send a list of 1 to {MAX_PUSH_ROWS} records.'}, status=400)
        result = store(items, 'push')
        log_audit_event(request, 'CELL_KPI.RECEIVED', resource='cell_kpi', resource_id=request.auth.name,
                        detail=f'rows={result["rows"]} matched={result["matched"]} rejected={result["rejected"]}')
        return Response(result)
