"""
Rescue-location beacon — the backend half of samples/
nepal_flood_location_beacon_proposal.docx's Phase 1 opt-in beacon.
Deliberately its own module, same "one file per feature" convention as
telemetry.py/telemetry_admin.py/drive_test.py, because this is a THIRD
lane with its own governance rules, not an extension of the anonymous
crowdsourced telemetry pipeline those two files own.

Two endpoints, two very different trust boundaries:

  * RescueEnrollView  — `POST /api/telemetry/v1/rescue-enroll/`, mounted
    alongside TelemetryIngestView (core/telemetry_urls.py) and
    authenticated the SAME way (a TelemetryIngestKey) because it is
    called BY THE DEVICE, at the moment a subscriber opts in from the
    app's own UI. Accepts the SDK's raw (unhashed) device_id — the only
    place in this whole pipeline that a raw id and a phone number are
    ever seen together, and only because the device itself sent both.

  * RescueLookupView  — `GET /api/v2/rescue/lookup/`, a normal JWT
    `/api/v2/` admin resource like everything in telemetry_admin.py, but
    gated by IsRescueOperator (core/views.py) rather than
    IsAdminOrSuperadmin/IsSuperadminOnly, and the only read path onto
    SubscriberLastLocation anywhere in the codebase. Every call is logged
    to RescueLocationAccessLog whether or not it finds anything — the
    proposal's "never open lookup by phone number" is enforced by making
    every lookup identity- and case-bound and permanently auditable, not
    by policy alone.

Consent lives entirely in SubscriberLastLocation.rescue_consent under the
default 'mandatory' RescueConsentPolicy — there is no separate "pending"
state, and withdrawing consent (RescueEnrollView with consent=false)
deletes the row outright, matching the proposal's "opt-in... with a
one-tap way to disable it": disabling doesn't just stop future updates,
it removes what's already stored.

A THIRD endpoint, added 2026-09-02 for the disaster-response scenario the
proposal anticipated but the strict version above doesn't fit: a real
carrier/government app integration has no in-app consent screen at all
(the subscriber controls collection via OS-level app permission, not a
tap in this SDK), so during an actual emergency there may be no
deliberate "I consent" moment to point to.

  * RescueConsentPolicyView — `GET/POST /api/v2/rescue/policy/`,
    superadmin-only (a materially bigger blast radius than one lookup, so
    a tier above IsRescueOperator). Lets a superadmin declare a
    time-boxed 'optional' override that relaxes the `rescue_consent`
    check on the two paths above to "has a known msisdn on file" instead
    — see RescueConsentPolicy's docstring (core/models.py) for exactly
    what it does and does not unlock, and RescueConsentPolicyChangeLog
    for its own audit trail.
"""
import re

from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    RescueConsentPolicy,
    RescueConsentPolicyChangeLog,
    RescueLocationAccessLog,
    SubscriberLastLocation,
)
from .telemetry import _key_from_request, _resolve_key, _scope_by_operator, hash_device_id
from .views import IsRescueOperator, IsSuperadminOnly

# Loose sanity check, not a strict E.164 validator — this app has no
# control over what format a subscriber's own phone app hands it, and
# rejecting a real number over formatting would be worse than storing it
# a little loosely. Digits, spaces, +, - only; 7-20 chars covers every
# real-world MSISDN length with room either side.
_MSISDN_RE = re.compile(r'^[+\d][\d\s-]{6,19}$')


def _clean_msisdn(raw):
    v = (raw or '').strip()
    return v if _MSISDN_RE.match(v) else None


