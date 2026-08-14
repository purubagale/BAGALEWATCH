"""
Django settings for the BAGALEWATCH BTS v2 backend.

This is a NEW, standalone system — it never reads or writes the v1
system's files (bts_monitor.html, netwatch_server.py, bagalewatch_api.py,
bagalewatch.db). It gets its own PostgreSQL database, configured entirely
via environment variables (see .env.example) so credentials never live in
source control. See ../docs/RUNBOOK.md for the full isolation guarantees.
"""

import os
from datetime import timedelta
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')

SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-only-insecure-key-override-in-.env')
DEBUG = os.environ.get('DEBUG', '0') == '1'
ALLOWED_HOSTS = [h.strip() for h in os.environ.get('ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',') if h.strip()]

# ── Security hardening (2026-08-08, "secure the system for unauthorized
# access and tampering" follow-up) ──────────────────────────────────────
# Explicit rather than relying on Django's own defaults for the two that
# already default correctly (X_FRAME_OPTIONS, SECURE_CONTENT_TYPE_NOSNIFF)
# — spelling them out here means a future settings refactor can't
# silently lose them, and it documents the intent in one place instead of
# leaving a reader to go check Django's global_settings.py.
X_FRAME_OPTIONS = 'DENY'
SECURE_CONTENT_TYPE_NOSNIFF = True

# HTTPS-only cookie/transport hardening — gated on its OWN explicit env
# flag, NOT on `DEBUG=0`. Confirmed while verifying this change (2026-08-08)
# that `DEBUG=0` does NOT imply "this deployment has HTTPS" here — this
# app already runs DEBUG=0 in the user's real environment (see the
# earlier "Set DEBUG=0 in real .env" hardening pass) without necessarily
# having a TLS-terminating reverse proxy in front of it yet. Tying
# SECURE_SSL_REDIRECT to DEBUG would have silently broken every login
# with an infinite http->https redirect the moment someone deployed with
# DEBUG=0 but no HTTPS — caught here by the verification suite itself
# (the Django test client talks plain http and got redirected). These
# settings now require an explicit, separate opt-in once TLS is actually
# in place in front of Django.
if os.environ.get('HTTPS_ENABLED', '0') == '1':
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_SSL_REDIRECT = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

# CSRF is only exercised by the browsable API / Django admin's session-
# cookie login (see REST_FRAMEWORK's DEFAULT_AUTHENTICATION_CLASSES
# docstring below — the React SPA itself authenticates via JWT bearer
# tokens, which aren't subject to CSRF). Explicit, env-driven whitelist
# rather than Django's insecure-by-default "same as ALLOWED_HOSTS with no
# scheme" — mirrors CORS_ALLOWED_ORIGINS's own pattern further down.
#
# Default changed from 'http://localhost:8000' to 'http://localhost:5180'
# (2026-08-10 port-hiding pass) — django is no longer directly reachable
# on its own port at all (see docker-compose.yml); admin is now reached
# through nginx's proxy on 5180, so that's the origin a session-cookie
# login there actually comes from. Add any other real LAN origin admin
# needs to be reachable from via CSRF_TRUSTED_ORIGINS in .env (comma-
# separated) — unlike ALLOWED_HOSTS just above, Django doesn't support a
# bare '*' wildcard here.
CSRF_TRUSTED_ORIGINS = [
    o.strip() for o in os.environ.get('CSRF_TRUSTED_ORIGINS', 'http://localhost:5180').split(',') if o.strip()
]

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'corsheaders',
    'drf_spectacular',
    'core',
]

MIDDLEWARE = [
    # 2026-08-10 memory/size/performance audit finding — gunicorn is
    # exposed straight to the host on port 8000 with no reverse proxy in
    # front of it (see docker-compose.yml's `frontend`/`django` services
    # — nginx only serves the built static frontend on 5180, it never
    # proxies the API), so nothing in this stack was ever compressing API
    # responses. That matters here specifically because several endpoints
    # return genuinely large JSON (the ~4,700-site list every session
    # loads, BackupExportView's full site+sector dump). GZipMiddleware is
    # Django's own well-tested built-in — no new dependency — and must be
    # FIRST in this list per Django's own docs, since middleware process
    # the outgoing response in REVERSE list order: putting it first here
    # means it's the LAST thing to touch the response before it's sent,
    # so it compresses the final body every other middleware already
    # finished shaping, not an intermediate one.
    'django.middleware.gzip.GZipMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'bagalewatch_v2.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'bagalewatch_v2.wsgi.application'

# ── Database ──────────────────────────────────────────────────────────
# Postgres by default (matches the v2 architecture plan). DJANGO_DB_ENGINE
# can be set to 'sqlite' ONLY for a quick local smoke test when no Postgres
# server is available (e.g. this sandbox) — that uses its own throwaway
# db.sqlite3 file inside backend-django/, which is NOT bagalewatch.db and
# is never related to the v1 system in any way. Real deployments (via
# docker-compose) always use Postgres.
if os.environ.get('DJANGO_DB_ENGINE') == 'sqlite':
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',  # throwaway, dev-only — never bagalewatch.db
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.environ.get('POSTGRES_DB', 'bagalewatch_v2'),
            'USER': os.environ.get('POSTGRES_USER', 'bagalewatch'),
            'PASSWORD': os.environ.get('POSTGRES_PASSWORD', ''),
            'HOST': os.environ.get('POSTGRES_HOST', 'db'),
            'PORT': os.environ.get('POSTGRES_PORT', '5432'),
            # Persistent connections (2026-08-08, "100 concurrent users"
            # scaling pass) — previously unset, which defaults to 0
            # (close and reopen a fresh TCP+auth handshake to Postgres on
            # EVERY single request). At real concurrency that's pure
            # overhead multiplied by every gunicorn worker/thread. 60s
            # reuses a connection across a burst of requests from the same
            # worker without holding it open indefinitely between bursts —
            # `CONN_HEALTH_CHECKS` pings a reused connection before use so
            # a Postgres restart doesn't leave workers handing out dead
            # connections for the rest of that 60s window.
            'CONN_MAX_AGE': 60,
            'CONN_HEALTH_CHECKS': True,
        }
    }

