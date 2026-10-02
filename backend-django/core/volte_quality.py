"""Crowdsourced VoLTE/VoNR call-quality ingest (2026-10-02).

Separate feature from `core/telemetry.py`'s periodic RF-sample pipeline --
different cadence (one row per completed call, not a 15-minute/handover
tick), different fields (RTP-level call metrics, not radio signal
strength). Reuses that module's `_resolve_key`/`_key_from_request`/
`hash_device_id` directly rather than duplicating the ingest-key check,
same pattern `core/consent.py`'s `DriveTestConsentView` and
`core/rescue.py`'s `RescueEnrollView` already use for their own sibling
endpoints.

**This only ever receives real data once the mobile app has carrier-
privileged status.** Reading the underlying Android `CallQuality` API
(`TelephonyCallback.CallAttributesListener`, API 29+) requires
`READ_PRECISE_PHONE_STATE`, a privileged/signature permission gated
behind a SIM/carrier-config certificate relationship only the carrier
itself (NTC) can grant -- a real external prerequisite outside this
codebase's control, same category as the GeoIP MaxMind license key or
the NTC SMS gateway details elsewhere in this app. This endpoint, model,
and MOS estimator are built and ready now so there's nothing left to
build once that certification lands; see
`docs/telemetry_pipeline_mobile_handoff.md`'s VoLTE addendum for the
client-side contract this expects.

**The MOS this produces is an ITU-T G.107 E-model ESTIMATE from network
metrics, never a true perceptually-measured MOS** (real PESQ/POLQA-grade
MOS needs waveform-level audio analysis no app can access) -- every UI
surface must label it "Estimated MOS", never a bare "MOS".

Codec impairment constants (`_CODEC_IMPAIRMENT`) are sourced from the
official ITU-T G.113 (09/2024) tables, supplied 2026-10-02 -- AMR-WB
(what VoLTE actually uses) is now covered. Two things this required
getting right, not just copying numbers in:

1. **AMR-WB's Ie,wb lives on the WIDEBAND E-model scale (ITU-T G.107.1),
   not the narrowband G.107 scale G.711/G.729 use.** The two models have
   different R0 baselines (93.2 vs 129) and different R-to-MOS
   conversions (wideband rescales R/1.29 before applying the same
   polynomial) -- plugging a wideband Ie straight into the narrowband
   formula would silently produce a wrong number. `compute_mos_estimate()`
   branches on each codec's `scale` ('NB' or 'WB') rather than assuming
   one formula fits both. The wideband effective-impairment ceiling was
   independently verified (web search, 2026-10-02) to still be 95, same
   as narrowband -- not rescaled to the wideband 129 ceiling, which is
   the most common place this would go wrong by inference instead of
   verification.
2. **The G.113 (09/2024) table publishes no `Bpl` (packet-loss robustness)
   for any narrowband codec at all, including G.711 and G.729** --
   contradicting `Bpl=25.1`/`Bpl=19` values this module briefly used,
   pulled from secondary (non-ITU) sources before the real table was
   available. Those are now removed: a codec with no published `Bpl`
   can only produce an estimate at zero reported packet loss (see
   `compute_mos_estimate()`'s docstring) rather than guess a robustness
   factor that was never actually published for it.

AMR-WB's `Ie,wb` varies by negotiated bitrate (6.60-23.85 kbit/s, 9
published values) and Android's `CallQuality` API reports only a codec
TYPE, not the negotiated bitrate -- so `_CODEC_IMPAIRMENT['AMR-WB']` uses
the 12.65 kbit/s value specifically (the standard/default VoLTE rate,
and one of only three AMR-WB rates with a published `Bpl,wb` at all),
documented as a representative-rate approximation, not a per-call exact
match.

**Provisional entries (2026-10-02, explicit user decision: ship an
approximate number now rather than block on a fully-verified source,
correct it later) -- each stored row carries `mos_is_provisional` so
nothing downstream conflates these with the verified entries above:**

- **EVS** -- real ITU-T G.113 (09/2024) Appendix V constants
  (`Ie,fb`/`Bpl,fb` for EVS SWB), but its own fullband E-model formula
  (R0/ceiling/R-to-MOS conversion) has not been verified -- applied
  through the WIDEBAND (G.107.1) formula instead, as the closest verified
  model to a super-wideband codec. Uses the 24.4 kbit/s mode (the best
  `Ie,fb` among EVS SWB's published rates, and a commonly-deployed
  default). Expect this estimate to shift once the real fullband formula
  is confirmed and wired in -- the constants are right, the formula
  applying them is a stand-in.
- **AMR-NB** -- no ITU-T source found for AMR-NB's own Ie/Bpl at all.
  Proxied via **GSM-EFR**'s verified narrowband Ie (5.0) instead of a
  blind guess: AMR-NB's highest-quality mode (12.2 kbit/s) is
  algorithmically derived from GSM-EFR, making it a defensible stand-in,
  not an arbitrary one -- but still AMR-NB's real, published Ie if one is
  ever found, not GSM-EFR's.

Both remain clearly inferior to a verified entry -- replace either the
moment a real, citable source is found, same bar every other entry here
is held to.
"""
from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import VolteCallSample
from .telemetry import MAX_SAMPLES_PER_REQUEST, _f, _int, _key_from_request, _resolve_key, _scope_by_operator, hash_device_id
from .views import IsSuperadminOnly

