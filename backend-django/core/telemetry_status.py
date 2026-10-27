"""What a phone reading without a network really means (2026-10-26).

A reading with no network used to count as "no service". On prod and here
nearly all of them had no GPS position either: the phone withheld both,
because the app was in the background without background location, or
location was off. A real coverage gap still gets a position. So a reading
falls in one of four groups:

  measured      the phone named its network (LTE, NR, UMTS, GSM)
  no_coverage   no network, and the phone said it was out of service or
                emergency-only; on older readings (no service state sent),
                no network but a GPS position
  radio_off     flight mode, radio off, or no usable SIM
  not_measured  no network and no proof of a coverage gap: the phone did
                not let the app read the cell (background, location off,
                no permission) or returned nothing

Only `measured` and `no_coverage` say anything about the network; the other
two are left out of coverage and quality shares and shown on their own.
Server access failures never appear here: a stored reading reached the
server. How late it arrived is a separate sign (received_at - ts).
"""
from django.db.models import Case, CharField, Count, Q, Value, When

MEASURED_NETWORKS = ('LTE', 'NR', 'UMTS', 'GSM')

LABELS = {
    'measured': 'Measured',
    'no_coverage': 'No coverage',
    'radio_off': 'Flight mode, radio off or no SIM',
    'not_measured': 'Not measured',
}
HINTS = {
    'no_coverage': 'the phone found no network',
    'radio_off': 'not a network fault',
    'not_measured': 'the phone did not let the app read the cell (app in the background, location off) - not a network fault',
}
CELL_INFO_HINTS = {
    'background': 'app in the background without background location',
    'location_off': 'location switched off on the phone',
    'no_permission': 'no location permission',
    'empty': 'the phone returned no cell',
}

_RADIO_OFF = Q(airplane_mode=True) | Q(service_state='radio_off') | Q(sim_state__in=('absent', 'locked'))
_NO_COVERAGE = Q(service_state__in=('out_of_service', 'emergency_only')) | (
    Q(service_state__isnull=True) & Q(cell_info_status__isnull=True) & Q(lat__isnull=False))


def status_case():
    """A Case expression giving each TelemetrySample row its group."""
    return Case(
        When(network_type__in=MEASURED_NETWORKS, then=Value('measured')),
        When(_RADIO_OFF, then=Value('radio_off')),
        When(_NO_COVERAGE, then=Value('no_coverage')),
        default=Value('not_measured'), output_field=CharField(),
    )


def status_of(network_type, lat=None, service_state=None, cell_info_status=None, airplane_mode=None, sim_state=None):
    """The same rule in Python, for rows already read."""
    if network_type in MEASURED_NETWORKS:
        return 'measured'
    if airplane_mode or service_state == 'radio_off' or sim_state in ('absent', 'locked'):
        return 'radio_off'
    if service_state in ('out_of_service', 'emergency_only') or (
            service_state is None and cell_info_status is None and lat is not None):
        return 'no_coverage'
    return 'not_measured'


def status_breakdown(qs):
    """[{status, label, hint, readings, reasons:{cell_info_status: n}}] for the
    readings with no network in `qs`, largest first."""
    rows = {}
    for r in (qs.exclude(network_type__in=MEASURED_NETWORKS).annotate(st=status_case())
              .values('st', 'cell_info_status').annotate(n=Count('id')).order_by()):
        e = rows.setdefault(r['st'], {'status': r['st'], 'label': LABELS[r['st']], 'hint': HINTS.get(r['st'], ''),
                                      'readings': 0, 'reasons': {}})
        e['readings'] += r['n']
        if r['cell_info_status']:
            e['reasons'][r['cell_info_status']] = e['reasons'].get(r['cell_info_status'], 0) + r['n']
    return sorted(rows.values(), key=lambda e: -e['readings'])