# ── Cache (2026-08-08, "100 concurrent users" scaling pass) ────────────
# Redis-backed, not Django's LocMemCache default — LocMemCache is
# PER-PROCESS, and gunicorn now runs multiple worker processes (see
# gunicorn.conf.py). The login brute-force lockout counter in
# core/views.py's LoginView reads/writes this cache; under LocMemCache
# each worker had its own independent count, so the 5-attempt lockout
# wasn't reliably enforced once more than one worker existed — a real
# correctness gap this scaling pass exposed, not a hypothetical one.
# Redis is already a required service in docker-compose.yml for the Node
# gateway/Go worker, so this is a second consumer of existing
# infrastructure, not a new dependency. Uses Django's own built-in Redis
# cache backend (available since Django 4.0 — no django-redis package
# needed, just the `redis` client library in requirements.txt).
#
# Falls back to LocMemCache under the SAME `DJANGO_DB_ENGINE=sqlite` flag
# the DATABASES block above uses for throwaway smoke tests — that harness
# has no Redis instance running alongside it, and per-worker cache
# consistency doesn't matter for a single-process `manage.py` test run
# anyway (see this repo's established verification convention of
# `DJANGO_DB_ENGINE=sqlite` meaning "no external infra available").
if os.environ.get('DJANGO_DB_ENGINE') == 'sqlite':
    CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': os.environ.get('REDIS_URL', 'redis://redis:6379/1'),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ── Auth (Phase 1) ───────────────────────────────────────────────────
# Custom user model — must be set before the first migration (see
# core/models.py:User). Adds role/name/dept on top of Django's built-in
# username+password auth.
AUTH_USER_MODEL = 'core.User'

