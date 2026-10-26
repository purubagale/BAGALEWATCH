"""The sites around a problem report (2026-10-19), for the "Nearest sites"
tab of its full diagnostics, after NTC's ticketing system's own view.

    GET /api/v2/problem-reports/<id>/nearby-sites/?radius_km=1

Sites within 1, 2, 3, 5 or 10 km of the reported spot, nearest first, each
with its distance and bearing from the spot, its technologies and sector
count, and whether it served the report. Admin and superadmin, like the
reports themselves. Sites are masts, so nothing personal is shown.
"""
import math

from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.geos import Point
from django.contrib.gis.measure import D
from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ProblemReport, Sector, Site
from .problem_report import CanUseProblemDashboard

RADII_KM = (1, 2, 3, 5, 10)
MAX_SITES = 80


def _bearing(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return round((math.degrees(math.atan2(x, y)) + 360) % 360)


class ProblemReportNearbySitesView(APIView):
    permission_classes = [CanUseProblemDashboard]

    def get(self, request, pk):
        report = get_object_or_404(ProblemReport, pk=pk)
        try:
            radius = float(request.query_params.get('radius_km', 1))
        except (TypeError, ValueError):
            radius = 1
        radius = min(RADII_KM, key=lambda r: abs(r - radius))
        point = Point(report.lng, report.lat, srid=4326)
        sites = list(
            Site.objects.filter(location__distance_lte=(point, D(km=radius)))
            .annotate(distance=Distance('location', point)).order_by('distance')[:MAX_SITES]
        )
        techs = {}
        for row in Sector.objects.filter(site__in=sites).values('site_id', 'tech'):
            entry = techs.setdefault(row['site_id'], {'techs': set(), 'sectors': 0})
            entry['techs'].add(row['tech'])
            entry['sectors'] += 1
        order = {'2G': 0, '3G': 1, '4G': 2, '5G': 3}
        return Response({
            'radius_km': radius, 'radii_km': RADII_KM, 'center': {'lat': report.lat, 'lng': report.lng},
            'serving_site_id': report.site_id or None,
            'sites': [{
                'site_id': s.pk, 'name': s.name or None, 'district': s.district or None,
                'lat': s.lat, 'lng': s.lng, 'distance_m': round(s.distance.m),
                'bearing_deg': _bearing(report.lat, report.lng, s.lat, s.lng),
                'techs': sorted(techs.get(s.pk, {}).get('techs', set()), key=lambda t: order.get(t, 9)),
                'sectors': techs.get(s.pk, {}).get('sectors', 0),
                'status': s.status or None, 'serving': s.pk == report.site_id,
            } for s in sites],
        })