_NET_TYPES = {'LTE', 'NR', 'UNKNOWN'}

# Codec impairment constants. Each entry: `scale` ('NB' narrowband / 'WB'
# wideband -- see module docstring for why that distinction is load-
# bearing, not cosmetic), `ie` (equipment impairment at zero packet loss),
# `bpl` (packet-loss robustness factor, `None` where none is published --
# see `compute_mos_estimate()` for what that means for a lossy call), and
# `provisional` (True when the entry is a deliberate approximation -- a
# real codec's constants run through a DIFFERENT scale's formula, or a
# different codec's constants used as a proxy -- rather than a verified
# match; see module docstring for exactly what's approximated and why).
# Add a non-provisional entry here ONLY once its values are confirmed
# against an actual ITU-T G.113 appendix table (or an equivalently
# authoritative, citable source) for the SPECIFIC scale it belongs to --
# cite the source/appendix in this comment when you do.
_CODEC_IMPAIRMENT = {
    # G.113 Appendix I (narrowband). No Bpl published for either --
    # packet-loss-aware estimation unavailable for both (see docstring).
    'G.711': {'scale': 'NB', 'ie': 0.0, 'bpl': None, 'provisional': False},
    'G.729': {'scale': 'NB', 'ie': 10.0, 'bpl': None, 'provisional': False},
    # G.113 Appendix IV (wideband) -- values for the 12.65 kbit/s mode
    # specifically (the standard/default VoLTE rate, and one of only 3 of
    # AMR-WB's 9 published bitrates with a Bpl,wb value at all). See
    # module docstring for why one representative bitrate is used rather
    # than per-call bitrate matching.
    'AMR-WB': {'scale': 'WB', 'ie': 13.0, 'bpl': 4.3, 'provisional': False},
    # PROVISIONAL -- see module docstring. Real G.113 Appendix V fullband
    # constants (EVS SWB, 24.4 kbit/s mode), run through the wideband
    # formula as a stand-in for the unverified fullband one.
    'EVS': {'scale': 'WB', 'ie': 7.2, 'bpl': 11.4, 'provisional': True},
    # PROVISIONAL -- see module docstring. No AMR-NB source found; proxied
    # via GSM-EFR's verified narrowband Ie (AMR-NB's 12.2 kbit/s mode is
    # algorithmically derived from GSM-EFR).
    'AMR-NB': {'scale': 'NB', 'ie': 5.0, 'bpl': None, 'provisional': True},
}

