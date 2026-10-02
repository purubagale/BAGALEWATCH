"""
Dashboard — the new customizable home page (2026-08-08 request: "after
login, display dashboard should be like this... dashboard should be like
with some features that can be displayed with style... some may be
summary display and some may be link to feature... dashboard display
contents also should be customizable by individual user by themselves
and save for later use").

Two card types share one shape end-to-end (DB row, API payload, frontend
component): STAT cards (a fixed, hardcoded list of live-computed numbers
— total sites, sites needing attention, drive-test session count) and
SHORTCUT cards (one per top-level MenuItem the requesting user can
currently see, reusing `get_visible_menu_items()` from views.py — the
EXACT same rule the sidebar itself uses, so a dashboard card never
offers a shortcut to somewhere that user isn't actually allowed to go).

Per-user layout (which cards are visible, what order) is saved to
DashboardCardConfig rather than localStorage — an explicit user decision
made via AskUserQuestion, since this app already syncs everything else
(tree structure, permissions, DT sessions) across browsers/devices, and
a per-browser-only dashboard layout would be the one inconsistent
exception.
"""
from django.core.cache import cache
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DashboardCardConfig, DriveTestSession, Site
from .views import get_visible_menu_items

# 2026-10-02 perf audit: every dashboard load (i.e. every login, every
# home-page visit, for every user) was issuing 7 separate .count() queries
# -- none of these numbers change more than a few times a day in practice
# (site status/deployment changes, a new DT session), so a short-TTL cache
# shared across ALL users (these aren't per-user values) cuts that to
# roughly one real query set per minute network-wide instead of per
# request. Plain TTL expiry, no write-path invalidation -- matches the
# same tradeoff already used for the SLA/NTA/Monthly/Scatter report cache
# in reports.py.
DASHBOARD_STATS_CACHE_KEY = 'dashboard:stats:v1'
DASHBOARD_STATS_CACHE_TTL = 60

# Fixed catalog of stat cards — deliberately a short, hand-picked list
# rather than something fully dynamic/admin-configurable (unlike
# MenuItem): each one needs real query logic behind it (see
# _stat_value below), so "add a stat card" is a code change, not an
# admin-page action. Shortcut cards (built from MenuItem in
# DashboardView._catalog) are what a superadmin can actually add to
# without touching Python.
#
# `default_visible` (2026-09-29, "initially do not display critical
# sites and warning sites count in default") -- only affects a user who
# has never touched their OWN Customize layout for that specific card
# (DashboardView.get()'s `cfg.visible if cfg else default_visible`); a
# user who already saved an explicit preference, hidden or shown, is
# never overridden by a change here. Omitted entirely = visible by
# default, same as before this existed.
STAT_CARDS = [
    {'key': 'stat-total-sites', 'label': 'Total Sites', 'icon': '🗼'},
    {'key': 'stat-sites-crit', 'label': 'Critical Sites', 'icon': '🔴', 'default_visible': False},
    {'key': 'stat-sites-warn', 'label': 'Warning Sites', 'icon': '🟠', 'default_visible': False},
    {'key': 'stat-dt-sessions', 'label': 'Drive-Test Sessions', 'icon': '🚗'},
    # 2026-09-29 addition ("display active site count, planned site
    # count and decommisioning site count") -- Site.deployment_status is
    # the Live Site Directory sync's own real NetBox on-air/planned/etc
    # state (core/live_sites.py), a separate concept from `status` (this
    # app's own KPI-health traffic light) that stat-sites-crit/warn above
    # already read.
    {'key': 'stat-sites-active', 'label': 'Active Sites', 'icon': '🟢'},
    {'key': 'stat-sites-planned', 'label': 'Planned Sites', 'icon': '🧭'},
    {'key': 'stat-sites-decommissioning', 'label': 'Decommissioning Sites', 'icon': '🚧'},
]


