"""Fill SubscriberDevice from the three places a number <-> device link
already lived (2026-10-09): rescue enrolments, registered phones and
identity uploads. From here on core/subscriber_device.py's link_device()
keeps the table current.

Rescue rows whose consent was withdrawn, and revoked registrations, are
not copied. `last_seen_at` is the device's newest telemetry sample time
when it has one, else the newest time its source row records.
"""
from django.db import migrations
from django.db.models import Max

VIA_RESCUE = 'rescue_enrolment'
VIA_REGISTRATION = 'registered_phone'
VIA_IDENTITY = 'identity_upload'


def backfill(apps, schema_editor):
    SubscriberDevice = apps.get_model('core', 'SubscriberDevice')
    SubscriberLastLocation = apps.get_model('core', 'SubscriberLastLocation')
    DeviceCredential = apps.get_model('core', 'DeviceCredential')
    DeviceIdentity = apps.get_model('core', 'DeviceIdentity')
    TelemetrySample = apps.get_model('core', 'TelemetrySample')

    # (msisdn, device_hash) -> {'via': [...], 'first': dt, 'seen': dt, 'app': str}
    found = {}

    def add(msisdn, device_hash, via, first=None, seen=None, app=''):
        if not msisdn or not device_hash:
            return
        entry = found.setdefault((msisdn, device_hash), {'via': [], 'first': None, 'seen': None, 'app': ''})
        if via not in entry['via']:
            entry['via'].append(via)
        if first and (entry['first'] is None or first < entry['first']):
            entry['first'] = first
        if seen and (entry['seen'] is None or seen > entry['seen']):
            entry['seen'] = seen
        entry['app'] = app or entry['app']

    for r in SubscriberLastLocation.objects.filter(rescue_consent=True).exclude(msisdn__isnull=True).exclude(msisdn=''):
        add(r.msisdn, r.device_id, VIA_RESCUE, first=r.created_at, seen=r.last_seen_ts)
    for d in DeviceCredential.objects.filter(revoked_at__isnull=True).exclude(msisdn__isnull=True).exclude(msisdn=''):
        add(d.msisdn, d.device_hash, VIA_REGISTRATION, first=d.created_at, seen=d.last_seen_at, app=d.app_version)

    # Identity uploads store the number encrypted. Decrypting needs the
    # app's own key helper; a row that cannot be read is skipped, never
    # fatal to the migration.
    try:
        from core.mfa import decrypt_secret
    except Exception:  # noqa: BLE001
        decrypt_secret = None
    identities = {}
    for i in DeviceIdentity.objects.all():
        identities[i.device_hash] = i
        if decrypt_secret is None or not i.msisdn_enc:
            continue
        try:
            msisdn = decrypt_secret(i.msisdn_enc)
        except Exception:  # noqa: BLE001
            continue
        add(msisdn, i.device_hash, VIA_IDENTITY, first=i.updated_at, seen=None)

    for (msisdn, device_hash), entry in found.items():
        newest = TelemetrySample.objects.filter(device_id=device_hash).aggregate(m=Max('ts'))['m']
        seen = max([t for t in (newest, entry['seen']) if t is not None], default=None)
        identity = identities.get(device_hash)
        link, created = SubscriberDevice.objects.get_or_create(
            msisdn=msisdn, device_hash=device_hash,
            defaults={
                'linked_via': entry['via'], 'app_version': entry['app'] or '',
                'manufacturer': identity.manufacturer if identity else '',
                'phone_model': identity.phone_model if identity else '',
                'last_seen_at': seen,
            },
        )
        if created and entry['first']:
            # auto_now_add stamped "now"; put the real first-linked time back.
            SubscriberDevice.objects.filter(pk=link.pk).update(first_linked_at=entry['first'])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0114_subscriber_device'),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
