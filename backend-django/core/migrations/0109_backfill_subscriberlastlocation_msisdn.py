# Data migration (2026-10-08) -- backfills SubscriberLastLocation.msisdn
# through rescue.py's _clean_msisdn() canonicalization, same reasoning as
# 0107's DeviceIdentity.msisdn_lookup backfill: that function changed to
# canonicalize (not just validate) a phone number, so a row enrolled under
# the old code in a bare-local-number form (e.g. "9864465619") is now a
# format mismatch against a correctly canonicalized lookup
# ("+9779864465619" -> "9779864465619") for the exact same real number.
#
# This was previously applied by hand, one-off, against a single dev
# database -- folded into a real migration now so every environment
# (including whatever's currently live) gets it automatically on its next
# `migrate`, rather than relying on someone remembering to re-run a shell
# snippet.
from django.db import migrations


def backfill_msisdn(apps, schema_editor):
    SubscriberLastLocation = apps.get_model('core', 'SubscriberLastLocation')
    from core.rescue import _clean_msisdn

    for row in SubscriberLastLocation.objects.exclude(msisdn__isnull=True).exclude(msisdn='').iterator():
        canonical = _clean_msisdn(row.msisdn)
        if canonical and canonical != row.msisdn:
            row.msisdn = canonical
            row.save(update_fields=['msisdn'])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0108_seed_device_location_trace_menuitem'),
    ]

    operations = [
        migrations.RunPython(backfill_msisdn, noop),
    ]
