"""LTE CQI (Channel Quality Indicator) estimation (2026-10-09).

A UE reports CQI 0-15 per 3GPP TS 36.213: the highest index whose
modulation and code rate it could decode at about 10% block error rate.
Android rarely exposes that report, so this module ESTIMATES it from what
a sample does carry. Every result here is an estimate and names the method
that produced it; none is a measurement.

Five methods, one entry point (`compute_cqi`):

  SINR_MAPPING   highest CQI whose SINR threshold is met. The default, and
                 the only one the telemetry pipeline had before this file.
  EESM           several subband SINRs folded into one effective SINR, then
                 SINR_MAPPING. Needs per-subband input, which a phone does
                 not give; available for drive-test logs that do.
  RSRP_RSRQ      linear model on RSRQ. Rougher: RSRQ moves with cell load.
                 Used as the fallback when a sample has no SINR.
  CAPACITY       Shannon capacity per subband, averaged, then quantized.
                 With one SINR value it returns the same index as
                 SINR_MAPPING by construction.
  ML_PREDICTION  interface only. A predictor is plugged in through config;
                 without one the method raises rather than inventing a
                 number.

Everything tunable comes from `config`, layered over `settings.CQI_CONFIG`
(the CQI_CONFIG_JSON env var), layered over DEFAULT_CONFIG. Unset means the
defaults below.

The frontend keeps its own copy of the default SINR thresholds in
frontend-react/src/lib/cqiFromSinr.ts for drive-test files parsed in the
browser. Changing the default here means changing it there too; a
CQI_CONFIG_JSON override does NOT reach that copy.
"""
import math

from django.conf import settings

SINR_MAPPING = 'SINR_MAPPING'
EESM = 'EESM'
RSRP_RSRQ = 'RSRP_RSRQ'
CAPACITY = 'CAPACITY'
ML_PREDICTION = 'ML_PREDICTION'
METHODS = (SINR_MAPPING, EESM, RSRP_RSRQ, CAPACITY, ML_PREDICTION)

# 3GPP TS 36.213 Table 7.2.3-1 (the 64QAM table; the 256QAM table 7.2.3-2
# is not used here). index -> (modulation, code rate x 1024, efficiency).
CQI_TABLE = {
    0: (None, None, None),  # out of range
    1: ('QPSK', 78, 0.1523),
    2: ('QPSK', 120, 0.2344),
    3: ('QPSK', 193, 0.3770),
    4: ('QPSK', 308, 0.6016),
    5: ('QPSK', 449, 0.8770),
    6: ('QPSK', 602, 1.1758),
    7: ('16QAM', 378, 1.4766),
    8: ('16QAM', 490, 1.9141),
    9: ('16QAM', 616, 2.4063),
    10: ('64QAM', 466, 2.7305),
    11: ('64QAM', 567, 3.3223),
    12: ('64QAM', 666, 3.9023),
    13: ('64QAM', 772, 4.5234),
    14: ('64QAM', 873, 5.1152),
    15: ('64QAM', 948, 5.5547),
}

# Lowest SINR (dB) at which CQI 1..15 is usable at ~10% BLER.
# Brueninghaus et al., "Link Performance Models for System Level
# Simulations of Broadband Radio Access Systems", IEEE PIMRC 2005 -- the
# table ns-3's LTE module uses, and what this app has used since
# 2026-09-29. Kept as the default so stored cqi_derived values do not shift.
SINR_THRESHOLDS_BRUENINGHAUS_DB = [
    -6.7, -4.7, -2.3, 0.2, 2.4, 4.3, 5.9, 8.1, 10.3, 11.7, 14.1, 16.3, 18.7, 21.0, 22.7,
]
# The round 2 dB ladder often quoted for LTE (CQI 1 at -6 dB ... CQI 15 at
# 22 dB). Not the default; select it with
# CQI_CONFIG_JSON='{"sinr_thresholds_db": "2DB_LADDER"}' or pass the list.
SINR_THRESHOLDS_2DB_LADDER = [float(v) for v in range(-6, 24, 2)]
_NAMED_THRESHOLDS = {
    'BRUENINGHAUS': SINR_THRESHOLDS_BRUENINGHAUS_DB,
    '2DB_LADDER': SINR_THRESHOLDS_2DB_LADDER,
}

