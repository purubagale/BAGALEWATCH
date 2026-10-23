# Gunicorn tuning for real concurrent load (2026-08-08, "enable this
# application for more than 100 concurrent user access").
#
# Previously the Dockerfile's CMD hardcoded `--workers 3` with no
# `--threads` — three sync worker PROCESSES means at most 3 requests are
# ever being handled at once, full stop; request #4 queues behind
# whichever of the first 3 finishes first. That's fine for a handful of
# admins clicking around, not for ~100 people hitting this at once.
#
# A Python config file (rather than more Dockerfile CMD flags) so the
# worker count can be COMPUTED from the actual server's CPU count at
# container start, instead of a number picked without knowing what
# hardware this ends up running on (this app moves between machines —
# see docs/SERVER_MIGRATION.md — so a number tuned for one box would be
# wrong on the next).
#
# Worker MATH, not just CPU count, because Django/gunicorn workers each
# hold their own Postgres connection(s) (see settings.py's
# CONN_MAX_AGE=60 — a connection now stays open across a burst of
# requests instead of closing after each one, which is faster per-request
# but means worker count directly drives how many Postgres connections
# are held open at once). Postgres' own `max_connections` was raised to
# 200 in docker-compose.yml's `db` service to leave real headroom above
# whatever this resolves to, plus the Go worker's own pool and the
# occasional `psql`/pgAdmin session. Capped at 12 rather than the
# textbook "(2 x cores) + 1" formula uncapped — a genuinely "powerful"
# server with e.g. 32 cores would otherwise compute 65 workers, which
# would alone blow past a 200-connection Postgres budget before anything
# else gets a connection; 100 real concurrent users doing normal bursty
# browsing/form-submitting traffic (not 100 permanently-open long-polling
# connections) does not need that many workers to feel fast.
#
# `threads` (gthread worker class, not plain sync) matters as much as the
# worker count here: most of a Django view's time in this app is spent
# WAITING on Postgres (see core/views.py's queries), and Python releases
# the GIL during that wait — a thread can pick up a second request during
# that dead time instead of that whole worker sitting idle. 4 threads x
# up to 12 workers means up to 48 requests genuinely in flight at once,
# comfortably enough for 100 people whose actual requests are short and
# bursty, not 100 simultaneous multi-second queries.
import multiprocessing
import os

bind = '0.0.0.0:8000'
worker_class = 'gthread'


# Worker count (2026-10-11) -- 2 x cores + 1, at most MAX_COMPUTED_WORKERS.
# The cap was 12, which assumed this app has the machine to itself. The
# prod host has 8 cores but is shared with about 50 other containers, so
# it took all 12 (about 1 GB). Workers are sized to the CPU share the app
# may use, not to the number of users: 4 workers x 2 threads is 8
# requests in flight at once (16 before the 2026-10-23 audit), and most of
# a request is spent waiting on Postgres, which threads handle. GUNICORN_WORKERS / GUNICORN_THREADS in
# .env override this on a host that can give more. Unset, empty or not a
# positive number: the computed value.
MAX_COMPUTED_WORKERS = 4


def _positive_int(name, default):
    try:
        value = int(os.environ.get(name, ''))
    except ValueError:
        return default
    return value if value > 0 else default


workers = _positive_int('GUNICORN_WORKERS', min((multiprocessing.cpu_count() * 2) + 1, MAX_COMPUTED_WORKERS))
# Two threads per worker (audit 2026-10-23; was 4). The Django container has
# 1 GB and the idle app already holds about 555 MB; one large drive-test
# session or the site list adds 40-60 MB while it is built, so 16 such
# requests at once could get a worker killed. 4 x 2 = 8 in flight is ample
# for staff use; raise GUNICORN_THREADS together with DJANGO_MEM_LIMIT.
threads = _positive_int('GUNICORN_THREADS', 2)

# Same 120s kept from the original Dockerfile CMD — a real large
# Site/Sector Excel import can legitimately take a while even with the
# bulk-write rewrite (see site_import.py's module docstring); this isn't
# about per-request speed, it's a safety net against a slow request
# getting killed mid-write.
timeout = 120

# Database query limit for web requests (audit 2026-10-23), a little under
# `timeout`. When gunicorn kills a worker at 120 s, Postgres would otherwise
# keep running that worker's query with nobody waiting for it. Read by
# settings.py only in this process: migrations and the maintenance jobs
# (backfills, retention) keep no limit. DB_STATEMENT_TIMEOUT_MS=0 turns it off.
os.environ.setdefault('DB_STATEMENT_TIMEOUT_MS', str((timeout - 5) * 1000))

# Recycle each worker after a while, staggered (`_jitter`) so all workers
# don't restart in the same instant and briefly drop capacity together —
# cheap insurance against the kind of slow memory growth a long-running
# process handling XLSX/TRP parsing can accumulate over days of uptime.
max_requests = 1000
max_requests_jitter = 100

# Surfaces worker count/CPU count in `docker compose logs django` at
# startup — makes it obvious what this actually resolved to on whatever
# server it's running on, without needing to `exec` in and check.
def on_starting(server):
    server.log.info(
        'gunicorn: %d CPU core(s) detected -> %d gthread workers x %d threads (max %d concurrent requests)',
        multiprocessing.cpu_count(), workers, threads, workers * threads,
    )
