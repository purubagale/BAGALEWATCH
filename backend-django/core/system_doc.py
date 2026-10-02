"""Generate Current-State System Documentation (2026-10-01/02, "prepare
documentation of only current final state of application... architecture
reference as UTS").

Unlike the hand-written docs/*.md files this used to bundle at build time
(historical/narrative -- decision logs, dated audits, migration guides),
this builds a markdown string server-side, AT CLICK TIME, by introspecting
whatever is actually deployed right now: the live Django model registry,
the live MenuItem tree, the live Role/permission-override counts. That's
the whole point of putting this behind an endpoint instead of a static
file -- it stays accurate after a production deploy with zero manual
upkeep. DocumentationPage.tsx now surfaces ONLY this generated document
(the old static bundle was removed, 2026-10-02 follow-up: "do not include
history or phase, only display current final state only") -- every
section below is either live-introspected or genuinely static fact
(tech stack, topology), never a dated narrative entry.

Structured like a conventional architecture-reference doc (Overview ->
Architecture -> Data Models -> Features -> Roles & Permissions -> API
Reference -> Configuration), same shape as a typical internal system
overview doc, but every section here is either live-introspected or a
plain fact about the stack that doesn't go stale -- no roadmap, no
decision rationale, no troubleshooting runbook (those stay in git history/
commit messages, which is where "how we got here" belongs; this document
answers "what is this, right now").

Markdown is built the same way build_monthly_report() (core/reports.py)
already does -- a plain Python f-string list, `'\n'.join(...)` at the
end -- no template engine, matching this codebase's one existing
precedent for server-built markdown exactly.

Deliberately does NOT re-derive an API route list -- drf-spectacular is
already installed and wired up (settings.py's SPECTACULAR_SETTINGS,
dtwatch/urls.py's /api/v2/schema/ and /api/v2/docs/), already live,
already auto-generated from the real DRF views/serializers. Duplicating
that by hand here would be a second, lower-fidelity source of truth --
the API Reference section below just links to it.
"""
from django.apps import apps
from django.conf import settings
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import MenuItem, MenuItemRoleVisibility, MenuPermission, Role
from .views import IsAdminOrSuperadmin

OVERVIEW_TEXT = """\
DT-WATCH BTS v2 is Nepal Telecom's 4G RAN Operations & Maintenance
platform -- site/sector inventory, KPI tracking, drive-test analysis,
crowdsourced telemetry coverage, RF optimization report import, and the
admin surfaces (RBAC, audit logging, live site sync) that support them.
It is a single-tenant Django REST Framework + React application, deployed
entirely via Docker Compose.
"""

TOPOLOGY_DIAGRAM = """\
```
 Browser
   |  HTTPS
   v
 frontend (nginx, :5180 published)
   |  /api/, /media/, /admin/ reverse-proxied
   v
 django (gunicorn, internal only)
   |                    |
   v                    v
 db (PostgreSQL+PostGIS) redis (cache + SSO txn state)

 Background loops (same django image, own containers, no task queue):
   site-sync              -- Live Site Directory sync
   telemetry-maintenance  -- telemetry partition rollover + retention
   telemetry-bin-roller   -- incremental telemetry coverage-bin rollup
   audit-log-maintenance  -- Audit Log retention
```
"""

SERVICE_INVENTORY_ROWS = [
    ('frontend', 'nginx serving the built React SPA; reverse-proxies /api/, /media/, /admin/ to django', '5180 (published)'),
    ('django', 'The API itself (gunicorn + Django REST Framework)', '8000 (internal only)'),
    ('db', 'PostgreSQL 16 + PostGIS', '5432 (internal only)'),
    ('redis', 'Cache (login lockout) + short-lived Keycloak SSO transaction state', '6379 (internal only)'),
    ('site-sync', 'Live Site Directory sync loop (`sync_live_sites --loop`)', '—'),
    ('telemetry-maintenance', 'Daily telemetry partition rollover + retention', '—'),
    ('telemetry-bin-roller', 'Frequent incremental telemetry coverage-bin rollup', '—'),
    ('audit-log-maintenance', 'Daily Audit Log retention enforcement', '—'),
]

