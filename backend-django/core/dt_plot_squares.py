"""Drive-test readings summed up per 50 m square (2026-10-14).

A district search in Explore can cover hundreds of thousands of readings
(Gulmi: 318,698). Instead of reading them all, Explore's wide searches read
DtPlotSquare: for each session and 50 m square, the count and the weakest,
strongest and average of each measurement. Each square is drawn as one dot
that shows the weakest value of the chosen measurement, so a bad spot is
never hidden. Zoomed in, Explore loads every reading for the area on screen.

The squares are built from the readings with one grouped query per batch of
sessions. A new session, or one whose readings were added to, carries
`plot_squares_stale` and is rebuilt the next time a search reaches it.
"""
from django.db import connection

from .models import DriveTestSession

STEP_M = 50
CELLS_PER_DEGREE = 111_000.0 / STEP_M

# Larger squares for a very wide search, merged from the 50 m ones.
MERGE_STEPS_M = (50, 100, 200, 400, 800)

_BUILD_SQL = f"""
    INSERT INTO v2_dt_plot_squares
        (session_id, sx, sy, lat, lng, location, n,
         rsrp_min, rsrp_max, rsrp_avg, rsrq_min, rsrq_avg, sinr_min, sinr_avg, dl_min, dl_avg,
         cqi_min, cqi_avg, rscp_min, rscp_avg, ecno_min, ecno_avg, rx_qual_max, rx_qual_avg, rep_id)
    SELECT session_id, sx, sy, avg(lat), avg(lng),
           ST_SetSRID(ST_MakePoint(avg(lng), avg(lat)), 4326)::geography, count(*),
           min(rsrp), max(rsrp), avg(rsrp), min(rsrq), avg(rsrq), min(sinr), avg(sinr), min(dl), avg(dl),
           min(cqi), avg(cqi), min(rscp), avg(rscp), min(ecno), avg(ecno), max(rx_qual), avg(rx_qual),
           (array_agg(id ORDER BY COALESCE(rscp, rsrp) ASC NULLS LAST, id))[1]
    FROM (SELECT *, floor(lat * {CELLS_PER_DEGREE})::int AS sx, floor(lng * {CELLS_PER_DEGREE})::int AS sy
          FROM v2_dt_samples
          WHERE session_id = ANY(%s) AND lat IS NOT NULL AND lng IS NOT NULL) s
    GROUP BY session_id, sx, sy
"""


def rebuild(session_ids):
    """Builds the squares of these sessions afresh and clears their stale mark."""
    session_ids = list(session_ids)
    if not session_ids:
        return
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM v2_dt_plot_squares WHERE session_id = ANY(%s)', [session_ids])
        cursor.execute(_BUILD_SQL, [session_ids])
    DriveTestSession.objects.filter(id__in=session_ids).update(plot_squares_stale=False)


def rebuild_stale():
    """Builds the squares of every session marked stale, a few at a time."""
    ids = list(DriveTestSession.objects.filter(plot_squares_stale=True).values_list('id', flat=True))
    for i in range(0, len(ids), 20):
        rebuild(ids[i:i + 20])


# What a square row looks like to Explore: the fields of a reading, with the
# weakest value of each measurement and the time, cell and site of the
# square's weakest reading, plus how many readings it stands for.
_REP_FIELDS = ('ts', 'date', 'pci', 'band', 'cell_id', 'cqi_estimated', 'serving_site_id',
               'serving_site_name', 'serving_dist_km', 'bcch', 'bsic', 'scrambling_code')


