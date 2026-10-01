"""Generate Current-State System Documentation (2026-10-01, "i think it
contains the details from history to present. but prepare documentation
of only current final state of application... after it is in live also").

Unlike the hand-written docs/*.md files DocumentationPage.tsx bundles at
BUILD time (historical/narrative -- decision logs, dated audits), this
builds a markdown string server-side, AT CLICK TIME, by introspecting
whatever is actually deployed right now: the live Django model registry,
the live MenuItem tree, the live Role/permission-override counts. That's
the whole point of putting this behind an endpoint instead of a static
file -- it stays accurate after a production deploy with zero manual
upkeep, unlike the narrative docs.

Same construction style as build_monthly_report() (core/reports.py): a
plain Python f-string list, `'\n'.join(...)` at the end -- no template
engine, matching this codebase's one existing precedent for server-built
markdown exactly.

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

ARCHITECTURE_TEXT = """\
dtwatch is a Django REST Framework backend (PostgreSQL + PostGIS, Redis
for cache/SSO-transaction state) with a React + Vite single-page frontend,
served through nginx. Background work runs as dedicated long-lived
containers sharing the same Django image, not a task queue:

| Service | Role |
|---|---|
| `db` | PostgreSQL 16 + PostGIS |
| `redis` | Cache (login lockout) + short-lived Keycloak SSO transaction state |
| `django` | The API itself (gunicorn) |
| `frontend` | nginx serving the built React SPA, reverse-proxying `/api/`, `/media/`, `/admin/` |
| `site-sync` | Live Site Directory sync loop (`sync_live_sites --loop`) |
| `telemetry-maintenance` | Daily telemetry partition rollover + retention |
| `telemetry-bin-roller` | Frequent incremental telemetry coverage-bin rollup |
| `audit-log-maintenance` | Daily Audit Log retention enforcement |
"""


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


def _data_model_section():
    L = ['## Data Model Reference']
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
    L = ['## Features & Menu Reference', f'{len(items)} menu items currently configured, every role (not filtered to any one viewer):\n']
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


def build_system_doc():
    now = timezone.now()
    L = [
        '# DT-WATCH BTS v2 — Current System State',
        f'**Generated:** {now.strftime("%d %b %Y, %H:%M")} | '
        f'**Version:** {settings.APP_VERSION} | **Build:** {settings.BUILD_TAG or "—"} | '
        f'**Git SHA:** {(settings.GIT_SHA or "—")[:10]}',
        (
            'This document reflects the application exactly as currently deployed -- generated fresh at request '
            'time by introspecting the live database schema, menu configuration, and role setup, not hand-written '
            'or bundled at build time. It intentionally contains no history -- see the Documentation page\'s other '
            'entries for architecture decisions, audits, and migration guides.'
        ),
        '\n---\n',
        '## Architecture & Stack',
        ARCHITECTURE_TEXT,
        _data_model_section(),
        _features_menu_section(),
        _roles_permissions_section(),
        _api_reference_section(),
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