DEFAULT_CONFIG = {
    # 15 ascending values (or one of the names above): min SINR for CQI 1..15.
    'sinr_thresholds_db': SINR_THRESHOLDS_BRUENINGHAUS_DB,
    # EESM calibration factor, linear. Really depends on the MCS; one value
    # is a simplification.
    'eesm_beta': 2.0,
    # How SINR_MAPPING folds a list of subband SINRs: 'eesm' or 'mean'
    # (plain average of the dB values).
    'subband_combine': 'eesm',
    # CQI = a * RSRQ + b, clamped to 0..15. Defaults give RSRQ -10 dB ->
    # CQI 7, -3 dB -> 14, -17 dB or worse -> 0.
    'rsrq_slope': 1.0,
    'rsrq_intercept': 17.0,
    # 15 ascending capacity thresholds (bps/Hz) for CQI 1..15. None derives
    # them from sinr_thresholds_db as log2(1 + SINR).
    'capacity_thresholds': None,
    # 'mean' or 'sum' across subbands/streams.
    'capacity_combine': 'mean',
    # ML_PREDICTION: a callable(cqi_history, sinr_history) -> number, and
    # how many past values it wants.
    'ml_predictor': None,
    'ml_history_length': 10,
}


class CqiError(ValueError):
    """Bad input or config for a CQI calculation."""


def resolve_config(config=None):
    """DEFAULT_CONFIG, then settings.CQI_CONFIG, then the caller's `config`."""
    merged = dict(DEFAULT_CONFIG)
    merged.update(getattr(settings, 'CQI_CONFIG', None) or {})
    merged.update(config or {})
    thresholds = merged['sinr_thresholds_db']
    if isinstance(thresholds, str):
        try:
            thresholds = _NAMED_THRESHOLDS[thresholds.upper()]
        except KeyError:
            raise CqiError(f'unknown sinr_thresholds_db name {thresholds!r}')
    merged['sinr_thresholds_db'] = _check_thresholds(thresholds, 'sinr_thresholds_db')
    if merged['capacity_thresholds'] is not None:
        merged['capacity_thresholds'] = _check_thresholds(merged['capacity_thresholds'], 'capacity_thresholds')
    if not merged['eesm_beta'] or merged['eesm_beta'] <= 0:
        raise CqiError('eesm_beta must be greater than 0')
    return merged


def _check_thresholds(values, name):
    try:
        values = [float(v) for v in values]
    except (TypeError, ValueError):
        raise CqiError(f'{name} must be a list of 15 numbers')
    if len(values) != 15 or any(b <= a for a, b in zip(values, values[1:])):
        raise CqiError(f'{name} must be 15 strictly ascending numbers (CQI 1..15)')
    return values


def _as_list(sinr_db):
    if sinr_db is None:
        raise CqiError('sinr_dB is required for this method')
    values = list(sinr_db) if isinstance(sinr_db, (list, tuple)) else [sinr_db]
    values = [float(v) for v in values if v is not None]
    if not values or any(math.isnan(v) for v in values):
        raise CqiError('sinr_dB has no usable value')
    return values


def _quantize(value, thresholds):
    """Highest CQI whose threshold is <= value; 0 below the first one."""
    cqi = 0
    for index, minimum in enumerate(thresholds, start=1):
        if value >= minimum:
            cqi = index
        else:
            break
    return cqi


def _clamp(value):
    return max(0, min(15, int(round(value))))


def table_entry(cqi_index):
    """3GPP table fields for a CQI index, as the dict `compute_cqi` returns."""
    modulation, rate_x1024, efficiency = CQI_TABLE[cqi_index]
    return {
        'cqi_index': cqi_index,
        'modulation': modulation,
        'code_rate_x1024': rate_x1024,
        'code_rate': round(rate_x1024 / 1024, 4) if rate_x1024 is not None else None,
        'spectral_efficiency': efficiency,
    }


def eesm_effective_sinr_db(sinr_db_values, beta):
    """Exponential Effective SINR Mapping.

    SINR_eff = -beta * ln( mean( exp(-SINR_i / beta) ) ), with SINR_i and
    beta in LINEAR units. The dB inputs are converted first and the result
    converted back: applying the formula to dB values directly is a common
    mistake and gives a different number.
    """
    linear = [10 ** (v / 10) for v in sinr_db_values]
    mean_exp = sum(math.exp(-v / beta) for v in linear) / len(linear)
    if mean_exp <= 0:  # every exp() underflowed: all subbands are very strong
        return min(sinr_db_values)
    effective = -beta * math.log(mean_exp)
    return 10 * math.log10(effective) if effective > 0 else float('-inf')


def capacity_bps_hz(sinr_db):
    """Shannon capacity of one stream: log2(1 + SINR)."""
    return math.log2(1 + 10 ** (sinr_db / 10))


def _by_sinr(values, cfg):
    if len(values) == 1:
        effective = values[0]
    elif cfg['subband_combine'] == 'mean':
        effective = sum(values) / len(values)
    else:
        effective = eesm_effective_sinr_db(values, cfg['eesm_beta'])
    return _quantize(effective, cfg['sinr_thresholds_db']), effective


