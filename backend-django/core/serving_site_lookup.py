"""The site and sector a phone is served by, for the app's Signal screen
(2026-10-19).

    GET /api/telemetry/v1/device/serving-site/
        ?network=LTE|UMTS|GSM &cell_id= &pci= &psc= &bcch= &bsic= &lat= &lon=

Signed, so only a registered phone can ask. The answer uses the same rule
as stored readings (`dt_serving_cell.attach_serving_cells`): a cell
identity (4G eNodeB + cell, 2G/3G LAC + CI) is matched exactly, with or
without a position; otherwise the physical id (PCI, scrambling code,
BCCH+BSIC) is matched near the phone's position. Nothing is stored; the
position only picks among sites that share an id.
"""
from rest_framework.response import Response
from rest_framework.views import APIView

from .device_auth import DeviceSignatureAuthentication, IsDevice
from .dt_serving_cell import attach_serving_cells
from .telemetry import TELEMETRY_MATCH_MAX_KM

_TECH = {'LTE': '4G', 'UMTS': '3G', 'GSM': '2G'}


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


def lookup_serving_site(network, cell_id=None, pci=None, psc=None, bcch=None, bsic=None, lat=None, lon=None,
                        tac=None):
    """{site_id, site_name, sector, cell_name, distance_m} or None. A cell
    identity (4G eNodeB + cell, 2G/3G LAC + CI) answers without a position;
    a PCI, scrambling code or BCCH/BSIC needs one."""
    tech = _TECH.get((network or '').upper())
    if tech is None:
        return None
    row = {'lat': lat, 'lng': lon, 'cell_id': cell_id, 'tac': tac, 'pci': pci, 'scrambling_code': psc,
           'bcch': bcch, 'bsic': bsic}
    attach_serving_cells([row], tech, max_km=TELEMETRY_MATCH_MAX_KM)
    if not row.get('serving_site_id'):
        return None
    return {
        'site_id': row['serving_site_id'],
        'site_name': row.get('serving_site_name') or row['serving_site_id'],
        'sector': row.get('serving_sector'),
        'cell_name': row.get('serving_cell_name'),
        'distance_m': round(row['serving_dist_km'] * 1000) if row.get('serving_dist_km') is not None else None,
    }


class DeviceServingSiteView(APIView):
    authentication_classes = [DeviceSignatureAuthentication]
    permission_classes = [IsDevice]

    def get(self, request):
        q = request.query_params
        site = lookup_serving_site(
            q.get('network'),
            cell_id=_int(q.get('cell_id')), pci=_int(q.get('pci')), psc=_int(q.get('psc')),
            bcch=_int(q.get('bcch')), bsic=_int(q.get('bsic')), tac=_int(q.get('tac')),
            lat=_float(q.get('lat'), -90, 90), lon=_float(q.get('lon'), -180, 180),
        )
        return Response({'site': site})