# E-model default ratings with zero other impairments. Narrowband: ITU-T
# G.107's R0≈93.2. Wideband: ITU-T G.107.1's R0,wb=129 -- confirmed
# against a published open-source G.107.1 implementation, 2026-10-02 (a
# genuinely different baseline, not the narrowband value reused -- see
# module docstring).
_R0_NB = 93.2
_R0_WB = 129.0
# Wideband-to-narrowband-scale rescaling applied before the R-to-MOS
# polynomial (ITU-T G.107.1 Annex A, eq. A-1) -- confirmed against the
# same reference implementation.
_WB_RESCALE = 1.29


def _mos_from_r(r):
    """The ITU-T G.107 R-to-MOS polynomial (Annex B) -- shared by both
    scales. For wideband, the caller passes `r / _WB_RESCALE`, not the raw
    wideband R, per G.107.1 Annex A."""
    if r <= 0:
        return 1.0
    if r >= 100:
        return 4.5
    return 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6


def _ie_effective(ie, bpl, ppl):
    """Packet-loss-adjusted effective impairment. The ceiling constant 95
    is shared by both the narrowband formula and the wideband one (ITU-T
    G.107.1) -- confirmed via web search, 2026-10-02, specifically because
    "scale the ceiling to the wideband range too" is the most natural-
    looking WRONG inference here, not a verified one.

    Returns `None` when there IS reported packet loss but this codec has
    no published `bpl` to account for it with -- fabricating a robustness
    factor that was never published would be exactly the kind of guess
    this module exists to avoid. A codec with no `bpl` can still produce
    an estimate when `ppl` is exactly 0 (no loss to account for)."""
    if bpl is None:
        return ie if not ppl else None
    if ppl <= 0:
        return ie
    return ie + (95.0 - ie) * (ppl / (ppl + bpl))


def compute_mos_estimate(packet_loss_pct, jitter_ms, rtt_ms, codec):
    """Returns `(r_factor, mos_estimate, is_provisional)` -- or
    `(None, None, False)` when `packet_loss_pct`/`rtt_ms` is missing,
    `codec` has no entry in `_CODEC_IMPAIRMENT` at all, or there's
    reported packet loss but no published `Bpl` to account for it with
    (see `_ie_effective()`). Never fabricates a value for a codec with NO
    entry -- `is_provisional=True` instead marks a value that WAS computed
    but from an approximated entry (see module docstring for exactly
    which codecs and why); callers must surface that distinction, not
    collapse it into a plain number indistinguishable from a verified one.
    `r_factor` is always on the 0-100 narrowband-equivalent scale
    regardless of the codec's own scale, so it is directly comparable
    across rows in the UI/API.

    The delay-impairment term (`Id`) uses the standard simplified
    single-term approximation widely reproduced in VoIP-quality-monitoring
    literature and tooling (shared across both scales -- delay impairment
    is a conversational-dynamics effect, not codec-bandwidth-specific, so
    reusing one approximation here is a smaller, clearly-labeled
    simplification than guessing a codec's own impairment constants would
    be): negligible below ITU-T G.114's ~177.3ms "no perceptible effect"
    threshold, a steeper linear penalty beyond it. One-way delay itself is
    approximated as `rtt_ms/2 + jitter_ms/2`, since only RTT and jitter --
    not a true one-way delay measurement -- are available from Android's
    `CallQuality` API.
    """
    if packet_loss_pct is None or rtt_ms is None:
        return None, None, False
    impairment = _CODEC_IMPAIRMENT.get((codec or '').strip().upper())
    if impairment is None:
        return None, None, False

    ppl = max(0.0, min(100.0, packet_loss_pct))
    ie_eff = _ie_effective(impairment['ie'], impairment['bpl'], ppl)
    if ie_eff is None:
        return None, None, False

    one_way_delay_ms = (rtt_ms / 2.0) + (jitter_ms or 0.0) / 2.0
    if one_way_delay_ms <= 177.3:
        id_ = 0.024 * one_way_delay_ms
    else:
        id_ = 0.024 * one_way_delay_ms + 0.11 * (one_way_delay_ms - 177.3)

    if impairment['scale'] == 'WB':
        r_wb = max(0.0, min(_R0_WB, _R0_WB - id_ - ie_eff))
        mos = _mos_from_r(r_wb / _WB_RESCALE)
        # Reported on the narrowband-equivalent 0-100 scale for
        # cross-codec comparability -- see this function's own docstring.
        r = r_wb / _WB_RESCALE
    else:
        r = max(0.0, min(100.0, _R0_NB - id_ - ie_eff))
        mos = _mos_from_r(r)

    return round(r, 2), round(mos, 2), impairment['provisional']