TECH_STACK_ROWS = [
    ('Backend framework', 'Django 5 + Django REST Framework'),
    ('Database', 'PostgreSQL 16 + PostGIS (spatial queries)'),
    ('Cache / ephemeral state', 'Redis'),
    ('Auth', 'JWT (SimpleJWT) + optional Keycloak SSO (OIDC)'),
    ('API schema/docs', 'drf-spectacular (OpenAPI 3) -- /api/v2/schema/, /api/v2/docs/'),
    ('Frontend', 'React 19 + TypeScript + Vite'),
    ('Maps', 'Leaflet + MarkerCluster'),
    ('Web server', 'nginx (static assets + reverse proxy)'),
    ('Deployment', 'Docker Compose, one image per Python service, built React bundle served by nginx'),
]

CONFIG_ROWS = [
    ('POSTGRES_HOST / POSTGRES_PORT', 'Database connection'),
    ('REDIS_URL', 'Cache + SSO transaction store (shared single Redis instance)'),
    ('APP_VERSION / BUILD_TAG / GIT_SHA', 'Build stamp surfaced on /api/v2/health/ and this document'),
    ('AUDIT_LOG_RETENTION_DAYS', 'Audit Log + access-log retention cutoff (default 30)'),
    ('TELEMETRY_RETENTION_DAYS', 'Telemetry raw-sample retention before partition drop (default 90)'),
    ('TELEMETRY_MAINTENANCE_INTERVAL_HOURS', 'How often telemetry-maintenance runs a pass (default 24)'),
    ('IDLE_TIMEOUT_MINUTES', 'Default auto-logout, overridable per-install via Branding settings'),
]


def _field_rows(model):
    rows = []
    for f in model._meta.fields:
        kind = type(f).__name__
        attrs = []
        if f.primary_key:
            attrs.append('pk')
        if getattr(f, 'null', False):
            attrs.append('null')
        if getattr(f, 'blank', False):
            attrs.append('blank')
        if getattr(f, 'choices', None):
            attrs.append('choices')
        target = getattr(getattr(f, 'remote_field', None), 'model', None)
        if target is not None:
            attrs.append(f'-> {target._meta.object_name}')
        rows.append((f.name, kind, ', '.join(attrs) or '—'))
    for f in model._meta.many_to_many:
        target = f.remote_field.model
        rows.append((f.name, 'ManyToManyField', f'-> {target._meta.object_name}'))
    return rows


def _architecture_section():
    L = ['## Architecture', '### High-Level Topology', TOPOLOGY_DIAGRAM, '### Full Service Inventory']
    L.append('| Service | Purpose | Port |\n|---|---|---|')
    for name, purpose, port in SERVICE_INVENTORY_ROWS:
        L.append(f'| `{name}` | {purpose} | {port} |')
    L.append('\n### Technology Stack')
    L.append('| Concern | Choice |\n|---|---|')
    for concern, choice in TECH_STACK_ROWS:
        L.append(f'| {concern} | {choice} |')
    return '\n'.join(L)


def _data_model_section():
    L = ['\n## Data Model Reference']
    models = sorted(apps.get_app_config('core').get_models(), key=lambda m: m._meta.object_name)
    L.append(f'{len(models)} models, as currently defined in `core/models.py`.\n')
    for model in models:
        L.append(f'### {model._meta.object_name}')
        L.append(f'Table: `{model._meta.db_table}`\n')
        L.append('| Field | Type | Notes |\n|---|---|---|')
        for name, kind, notes in _field_rows(model):
            L.append(f'| {name} | {kind} | {notes} |')
        L.append('')
    return '\n'.join(L)


