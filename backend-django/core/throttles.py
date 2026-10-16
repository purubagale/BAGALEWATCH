"""Rate limits on every API endpoint (2026-10-15 security audit).

    UserRateLimit   per signed-in user      API_USER_RATE  (default 1200/min)
    AnonRateLimit   per client address,     API_ANON_RATE  (default 120/min)
                    before sign-in

Both are DRF's own throttles with two changes:

- The client address is the one nginx saw (`X-Real-IP`, set from the TCP
  peer, core/auth_log._client_ip), not DRF's default, which takes the
  `X-Forwarded-For` header a client can fill with anything and so dodge the
  limit.
- Phone uploads (`/api/telemetry/`) and linked systems (`/api/external/`)
  are left out: many phones share one carrier address, and both lanes have
  their own key and limits. The health checks are left out too.

A rate of 0, "off" or empty turns that limit off. Counters live in the
cache (Redis), so they are shared by every gunicorn worker.
"""
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle

EXEMPT_PREFIXES = ('/api/telemetry/', '/api/external/')
EXEMPT_PATHS = ('/api/v2/health/', '/api/health/')


def _exempt(request):
    path = request.path or ''
    return path.startswith(EXEMPT_PREFIXES) or path in EXEMPT_PATHS


class _Common:
    def get_rate(self):
        rate = super().get_rate()
        return None if not rate or str(rate).strip().lower() in ('0', 'off', 'none') else rate

    def get_ident(self, request):
        # Imported here: DRF loads this module while rest_framework.views is
        # still loading, and auth_log imports from it.
        from .auth_log import _client_ip
        return _client_ip(request) or super().get_ident(request)

    def allow_request(self, request, view):
        if _exempt(request):
            return True
        return super().allow_request(request, view)


class UserRateLimit(_Common, UserRateThrottle):
    pass


class AnonRateLimit(_Common, AnonRateThrottle):
    pass
