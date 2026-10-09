"""Number <-> device links (2026-10-09). See SubscriberDevice in models.py
for what the table is and why it exists.

Three things live here:

  link_device()        every path that learns a number for a device calls
                       this (rescue enrolment, phone registration, identity
                       upload).
  touch_seen()         ingest calls this so each link knows when its device
                       last uploaded.
  devices_for_msisdn() what the lookup tools read.

Rules when a link is written:

  * The same number on a second device is kept. Both links stay active:
    a subscriber may use two handsets.
  * The same PHONE under more than one device hash is NOT retired. A phone
    legitimately has two at once (the SDK's install id for ordinary
    uploads and rescue enrolment, the registration key's id for signed
    uploads), and a reinstall adds a third. Links that share a
    `hardware_hash` are instead shown and searched as one phone by the
    lookups (device_lookup._latest_position). Only possible once the app
    sends `hardware_id`.
  * A device that reports a DIFFERENT number through the same path it
    used before has had its SIM changed: its link to the old number is
    ended. A second number through a different path is kept, because a
    dual-SIM phone can legitimately register one number and enrol another.
"""
import hashlib
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from .models import DeviceIdentity, SubscriberDevice, SubscriberLastLocation


def stale_after():
    return timedelta(days=getattr(settings, 'SUBSCRIBER_DEVICE_STALE_DAYS', 30))


def hash_hardware_id(raw):
    """Salted one-way hash of the Android ID a device sends, '' for none.
    Its own salt prefix, so it can never collide with or be compared to a
    device hash."""
    raw = str(raw or '').strip()
    if not raw:
        return ''
    return hashlib.sha256((settings.TELEMETRY_DEVICE_ID_SALT + '::hw::' + raw).encode()).hexdigest()[:32]


def link_device(msisdn, device_hash, via, *, manufacturer='', phone_model='', app_version='',
                hardware_id='', verified_by=None):
    """Record that `msisdn` (already canonical) is used on `device_hash`.
    Safe to call on every enrolment / registration / upload: an existing
    link is refreshed, an ended one is reopened. Returns the link, or None
    when either key is missing."""
    if not msisdn or not device_hash:
        return None
    now = timezone.now()
    hardware_hash = hash_hardware_id(hardware_id)

    link, created = SubscriberDevice.objects.get_or_create(msisdn=msisdn, device_hash=device_hash)
    if via not in link.linked_via:
        link.linked_via = [*link.linked_via, via]
    link.last_linked_at = now
    link.ended_at = None
    link.ended_reason = ''
    # Only overwrite a detail with a real value: an older app build that
    # sends no model must not blank one a newer build already stored.
    link.manufacturer = (manufacturer or '').strip()[:80] or link.manufacturer
    link.phone_model = (phone_model or '').strip()[:80] or link.phone_model
    link.app_version = (app_version or '').strip()[:40] or link.app_version
    link.hardware_hash = hardware_hash or link.hardware_hash
    if verified_by:
        link.number_verified_by = verified_by
    if not link.manufacturer and not link.phone_model:
        identity = DeviceIdentity.objects.filter(device_hash=device_hash).first()
        if identity:
            link.manufacturer, link.phone_model = identity.manufacturer, identity.phone_model
    link.save()

    # SIM changed: this device, this same path, a different number before.
    for old in SubscriberDevice.objects.filter(device_hash=device_hash, ended_at__isnull=True).exclude(pk=link.pk):
        if via in old.linked_via:
            old.ended_at, old.ended_reason = now, SubscriberDevice.ENDED_NUMBER_CHANGED
            old.save(update_fields=['ended_at', 'ended_reason'])
    return link


def touch_seen(device_hashes, when=None):
    """Stamp `last_seen_at` on the active links of devices that have just
    uploaded. One UPDATE; touches nothing for the anonymous majority."""
    device_hashes = [h for h in device_hashes if h]
    if not device_hashes:
        return
    SubscriberDevice.objects.filter(
        device_hash__in=device_hashes, ended_at__isnull=True,
    ).update(last_seen_at=when or timezone.now())


def devices_for_msisdn(msisdn, include_withdrawn=False):
    """Active links for a number, most recently seen first.

    A device whose owner has withdrawn rescue consent (a
    SubscriberLastLocation row with rescue_consent=False) is left out
    unless `include_withdrawn`: the same rule the lookups have always
    applied, kept even during an emergency.
    """
    links = list(SubscriberDevice.objects.filter(msisdn=msisdn, ended_at__isnull=True))
    if links and not include_withdrawn:
        withdrawn = set(SubscriberLastLocation.objects.filter(
            device_id__in=[link.device_hash for link in links], rescue_consent=False,
        ).values_list('device_id', flat=True))
        links = [link for link in links if link.device_hash not in withdrawn]
    never = timezone.now() - timedelta(days=36500)
    links.sort(key=lambda link: link.last_seen_at or link.last_linked_at or never, reverse=True)
    return links


def describe(link, now=None):
    """Display fields for one link."""
    now = now or timezone.now()
    seen = link.last_seen_at
    return {
        'device_hash': link.device_hash,
        # Internal grouping key, removed before anything is sent to a client.
        'hardware_hash': link.hardware_hash,
        'manufacturer': link.manufacturer or None,
        'phone_model': link.phone_model or None,
        'app_version': link.app_version or None,
        'linked_by': list(link.linked_via),
        'number_verified_by': link.number_verified_by,
        'first_linked_at': link.first_linked_at,
        'last_seen_at': seen,
        # No upload for the stale period (30 days by default), or none at
        # all: shown to the operator, not hidden.
        'stale': seen is None or (now - seen) > stale_after(),
    }


def unlink_via(device_hash, via):
    """A device has taken back one of the ways it was linked (rescue
    consent withdrawn, identity number cleared). The link ends only when
    no other path still vouches for it."""
    now = timezone.now()
    for link in SubscriberDevice.objects.filter(device_hash=device_hash, ended_at__isnull=True):
        if via not in link.linked_via:
            continue
        link.linked_via = [v for v in link.linked_via if v != via]
        if not link.linked_via:
            link.ended_at, link.ended_reason = now, 'withdrawn'
        link.save(update_fields=['linked_via', 'ended_at', 'ended_reason'])


def update_device_details(device_hash, manufacturer=None, phone_model=None, hardware_id=None):
    """Copy a newly uploaded make / model / hardware id onto the device's
    active links. The hardware id arriving this way is how a phone linked
    before the app sent one gets grouped with its other device ids."""
    changes = {}
    hardware_hash = hash_hardware_id(hardware_id)
    if hardware_hash:
        changes['hardware_hash'] = hardware_hash
    if manufacturer:
        changes['manufacturer'] = manufacturer[:80]
    if phone_model:
        changes['phone_model'] = phone_model[:80]
    if changes:
        SubscriberDevice.objects.filter(device_hash=device_hash, ended_at__isnull=True).update(**changes)
