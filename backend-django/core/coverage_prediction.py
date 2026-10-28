"""Radio values for the predicted coverage on the site map (2026-10-28).

The site map works out a predicted signal level around a site in the browser
(frontend lib/coveragePrediction.ts): the sector's power and antenna gain,
less the antenna pattern, the path loss (Okumura-Hata / COST-231 Hata with
the effective antenna height over the point) and the loss over the highest
ridge in between (knife-edge diffraction), on the same ground heights as the
3D view. This file only keeps the radio values it needs.

NTC's planning values (reference signal power, antenna gain, feeder loss per
band) were not available when this was built, so every value starts at a
typical figure for NTC's equipment and an admin changes it on the site map
when the real ones arrive. A sector's own maximum transmit power from the
engineering parameters, when the site list has it, comes before the band's
power. Nothing here is stored per prediction; changing a value redraws it.
"""
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .audit import log_audit_event
from .models import CoveragePredictionSettings
from .views import IsAdminOrSuperadmin

# Per band: downlink centre frequency, the power the predicted level is
# counted from (4G reference signal per resource element, 3G CPICH, 2G
# BCCH carrier), channel bandwidth (4G, to turn a sector's maximum power into
# its reference signal power), antenna gain and the loss between radio and
# antenna. Starting values: 40 W per 4G carrier, 20 W per 2G carrier, CPICH
# 10% of 20 W; multi-band panels about 15.5 dBi low band, 17.5-18 high band.
BANDS = {
    'lte_b20': {'label': '4G B20 (800 MHz)', 'tech': '4G', 'freq_mhz': 806, 'power_dbm': 18.2, 'bandwidth_mhz': 10,
                'gain_dbi': 15.5, 'loss_db': 0.5},
    'lte_b3': {'label': '4G B3 (1800 MHz)', 'tech': '4G', 'freq_mhz': 1840, 'power_dbm': 15.2, 'bandwidth_mhz': 20,
               'gain_dbi': 17.5, 'loss_db': 0.5},
    'wcdma_b1': {'label': '3G B1 (2100 MHz)', 'tech': '3G', 'freq_mhz': 2140, 'power_dbm': 33.0, 'bandwidth_mhz': None,
                 'gain_dbi': 18.0, 'loss_db': 0.5},
    'gsm900': {'label': '2G 900 MHz', 'tech': '2G', 'freq_mhz': 947, 'power_dbm': 43.0, 'bandwidth_mhz': None,
               'gain_dbi': 15.5, 'loss_db': 2.0},
    'gsm1800': {'label': '2G 1800 MHz', 'tech': '2G', 'freq_mhz': 1842, 'power_dbm': 43.0, 'bandwidth_mhz': None,
                'gain_dbi': 17.5, 'loss_db': 2.0},
}
VALUE_KEYS = ('freq_mhz', 'power_dbm', 'bandwidth_mhz', 'gain_dbi', 'loss_db')
LIMITS = {
    'freq_mhz': (400, 6000), 'power_dbm': (-10, 60), 'bandwidth_mhz': (1.4, 100),
    'gain_dbi': (0, 25), 'loss_db': (0, 15),
}
ENVIRONMENTS = ('urban', 'suburban', 'rural')
GLOBAL_DEFAULTS = {
    'environment': 'suburban', 'rx_height_m': 1.5, 'default_height_m': 25.0, 'default_tilt_deg': 4.0, 'offset_db': 0.0,
}
GLOBAL_LIMITS = {
    'rx_height_m': (0.5, 30), 'default_height_m': (3, 150), 'default_tilt_deg': (-5, 20), 'offset_db': (-40, 40),
}


def _merged_bands(row):
    saved = (row.bands if row else None) or {}
    out = {}
    for key, base in BANDS.items():
        changed = saved.get(key) or {}
        vals = {k: changed.get(k, base[k]) for k in VALUE_KEYS}
        out[key] = {'label': base['label'], 'tech': base['tech'], **vals,
                    'changed': sorted(k for k in VALUE_KEYS if k in changed and changed[k] != base[k])}
    return out


def settings_view(row=None):
    row = row if row is not None else CoveragePredictionSettings.load()
    glob = {k: (getattr(row, k) if row else v) for k, v in GLOBAL_DEFAULTS.items()}
    return {
        'bands': _merged_bands(row),
        **glob,
        'defaults': {'bands': {k: {x: v[x] for x in VALUE_KEYS} for k, v in BANDS.items()}, **GLOBAL_DEFAULTS},
        'is_default': row is None or (not any(_merged_bands(row)[k]['changed'] for k in BANDS)
                                      and all(getattr(row, k) == v for k, v in GLOBAL_DEFAULTS.items())),
        'updated_at': row.updated_at.isoformat() if row and row.updated_at else None,
        'updated_by': (row.updated_by.username if row and row.updated_by else None),
    }


def _number(value, lo, hi, what):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{what} must be a number.')
    if not (lo <= v <= hi):
        raise ValueError(f'{what} must be between {lo:g} and {hi:g}.')
    return round(v, 2)


class CoveragePredictionSettingsView(APIView):
    """`GET /api/v2/coverage-prediction/settings/` (any signed-in user) and
    `PUT` (admin, superadmin). PUT takes `bands` {key: {value: number}} with
    only the values to change, the global values, or `reset: true` for every
    starting value. A band value equal to its default is not stored."""

    def get_permissions(self):
        return [IsAuthenticated()] if self.request.method == 'GET' else [IsAdminOrSuperadmin()]

    def get(self, request):
        return Response(settings_view())

    def put(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        row = CoveragePredictionSettings.load() or CoveragePredictionSettings()
        if data.get('reset'):
            row.bands = {}
            for k, v in GLOBAL_DEFAULTS.items():
                setattr(row, k, v)
        else:
            try:
                bands = dict(row.bands or {})
                for key, vals in (data.get('bands') or {}).items():
                    if key not in BANDS or not isinstance(vals, dict):
                        raise ValueError('Unknown band.')
                    kept = dict(bands.get(key) or {})
                    for k, v in vals.items():
                        if k not in VALUE_KEYS:
                            raise ValueError('Unknown value.')
                        if v is None or v == '':
                            kept.pop(k, None)
                            continue
                        lo, hi = LIMITS[k]
                        num = _number(v, lo, hi, f'{BANDS[key]["label"]}: {k.replace("_", " ")}')
                        if num == BANDS[key][k]:
                            kept.pop(k, None)
                        else:
                            kept[k] = num
                    if kept:
                        bands[key] = kept
                    else:
                        bands.pop(key, None)
                row.bands = bands
                if 'environment' in data:
                    if data['environment'] not in ENVIRONMENTS:
                        raise ValueError('Area type must be urban, suburban or rural.')
                    row.environment = data['environment']
                for k, (lo, hi) in GLOBAL_LIMITS.items():
                    if k in data:
                        setattr(row, k, _number(data[k], lo, hi, k.replace('_', ' ')))
            except ValueError as e:
                return Response({'detail': str(e)}, status=400)
        row.updated_by = request.user
        row.save()
        log_audit_event(request, 'COVERAGE_PREDICTION.UPDATED', resource='coverage_prediction', resource_id='1',
                        detail='reset' if data.get('reset') else
                        f'bands={row.bands} env={row.environment} offset={row.offset_db} '
                        f'height={row.default_height_m} tilt={row.default_tilt_deg} rx={row.rx_height_m}')
        return Response(settings_view(row))