def _coerce_volte_sample(raw, received_at):
    """One ingest JSON object -> a dict of VolteCallSample column values.
    Requires `device_id` and `ts`; everything else degrades to `None`
    rather than rejecting the whole batch over one bad optional field --
    same posture as core/telemetry.py's coerce_sample()."""
    if not isinstance(raw, dict):
        raise serializers.ValidationError('each sample must be a JSON object')
    raw_device_id = str(raw.get('device_id') or '').strip()
    if not raw_device_id:
        raise serializers.ValidationError('sample missing device_id')
    ts_ms = raw.get('ts')
    try:
        from datetime import datetime, timezone as dt_timezone
        ts = datetime.fromtimestamp(float(ts_ms) / 1000.0, tz=dt_timezone.utc)
    except (TypeError, ValueError):
        raise serializers.ValidationError('sample missing or invalid ts (epoch ms)')

    codec = str(raw.get('codec') or '').strip()
    packet_loss_pct = _f(raw.get('packet_loss_pct'))
    jitter_ms = _f(raw.get('jitter_ms'))
    rtt_ms = _f(raw.get('rtt_ms'))
    r_factor, mos_estimate, mos_is_provisional = compute_mos_estimate(packet_loss_pct, jitter_ms, rtt_ms, codec)

    nt = str(raw.get('network_type') or 'UNKNOWN').upper()
    return {
        'device_id': hash_device_id(raw_device_id),
        'ts': ts,
        'received_at': received_at,
        'lat': _f(raw.get('lat')),
        'lng': _f(raw.get('lon')),
        'cell_id': _int(raw.get('cell_id')),
        'pci': _int(raw.get('pci')),
        'tac': _int(raw.get('tac')),
        'mcc': (str(raw.get('mcc') or ''))[:6],
        'mnc': (str(raw.get('mnc') or ''))[:6],
        'network_type': nt if nt in _NET_TYPES else 'UNKNOWN',
        'call_duration_s': _int(raw.get('call_duration_s')),
        'codec': codec[:20],
        'packet_loss_pct': packet_loss_pct,
        'jitter_ms': jitter_ms,
        'rtt_ms': rtt_ms,
        'quality_level': str(raw.get('quality_level') or '')[:20],
        'r_factor': r_factor,
        'mos_estimate': mos_estimate,
        'mos_is_provisional': mos_is_provisional,
    }