def compute_cqi(sinr_db=None, rsrp_dbm=None, rsrq_db=None, method=SINR_MAPPING, config=None,
                cqi_history=None, sinr_history=None):
    """Estimate CQI. Returns a dict:

        cqi_index            0-15 (0 = out of range)
        modulation           'QPSK' / '16QAM' / '64QAM', None for CQI 0
        code_rate_x1024      3GPP integer, None for CQI 0
        code_rate            code_rate_x1024 / 1024
        spectral_efficiency  bps/Hz
        method_used          one of METHODS
        effective_sinr_db    the SINR the index was read from, where one exists

    `sinr_db` is one number or a list of subband values. `rsrp_dbm` is
    accepted for the RSRP_RSRQ method's signature but the default model
    uses RSRQ only: RSRP is signal strength, not quality.
    Raises CqiError when the method's inputs are missing.
    """
    if method not in METHODS:
        raise CqiError(f'unknown method {method!r}')
    cfg = resolve_config(config)
    effective = None

    if method == SINR_MAPPING:
        cqi, effective = _by_sinr(_as_list(sinr_db), cfg)
    elif method == EESM:
        values = _as_list(sinr_db)
        effective = eesm_effective_sinr_db(values, cfg['eesm_beta']) if len(values) > 1 else values[0]
        cqi = _quantize(effective, cfg['sinr_thresholds_db'])
    elif method == RSRP_RSRQ:
        if rsrq_db is None:
            raise CqiError('rsrq_dB is required for RSRP_RSRQ')
        cqi = _clamp(cfg['rsrq_slope'] * float(rsrq_db) + cfg['rsrq_intercept'])
    elif method == CAPACITY:
        capacities = [capacity_bps_hz(v) for v in _as_list(sinr_db)]
        capacity = sum(capacities) if cfg['capacity_combine'] == 'sum' else sum(capacities) / len(capacities)
        thresholds = cfg['capacity_thresholds'] or [capacity_bps_hz(t) for t in cfg['sinr_thresholds_db']]
        # 1e-9: a capacity computed from a SINR sitting exactly on a
        # threshold must not fall one step short through float rounding.
        cqi = _quantize(capacity + 1e-9, thresholds)
    else:  # ML_PREDICTION
        predictor = cfg['ml_predictor']
        if predictor is None:
            raise CqiError('ML_PREDICTION needs config["ml_predictor"]; no model is built in')
        n = cfg['ml_history_length']
        cqi = _clamp(predictor(list(cqi_history or [])[-n:], list(sinr_history or [])[-n:]))

    result = table_entry(cqi)
    result['method_used'] = method
    result['effective_sinr_db'] = round(effective, 2) if effective is not None and math.isfinite(effective) else None
    return result


def cqi_from_sinr(sinr_db):
    """CQI index for one SINR in dB, None when SINR is unknown. The
    function core/telemetry.py has always exposed, now backed by this
    module (and so by CQI_CONFIG)."""
    if sinr_db is None:
        return None
    return compute_cqi(sinr_db=sinr_db)['cqi_index']


# What the UI calls each source of a CQI value.
SOURCE_REPORTED = 'reported'   # the device's own CQI
SOURCE_SINR = 'sinr'           # estimated from SINR
SOURCE_RSRQ = 'rsrq'           # estimated from RSRQ, the rougher fallback


def sample_cqi_fields(reported_cqi, sinr_db, rsrq_db, network_type):
    """CQI display fields for one telemetry sample, worked out at read time.

    Order of preference: the device's own report, then SINR, then RSRQ.
    Estimates are LTE only; the 3GPP table and both models are LTE's.
    Returns keys cqi_value, cqi_source, modulation, code_rate_x1024,
    spectral_efficiency -- all None when nothing can be said.
    """
    value = source = None
    if reported_cqi is not None and 0 <= reported_cqi <= 15:
        value, source = int(reported_cqi), SOURCE_REPORTED
    elif network_type == 'LTE':
        if sinr_db is not None:
            value, source = compute_cqi(sinr_db=sinr_db)['cqi_index'], SOURCE_SINR
        elif rsrq_db is not None:
            value, source = compute_cqi(rsrq_db=rsrq_db, method=RSRP_RSRQ)['cqi_index'], SOURCE_RSRQ
    if value is None or network_type != 'LTE':
        # A reported CQI on NR is shown as is: NR has its own CQI tables
        # (TS 38.214), so the LTE modulation and efficiency do not apply.
        return {'cqi_value': value, 'cqi_source': source, 'modulation': None,
                'code_rate_x1024': None, 'spectral_efficiency': None}
    entry = table_entry(value)
    return {
        'cqi_value': value, 'cqi_source': source, 'modulation': entry['modulation'],
        'code_rate_x1024': entry['code_rate_x1024'], 'spectral_efficiency': entry['spectral_efficiency'],
    }