class RescueEnrollView(APIView):
    """`POST /api/telemetry/v1/rescue-enroll/` — body:
    `{"device_id": "<raw sdk device id>", "consent": true, "msisdn": "+977..."}`

    `consent: true` requires a valid `msisdn` and upserts a
    SubscriberLastLocation row (creating it with no position yet if this
    device has never sent a regular telemetry sample). `consent: false`
    normally deletes any existing row for this device outright — see this
    module's docstring on why withdrawal means "erase," not "pause" —
    UNLESS a superadmin has RescueConsentPolicy set to 'optional' (a
    declared emergency), in which case it's a SOFT withdrawal instead:
    `rescue_consent` is set False but the msisdn/location stay on file,
    since erasing it during the very emergency this override exists for
    would defeat the point. Withdrawing again once the policy reverts to
    'mandatory' erases it as normal.

    Same key mechanism as TelemetryIngestView (Authorization: Bearer
    <tel_key> or X-API-Key) — this is the device enrolling itself, not an
    admin action, so it belongs on the ingest-key surface, not `/api/v2/`.
    """
    authentication_classes = []
    permission_classes = [AllowAny]  # does its own key check, same as TelemetryIngestView

    def post(self, request):
        key = _resolve_key(_key_from_request(request))
        if key is None:
            return Response({'detail': 'invalid or missing telemetry ingest key'},
                            status=status.HTTP_401_UNAUTHORIZED)

        raw_device_id = str(request.data.get('device_id') or '').strip()
        if not raw_device_id:
            return Response({'detail': 'device_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        device_id = hash_device_id(raw_device_id)
        consent = bool(request.data.get('consent'))

        if not consent:
            policy = RescueConsentPolicy.objects.filter(pk=1).first()
            if policy and policy.is_optional_active():
                updated = SubscriberLastLocation.objects.filter(device_id=device_id).update(
                    rescue_consent=False,
                )
                return Response({'enrolled': False, 'removed': False, 'soft_withdrawn': updated > 0})
            deleted, _ = SubscriberLastLocation.objects.filter(device_id=device_id).delete()
            return Response({'enrolled': False, 'removed': deleted > 0})

        msisdn = _clean_msisdn(request.data.get('msisdn'))
        if not msisdn:
            return Response({'detail': 'a valid msisdn is required to enroll'},
                            status=status.HTTP_400_BAD_REQUEST)

        obj, _created = SubscriberLastLocation.objects.get_or_create(device_id=device_id)
        obj.msisdn = msisdn
        obj.rescue_consent = True
        obj.rescue_consent_at = timezone.now()
        obj.save(update_fields=['msisdn', 'rescue_consent', 'rescue_consent_at', 'updated_at'])
        return Response({'enrolled': True})


class RescueLookupView(APIView):
    """`GET /api/v2/rescue/lookup/?msisdn=<number>&case_reference=<ref>`

    Both params are required — there is no browse/list mode, matching the
    proposal's "never open lookup by phone number" (a lookup is always
    for one specific number, never a scan). `case_reference` is free text
    (an incident/ticket id from whatever system NDRRMA/Police use) — not
    validated against anything here, because this app has no case-
    management system of its own to validate it against; it exists so
    RescueLocationAccessLog is never just "someone looked this number up"
    but "someone looked this number up, for this stated reason."

    Every call is logged before responding, success or not — see
    _log() below.

    Also scoped by the requesting user's `operator_mncs`
    (core/telemetry.py's `_scope_by_operator`) — a rescue operator account
    restricted to one telecom's own MNC(s) can only ever find that
    operator's subscribers; an NTA/government-style account with an empty
    `operator_mncs` can find anyone, per the "used by NTA or government ->
    any operator" requirement. A found-but-out-of-scope match is reported
    exactly like no match at all (`{"found": false}`) — this endpoint
    never reveals that a number exists on a different operator's network.

    Also honors RescueConsentPolicy (2026-09-02): under the default
    'mandatory' mode, only `rescue_consent=True` rows can ever match —
    under a superadmin-declared 'optional' emergency, any row with a
    known msisdn matches regardless of its consent flag (see that
    model's docstring). Every logged lookup records which mode was in
    effect (`policy_mode` on RescueLocationAccessLog), so an emergency
    override is never invisible in the audit trail.
    """
    permission_classes = [IsAuthenticated, IsRescueOperator]

    def _log(self, request, msisdn, case_reference, found, policy_mode):
        RescueLocationAccessLog.objects.create(
            looked_up_by=request.user,
            msisdn_queried=msisdn,
            case_reference=case_reference,
            found=found,
            policy_mode=policy_mode,
        )

    def get(self, request):
        msisdn = _clean_msisdn(request.query_params.get('msisdn'))
        case_reference = (request.query_params.get('case_reference') or '').strip()
        if not msisdn or not case_reference:
            return Response(
                {'detail': 'msisdn and case_reference are both required'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        policy = RescueConsentPolicy.objects.filter(pk=1).first()
        optional_active = bool(policy and policy.is_optional_active())
        base_qs = SubscriberLastLocation.objects.filter(msisdn=msisdn)
        base_qs = base_qs if optional_active else base_qs.filter(rescue_consent=True)

        match = (
            _scope_by_operator(base_qs, request.user, field='last_mnc')
            .order_by('-last_seen_ts')
            .first()
        )
        found = bool(match and match.last_seen_ts is not None)
        policy_mode = RescueConsentPolicy.MODE_OPTIONAL if optional_active else RescueConsentPolicy.MODE_MANDATORY
        self._log(request, msisdn, case_reference, found, policy_mode)

        if not found:
            return Response({'found': False})

        return Response({
            'found': True,
            'lat': match.last_lat,
            'lng': match.last_lng,
            'accuracy_m': match.last_accuracy_m,
            'source': match.last_source,
            'last_seen_ts': match.last_seen_ts,
        })


class RescueBulkLookupView(APIView):
    """`POST /api/v2/rescue/lookup/bulk/` -- body:
    `{"msisdns": ["+977...", ...], "case_reference": "..."}`

    The bulk counterpart to RescueLookupView above (2026-09-04, "if we
    achieve last attached user around the site or area, then feeding those
    list, can search at once and can export bulk result at once") -- for
    a list of numbers obtained some OTHER way (an HLR/VLR reverse-area
    query run through the operator's own core-network tooling, which this
    app has no access to and does not perform itself -- see this module's
    docstring), checking each one against THIS app's own enrolled-
    subscriber records in a single request instead of one lookup at a
    time. It does not change what can be found: a number that never
    enrolled through NetTelemetry.enrollForRescue() still comes back
    `found: false` here exactly as it would from a single lookup.

    Capped at MAX_BULK_MSISDNS entries per request -- generous for a
    genuine site/area extract, but not unbounded (this still runs a real
    DB query and writes one audit-log row per number).

    AUDIT: exactly as granular as calling RescueLookupView once per
    number -- one RescueLocationAccessLog row per requested msisdn, all
    sharing this call's case_reference and queried_at cluster, so a
    number's individual search history is never hidden inside a "batch"
    the way it would be if this only logged one row for the whole
    request. Malformed entries in `msisdns` are dropped before ever
    reaching the database and are NOT logged (matching RescueLookupView:
    nothing queried, nothing to audit) -- they come back in the response
    as their own row with `found: false` and no location fields, so the
    caller can still see which of their input numbers were unusable.

    Also honors RescueConsentPolicy and operator scoping identically to
    RescueLookupView -- see that view's docstring for what 'optional' mode
    does and does not unlock, and why an out-of-scope match is reported
    exactly like no match at all.
    """
    permission_classes = [IsAuthenticated, IsRescueOperator]
    MAX_BULK_MSISDNS = 500

    def post(self, request):
        raw_list = request.data.get('msisdns')
        case_reference = (request.data.get('case_reference') or '').strip()
        if not isinstance(raw_list, list) or not raw_list or not case_reference:
            return Response(
                {'detail': 'msisdns (a non-empty array) and case_reference are both required'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(raw_list) > self.MAX_BULK_MSISDNS:
            return Response(
                {'detail': f'max {self.MAX_BULK_MSISDNS} numbers per bulk lookup'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Preserves the caller's own order (an HLR/VLR extract may already
        # be sorted by signal time or proximity) while deduping and
        # dropping anything that doesn't look like a real MSISDN --
        # dict.fromkeys() is the standard order-preserving dedupe idiom.
        cleaned = list(dict.fromkeys(
            m for m in (_clean_msisdn(raw) for raw in raw_list) if m
        ))
        invalid_count = len(raw_list) - len(cleaned)

        policy = RescueConsentPolicy.objects.filter(pk=1).first()
        optional_active = bool(policy and policy.is_optional_active())
        policy_mode = RescueConsentPolicy.MODE_OPTIONAL if optional_active else RescueConsentPolicy.MODE_MANDATORY

        base_qs = SubscriberLastLocation.objects.filter(msisdn__in=cleaned)
        base_qs = base_qs if optional_active else base_qs.filter(rescue_consent=True)
        scoped = _scope_by_operator(base_qs, request.user, field='last_mnc')

        # One row per msisdn even if SubscriberLastLocation somehow has
        # more than one (e.g. a number re-enrolled under a different
        # device_id) -- keep whichever has the most recent fix, same
        # "most recent wins" rule RescueLookupView's own `.order_by(
        # '-last_seen_ts').first()` applies to a single number.
        by_msisdn = {}
        for row in scoped:
            if row.last_seen_ts is None:
                continue
            prev = by_msisdn.get(row.msisdn)
            if prev is None or row.last_seen_ts > prev.last_seen_ts:
                by_msisdn[row.msisdn] = row

        results = []
        for msisdn in cleaned:
            match = by_msisdn.get(msisdn)
            if match:
                results.append({
                    'msisdn': msisdn, 'found': True,
                    'lat': match.last_lat, 'lng': match.last_lng,
                    'accuracy_m': match.last_accuracy_m, 'source': match.last_source,
                    'last_seen_ts': match.last_seen_ts,
                })
            else:
                results.append({'msisdn': msisdn, 'found': False})

        RescueLocationAccessLog.objects.bulk_create([
            RescueLocationAccessLog(
                looked_up_by=request.user, msisdn_queried=msisdn, case_reference=case_reference,
                found=msisdn in by_msisdn, policy_mode=policy_mode,
            )
            for msisdn in cleaned
        ])

        return Response({
            'results': results,
            'requested_count': len(raw_list),
            'invalid_count': invalid_count,
            'found_count': len(by_msisdn),
        })


class RescueConsentPolicySerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=RescueConsentPolicy.MODE_CHOICES)
    reason = serializers.CharField(required=False, allow_blank=True, max_length=255)
    active_until = serializers.DateTimeField(required=False, allow_null=True)


class RescueConsentPolicyView(APIView):
    """`GET/POST /api/v2/rescue/policy/` — superadmin-only control for
    RescueConsentPolicy (see its docstring, core/models.py, for exactly
    what 'mandatory' vs 'optional' changes). Superadmin-only rather than
    IsRescueOperator: flipping this affects every rescue operator's
    lookups and the ingest pipeline's tracking behavior system-wide, a
    materially bigger blast radius than a single lookup.

    GET always reports `is_optional_active` (the EFFECTIVE state, after
    checking `active_until`) alongside the raw stored `mode` — an expired
    override still shows `mode: "optional"` until someone explicitly
    changes it, but `is_optional_active: false`, so the UI never has to
    duplicate the expiry check itself.

    Every POST is written to RescueConsentPolicyChangeLog — same
    "no silent capability change" posture as every other consequential
    action in this module.
    """
    permission_classes = [IsAuthenticated, IsSuperadminOnly]

    def get(self, request):
        policy, _ = RescueConsentPolicy.objects.get_or_create(pk=1)
        return Response({
            'mode': policy.mode,
            'reason': policy.reason,
            'active_until': policy.active_until,
            'is_optional_active': policy.is_optional_active(),
            'updated_at': policy.updated_at,
        })

    def post(self, request):
        serializer = RescueConsentPolicySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        policy, _ = RescueConsentPolicy.objects.get_or_create(pk=1)
        policy.mode = data['mode']
        policy.reason = data.get('reason', '')
        policy.active_until = data.get('active_until')
        policy.changed_by = request.user
        policy.save(update_fields=['mode', 'reason', 'active_until', 'changed_by', 'updated_at'])

        RescueConsentPolicyChangeLog.objects.create(
            changed_by=request.user, mode=policy.mode, reason=policy.reason, active_until=policy.active_until,
        )
        return Response({
            'mode': policy.mode,
            'reason': policy.reason,
            'active_until': policy.active_until,
            'is_optional_active': policy.is_optional_active(),
        })
