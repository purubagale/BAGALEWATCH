"""
Seam for resolving network-side subscriber identifiers (IMSI today,
extensible to a current-registered-cell lookup later) from an msisdn --
see core/rescue.py's module docstring and SubscriberLastLocation's
`imsi` field comment (core/models.py) for the two tracks this exists to
serve:

  * Track A (any deployment of this app, general public included) has no
    way to read a subscriber's real IMSI off their phone -- Android has
    restricted TelephonyManager.getSubscriberId() to system/carrier-
    privileged/device-owner apps since API 29, so a normal SDK install
    can never populate this field on-device (see netplanning-telemetry-
    sdk's DeviceIdentity.kt, which deliberately keeps the app's own
    device_id unrelated to IMEI/Android ID/MSISDN for exactly this class
    of restriction). The only place left to get IMSI from is Nepal
    Telecom's own network -- an HLR/HSS/VLR-style subscriber lookup by
    msisdn -- which this function is the one seam for.

  * Track B (a future carrier-privileged or pre-installed build of the
    SDK) could read IMSI on-device once that status is granted, but
    that's a separate code path inside the SDK itself, not this
    function -- this function only covers the "ask the network" route,
    which works for every enrolled subscriber regardless of which app
    build they're running, so both tracks land in the same `imsi` field
    without forking the data model.

STUB as of 2026-09-05: no programmatic access to any subscriber database
exists yet (HLR/HSS query, VLR/MSC interface, or any internal subscriber
DB -- confirmed with the project owner), so this always returns an empty
result and RescueEnrollView's call to it is a no-op today. Nothing above
or below this function needs to change when that access arrives -- only
this function's body does. Resist the temptation to special-case IMSI
handling anywhere else in rescue.py or models.py once a real
implementation lands here; everything else already treats `imsi` as "may
or may not be populated," exactly like `msisdn` treats a device that
hasn't sent a GPS fix yet.
"""
from typing import TypedDict


class SubscriberNetworkInfo(TypedDict, total=False):
    imsi: str | None
    # Room to grow into later, e.g. a `registered_cell_id`/`registered_at`
    # pair from a VLR/MSC query for near-real-time network-side location
    # (independent of whatever the app itself last reported) -- without
    # another migration to this function's signature or its call site.


def resolve_subscriber_network_info(msisdn: str) -> SubscriberNetworkInfo:
    """Best-effort network-side lookup for `msisdn`. Returns {} (nothing
    resolved) rather than raising, so a missing/unreachable subscriber
    database never blocks enrollment -- this is enrichment, not a
    requirement, and RescueEnrollView must keep working exactly as it
    does today for every deployment that never gets this access at all.

    Called synchronously from RescueEnrollView because it's a no-op --
    if a real implementation here ever adds genuine network latency,
    move the call onto an async retry path (the same WorkManager-retry
    shape netplanning-telemetry-sdk's UploadWorker/RescueEnrollWorker
    already use on the device side) rather than blocking the enroll
    request on a live network-element query.
    """
    return {}