class DashboardView(APIView):
    """GET/PUT /api/v2/dashboard/.

    GET merges three things: (1) live-computed values for STAT_CARDS,
    (2) one shortcut card per top-level MenuItem this user can see
    (excluding Dashboard itself — linking Dashboard to Dashboard is
    pointless), and (3) this user's own saved DashboardCardConfig rows
    for order/visibility — a card with no saved row defaults to visible,
    in catalog order, so a brand-new user gets a sensible dashboard
    without ever having customized anything.

    PUT does a per-card upsert (same convention as ThresholdsView /
    PermissionsMatrixView elsewhere in this app), NOT a delete-and-
    replace — only the cards included in the request body are touched.
    """

    permission_classes = [IsAuthenticated]

    def _catalog(self, user, request):
        cards = [
            {**c, 'type': 'stat', 'path': None, 'link_type': None, 'description': '', 'icon_image_url': None}
            for c in STAT_CARDS
        ]
        visible_top, _ = get_visible_menu_items(user)
        for item in visible_top:
            # '/m4h8qz' is '/dashboard's own obfuscated form (migration
            # 0019_obfuscate_dashboard_sites_paths) -- this check used to
            # compare against the plain '/dashboard' string and silently
            # stopped matching anything the moment that migration ran,
            # so the Dashboard menu item stopped being excluded and
            # showed up as a shortcut card linking to itself (found
            # 2026-09-29, "do not display dashboard tab inside
            # dashboard, i think it is not needed").
            if item.path == '/m4h8qz':
                continue
            cards.append({
                'key': f'menu-{item.id}',
                'label': item.label,
                'icon': item.icon or '🔗',
                # Uploaded icon image (2026-08-08 follow-up), same
                # precedence-over-emoji rule as MenuTreeView's serialize().
                'icon_image_url': (
                    request.build_absolute_uri(item.icon_image.url) if item.icon_image else None
                ),
                'type': 'shortcut',
                'path': item.path,
                'link_type': item.link_type,
                'description': item.description,
            })
        return cards

    def _compute_stats(self):
        return {
            'stat-total-sites': Site.objects.count(),
            'stat-sites-crit': Site.objects.filter(status='crit').count(),
            'stat-sites-warn': Site.objects.filter(status='warn').count(),
            'stat-dt-sessions': DriveTestSession.objects.count(),
            'stat-sites-active': Site.objects.filter(deployment_status__iexact='Active').count(),
            'stat-sites-planned': Site.objects.filter(deployment_status__iexact='Planned').count(),
            'stat-sites-decommissioning': Site.objects.filter(deployment_status__iexact='Decommissioning').count(),
        }

    def _cached_stats(self):
        stats = cache.get(DASHBOARD_STATS_CACHE_KEY)
        if stats is None:
            stats = self._compute_stats()
            cache.set(DASHBOARD_STATS_CACHE_KEY, stats, DASHBOARD_STATS_CACHE_TTL)
        return stats

    def get(self, request):
        catalog = self._catalog(request.user, request)
        saved = {c.card_key: c for c in DashboardCardConfig.objects.filter(user=request.user)}
        # Fetched once per request (not per card) -- every 'stat' card
        # below reads from this same dict instead of hitting the DB (or
        # even Redis) once per card.
        stats = self._cached_stats()

        out = []
        for i, card in enumerate(catalog):
            cfg = saved.get(card['key'])
            # Popped rather than left in `card` -- it's an input to this
            # loop's own default-visibility decision, not part of the
            # card shape the frontend's DashboardCard type expects back.
            default_visible = card.pop('default_visible', True)
            out.append({
                **card,
                'value': stats.get(card['key']) if card['type'] == 'stat' else None,
                # Catalog order (i * 10) leaves gaps for a user's custom
                # ordering to slot into without needing to renumber
                # everything else — same spacing convention as MenuItem's
                # seeded `order` values (10, 20, 30, ...).
                'order': cfg.order if cfg else i * 10,
                'visible': cfg.visible if cfg else default_visible,
            })
        out.sort(key=lambda c: (c['order'], c['key']))
        return Response(out)

    def put(self, request):
        body = request.data or {}
        cards = body.get('cards') or []
        with transaction.atomic():
            for entry in cards:
                key = entry.get('card_key')
                if not key:
                    continue
                DashboardCardConfig.objects.update_or_create(
                    user=request.user, card_key=key,
                    defaults={
                        'order': int(entry.get('order', 0)),
                        'visible': bool(entry.get('visible', True)),
                    },
                )
        return Response({'ok': True})