# Django's own PBKDF2PasswordHasher stays first (preferred) — every NEW
# or upgraded password uses Django's native format. The legacy hasher
# only ever verifies hashes imported from v1 by the seed script, and is
# never used to encode new ones (see core/hashers.py for the full
# upgrade-on-login mechanics).
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher',
    'django.contrib.auth.hashers.Argon2PasswordHasher',
    'django.contrib.auth.hashers.BCryptSHA256PasswordHasher',
    'core.hashers.LegacyBagalewatchPBKDF2Hasher',
    'core.hashers.LegacyBagalewatchSha256Hasher',
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Uploaded branding logo (2026-08-08, v2-only — v1 has no equivalent file
# upload feature) — first real user-uploaded file in this app, so this is
# the first time MEDIA_ROOT/MEDIA_URL have been needed. Served via
# bagalewatch_v2/urls.py's static() helper in DEBUG; a real deployment
# behind nginx/gunicorn would serve /media/ directly from this same
# directory (a bind-mounted volume in docker-compose), same convention
# as any other Django app.
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# ── CORS ──────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('CORS_ALLOWED_ORIGINS', 'http://localhost:5180').split(',') if o.strip()]

# ── DRF / API schema ──────────────────────────────────────────────────
# Auth transport: JWT, not session cookies — the decision the migration
# plan (§9) flagged as "make at the start of Phase 1." Chosen over
# sessions specifically because the React SPA (port 5180) and Django API
# (port 8000) are different origins: session cookies would need
# SESSION_COOKIE_SAMESITE='None' (HTTPS-only) plus a CSRF token exchange
# just for local http dev, where a short-lived bearer token has none of
# that friction. SessionAuthentication is kept too, only so the DRF
# browsable API and /admin/ stay usable from a browser during development.
REST_FRAMEWORK = {
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ],
    # 'external_api' is only ever used by core/api_auth.py's
    # ApiKeyRateThrottle, opted into per-view by core/external_api.py
    # (2026-08-12) — not a DEFAULT_THROTTLE_CLASSES entry, so this has
    # zero effect on any /api/v2/ endpoint. Generous but bounded: this is
    # a small internal-NTC integration surface, not a public rate-limited
    # SaaS API — the goal is catching a misbehaving/looping integration,
    # not fine-grained tiering. Override via the EXTERNAL_API_RATE env
    # var if a real integration ever needs more (e.g. a KPI feed pushing
    # thousands of sites on a tight interval).
    'DEFAULT_THROTTLE_RATES': {
        'external_api': os.environ.get('EXTERNAL_API_RATE', '300/min'),
    },
}

# Access token lifetime is short (matches v1's 5-minute idle-timeout
# spirit — see PBKDF2_ITERATIONS/SESSION_LIFETIME_SECS in
# bagalewatch_api.py) without literally forcing a re-login every 5
# minutes of active use: the refresh token silently renews it in the
# background as long as the user keeps interacting. True idle-timeout
# (log out after N minutes of no activity, regardless of token validity)
# is a frontend concern — an inactivity timer that stops refreshing and
# clears in-memory tokens, same as v1's client-side timer does today.
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(hours=12),
    'ROTATE_REFRESH_TOKENS': True,
    'AUTH_HEADER_TYPES': ('Bearer',),
}

SPECTACULAR_SETTINGS = {
    'TITLE': 'BAGALEWATCH BTS v2 API',
    'DESCRIPTION': 'REST API for the BAGALEWATCH BTS v2 backend (Django service).',
    'VERSION': '2.0.0-phase1',
}

# ── Logging (2026-08-10, found while debugging a real "Import failed.
# (HTTP 500)" report with no visible cause) ─────────────────────────────
# Django's own default logging config only sends the 'django'/
# 'django.request' loggers to console when DEBUG=True (its built-in
# 'console' handler has a `require_debug_true` filter) — with DEBUG=0
# (deliberately set for production, see the DEBUG/HTTPS comments above)
# and no ADMINS configured for the other default handler (mail_admins),
# an unhandled view exception was being caught by Django's exception
# middleware, turned into a bare 500 response, and logged NOWHERE.
# Confirmed live: a real 500 during a sector import produced zero trace
# of the actual Python exception in `docker compose logs django`. This
# explicit config restores visibility regardless of DEBUG — every
# unhandled request exception (full traceback, same as `django.request`
# always logs internally) and anything this app's own `core` module logs
# now prints to stdout, which `docker compose logs` already captures for
# every container in this stack.
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'WARNING',
    },
    'loggers': {
        'django': {
            'handlers': ['console'],
            'level': 'INFO',
            'propagate': False,
        },
        'django.request': {
            # Where Django's exception middleware logs every unhandled
            # view exception (500) — this was the logger effectively
            # going nowhere before this config existed.
            'handlers': ['console'],
            'level': 'ERROR',
            'propagate': False,
        },
        'core': {
            'handlers': ['console'],
            'level': 'INFO',
            'propagate': False,
        },
    },
}