def squares_near(lat, lng, radius_km, outline_wkt, outline_margin_m, tech_list, max_rows):
    """{session id: [square rows]} within `radius_km` of the point (and near
    the outline when given), and the square size used: 50 m, or larger when
    50 m squares would pass `max_rows`. Returns (None, 0) when the squares
    hold `max_rows` readings or fewer: the caller then sends every reading."""
    rebuild_stale()
    where = ['ST_DWithin(q.location, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)']
    params = [lng, lat, radius_km * 1000.0]
    if outline_wkt:
        where.append('ST_Intersects(q.location::geometry, '
                     'ST_Buffer(ST_GeomFromText(%s, 4326)::geography, %s)::geometry)')
        # One square wider: a square's centre can sit outside the margin while
        # some of its readings are inside it.
        params += [outline_wkt, outline_margin_m + STEP_M]
    if tech_list:
        where.append('q.session_id = ANY(%s)')
        params.append(list(DriveTestSession.objects.filter(tech__in=tech_list).values_list('id', flat=True)))
    cols = ('session_id', 'sx', 'sy', 'lat', 'lng', 'n', 'rsrp_min', 'rsrp_max', 'rsrp_avg', 'rsrq_min', 'rsrq_avg',
            'sinr_min', 'sinr_avg', 'dl_min', 'dl_avg', 'cqi_min', 'cqi_avg', 'rscp_min', 'rscp_avg',
            'ecno_min', 'ecno_avg', 'rx_qual_max', 'rx_qual_avg', 'rep_id')
    sql = f"SELECT {', '.join('q.' + c for c in cols)} FROM v2_dt_plot_squares q WHERE {' AND '.join(where)}"
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        rows = [dict(zip(cols, r)) for r in cursor.fetchall()]
    if sum(r['n'] for r in rows) <= max_rows:
        return None, 0

    step_m = STEP_M
    for step_m in MERGE_STEPS_M:
        merged = _merge(rows, step_m // STEP_M) if step_m != STEP_M else rows
        if len(merged) <= max_rows:
            break
    rows = merged

    reps = {}
    rep_ids = [r['rep_id'] for r in rows]
    if rep_ids:
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT id, {', '.join(_REP_FIELDS)} FROM v2_dt_samples WHERE id = ANY(%s)", [rep_ids])
            reps = {r[0]: dict(zip(_REP_FIELDS, r[1:])) for r in cursor.fetchall()}

    by_session = {}
    for r in sorted(rows, key=lambda r: r['rep_id']):
        rep = reps.get(r['rep_id'], {})
        by_session.setdefault(r['session_id'], []).append({
            **{k: rep.get(k) for k in _REP_FIELDS},
            'date': rep.get('date') or '',
            'ts': rep.get('ts') or '',
            'lat': r['lat'], 'lng': r['lng'],
            # The weakest value of each measurement in the square.
            'rsrp': _round(r['rsrp_min'], 2), 'rsrq': _round(r['rsrq_min'], 2), 'sinr': _round(r['sinr_min'], 2),
            'dl': _round(r['dl_min'], 2), 'cqi': None if r['cqi_min'] is None else round(r['cqi_min']),
            'rscp': _round(r['rscp_min'], 2), 'ecno': _round(r['ecno_min'], 2),
            'rx_qual': None if r['rx_qual_max'] is None else round(r['rx_qual_max']),
            # What the square stands for.
            'square_n': r['n'], 'rsrp_max': _round(r['rsrp_max'], 2), 'rsrp_avg': _round(r['rsrp_avg']),
            'sinr_avg': _round(r['sinr_avg']), 'dl_avg': _round(r['dl_avg']),
        })
    return by_session, step_m


def _round(v, places=1):
    return None if v is None else round(v, places)


def _merge(rows, factor):
    """Squares `factor` times larger: counts and averages weighted by readings,
    the weakest of the weakest, the strongest of the strongest."""
    out = {}
    for r in rows:
        key = (r['session_id'], r['sx'] // factor, r['sy'] // factor)
        m = out.get(key)
        if m is None:
            out[key] = dict(r)
            continue
        n1, n2 = m['n'], r['n']
        for avg in ('rsrp_avg', 'rsrq_avg', 'sinr_avg', 'dl_avg', 'cqi_avg', 'rscp_avg', 'ecno_avg', 'rx_qual_avg'):
            a, b = m[avg], r[avg]
            m[avg] = b if a is None else a if b is None else (a * n1 + b * n2) / (n1 + n2)
        m['lat'] = (m['lat'] * n1 + r['lat'] * n2) / (n1 + n2)
        m['lng'] = (m['lng'] * n1 + r['lng'] * n2) / (n1 + n2)
        weaker = _level(r) is not None and (_level(m) is None or _level(r) < _level(m))
        if weaker:
            m['rep_id'] = r['rep_id']
        for low in ('rsrp_min', 'rsrq_min', 'sinr_min', 'dl_min', 'cqi_min', 'rscp_min', 'ecno_min'):
            m[low] = _pick(min, m[low], r[low])
        for high in ('rsrp_max', 'rx_qual_max'):
            m[high] = _pick(max, m[high], r[high])
        m['n'] = n1 + n2
    return list(out.values())


def _level(r):
    return r['rscp_min'] if r['rscp_min'] is not None else r['rsrp_min']


def _pick(f, a, b):
    return b if a is None else a if b is None else f(a, b)