def _menu_tree_lines(parent_id, items_by_parent, depth):
    out = []
    for item in sorted(items_by_parent.get(parent_id, []), key=lambda i: (i.order, i.id)):
        indent = '  ' * depth
        out.append(f'{indent}- **{item.label}** (`{item.path}`, access: {item.access})')
        out.extend(_menu_tree_lines(item.id, items_by_parent, depth + 1))
    return out


def _features_menu_section():
    items = list(MenuItem.objects.all())
    items_by_parent: dict = {}
    for item in items:
        items_by_parent.setdefault(item.parent_id, []).append(item)
    L = ['\n## Features & Menu Reference', f'{len(items)} menu items currently configured, every role (not filtered to any one viewer):\n']
    L.extend(_menu_tree_lines(None, items_by_parent, 0))
    return '\n'.join(L)


def _roles_permissions_section():
    L = ['\n## Roles & Permissions Reference']
    roles = list(Role.objects.all().order_by('name'))
    L.append(f'{len(roles)} roles currently defined.\n')
    L.append('| Role | Label | Builtin | Permission rows | Menu visibility overrides |\n|---|---|---|---|---|')
    for role in roles:
        perm_count = MenuPermission.objects.filter(role=role.name).count()
        vis_count = MenuItemRoleVisibility.objects.filter(role=role).count()
        L.append(f'| {role.name} | {role.label} | {"yes" if role.is_builtin else "no"} | {perm_count} | {vis_count} |')
    return '\n'.join(L)


def _api_reference_section():
    return (
        '\n## API Reference\n'
        'Auto-generated from the live DRF views/serializers (drf-spectacular) -- always exactly matches the '
        'deployed code, so it is linked here rather than duplicated:\n\n'
        '- Interactive Swagger UI: `/api/v2/docs/`\n'
        '- Raw OpenAPI schema: `/api/v2/schema/`\n'
    )


def _configuration_section():
    L = ['\n## Configuration', 'Every service is configured through environment variables (`.env`, read by `docker-compose.yml`). Key variables:\n']
    L.append('| Variable | Purpose |\n|---|---|')
    for name, purpose in CONFIG_ROWS:
        L.append(f'| `{name}` | {purpose} |')
    return '\n'.join(L)


def build_system_doc():
    now = timezone.now()
    L = [
        '# DT-WATCH BTS v2 — Current System State',
        f'**Generated:** {now.strftime("%d %b %Y, %H:%M")} | '
        f'**Version:** {settings.APP_VERSION} | **Build:** {settings.BUILD_TAG or "—"} | '
        f'**Git SHA:** {(settings.GIT_SHA or "—")[:10]}',
        (
            'This document reflects the application exactly as currently deployed -- generated fresh at request '
            'time by introspecting the live database schema, menu configuration, and role setup. It intentionally '
            'contains no history, roadmap, or decision rationale -- only what the system currently is.'
        ),
        '\n---\n',
        '## Overview',
        OVERVIEW_TEXT,
        _architecture_section(),
        _data_model_section(),
        _features_menu_section(),
        _roles_permissions_section(),
        _api_reference_section(),
        _configuration_section(),
    ]
    return {
        'markdown': '\n'.join(L),
        'meta': {
            'generated_at': now.isoformat(),
            'version': settings.APP_VERSION,
            'build_tag': settings.BUILD_TAG,
            'git_sha': settings.GIT_SHA,
        },
    }


class SystemDocView(APIView):
    """GET /api/v2/system-doc/ -- generates the current-state document on
    demand (see module docstring). Same access tier as the Documentation
    page itself (admin + superadmin) -- this is still just structural/
    descriptive information (schema shape, menu labels, role names), never
    actual data rows or secrets, so it doesn't need System Health's
    superadmin-only tier."""
    permission_classes = [IsAuthenticated, IsAdminOrSuperadmin]

    def get(self, request):
        return Response(build_system_doc())