class VolteSampleIngestView(APIView):
    """`POST /api/telemetry/v1/volte-samples/` -- a JSON array of VoLTE/
    VoNR call-quality readings. Same `Authorization: Bearer <tel_key>` (or
    `X-API-Key`) auth as `TelemetryIngestView` -- see module docstring for
    the client-side contract and why this is dormant until the app has
    carrier-privileged status.

    Responses: `202 {"accepted": N}` on success, `400` on a malformed
    body, `401` on an invalid/missing key, `413` over the batch limit --
    same shape as `TelemetryIngestView`, no idempotency/dedup layer (call
    volume is naturally far lower than periodic RF-sample volume, and a
    duplicate call-quality row is harmless -- unlike a duplicated RF
    sample batch, it won't skew a coverage aggregate meaningfully)."""
    authentication_classes = []
    permission_classes = [AllowAny]  # this endpoint does its own key check

    def post(self, request):
        key = _resolve_key(_key_from_request(request))
        if key is None:
            return Response({'detail': 'invalid or missing telemetry ingest key'},
                            status=status.HTTP_401_UNAUTHORIZED)

        payload = request.data
        if not isinstance(payload, list):
            return Response({'detail': 'body must be a JSON array of samples'},
                             status=status.HTTP_400_BAD_REQUEST)
        if not payload:
            return Response({'accepted': 0}, status=status.HTTP_202_ACCEPTED)
        if len(payload) > MAX_SAMPLES_PER_REQUEST:
            return Response({'detail': f'max {MAX_SAMPLES_PER_REQUEST} samples per request'},
                             status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        now = timezone.now()
        try:
            rows = [_coerce_volte_sample(s, now) for s in payload]
        except serializers.ValidationError as e:
            return Response({'detail': e.detail}, status=status.HTTP_400_BAD_REQUEST)

        # Plain per-row .save() (not bulk_create()) -- deliberately, so the
        # model's own save() override computes `location` from lat/lng for
        # each row; bulk_create() bypasses save() entirely and would leave
        # `location` always null. Call volume here is naturally far lower
        # than periodic RF-sample volume (see this view's docstring), so
        # the per-row insert cost is irrelevant at any realistic scale --
        # unlike TelemetrySample's COPY-based bulk_insert_samples().
        for r in rows:
            VolteCallSample(**r).save()
        return Response({'accepted': len(rows)}, status=status.HTTP_202_ACCEPTED)


_MAX_LIST_MINUTES = 24 * 60
_DEFAULT_LIST_LIMIT = 200
_MAX_LIST_LIMIT = 500


class VolteQualityListView(APIView):
    """`GET /api/v2/telemetry/volte-samples/` -- raw, ungrouped, most-recent
    `VolteCallSample` rows. Same superadmin-only/time-bounded/row-capped
    posture as `telemetry_admin.py`'s `TelemetryLiveSamplesView` and for
    the identical reason: this exposes individual device_id + optional
    per-call location, the per-subscriber-shaped view this app's telemetry
    design otherwise deliberately avoids (see that view's own docstring).
    No MenuItem/nav entry for the same reason -- a dev/pilot verification
    tool, not a production feature, until real carrier-privileged traffic
    exists to look at."""
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        try:
            minutes = int(request.query_params.get('minutes', 60))
        except (TypeError, ValueError):
            minutes = 60
        minutes = max(1, min(_MAX_LIST_MINUTES, minutes))
        try:
            limit = int(request.query_params.get('limit', _DEFAULT_LIST_LIMIT))
        except (TypeError, ValueError):
            limit = _DEFAULT_LIST_LIMIT
        limit = max(1, min(_MAX_LIST_LIMIT, limit))

        window_start = timezone.now() - timedelta(minutes=minutes)
        qs = _scope_by_operator(
            VolteCallSample.objects.filter(received_at__gte=window_start).order_by('-received_at'),
            request.user,
        )
        rows = list(qs[:limit])
        return Response({
            'samples': [
                {
                    'device_id': r.device_id,
                    'ts': r.ts,
                    'received_at': r.received_at,
                    'network_type': r.network_type,
                    'codec': r.codec,
                    'call_duration_s': r.call_duration_s,
                    'packet_loss_pct': r.packet_loss_pct,
                    'jitter_ms': r.jitter_ms,
                    'rtt_ms': r.rtt_ms,
                    'quality_level': r.quality_level,
                    'r_factor': r.r_factor,
                    'mos_estimate': r.mos_estimate,
                    'mos_is_provisional': r.mos_is_provisional,
                }
                for r in rows
            ],
        })
