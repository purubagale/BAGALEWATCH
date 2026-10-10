# Data migration (2026-10-10) -- rewrites eight seeded MenuItem descriptions
# in plain words. They are shown to users on the Dashboard cards, and the
# old text named internal things (a model class, "pipeline", "geohash",
# "during development"). The Rescue Policy one was also out of date: an
# emergency no longer overrides consent (core/emergency.py). A row is only
# changed while it still holds the seeded text, so a description a
# superadmin has edited in Menu Admin is left alone.
from django.db import migrations

# path -> (seeded description, plain description)
CHANGES = {
    '/t7m2kq': (
        'Crowdsourced-telemetry coverage map (geohash-binned RSRP / RSRQ / SINR)',
        'Coverage map from the signal data shared by subscribers\' phones (RSRP, RSRQ, SINR)',
    ),
    '/t4v9cx': (
        'Ingest keys and volume overview for the crowdsourced-telemetry pilot',
        'Mobile app keys and an overview of the signal data received',
    ),
    '/t6q9lp': (
        'Scoped live drive-test sessions over the crowdsourced-telemetry pipeline',
        'Live drive-test sessions using phones that are sharing signal data',
    ),
    '/z3q8mn': (
        'Raw, per-sample view for verifying test-device telemetry uploads during development',
        'Individual signal samples, for checking a test device\'s uploads',
    ),
    '/w2k6tr': (
        'Raw VoLTE/VoNR call-quality samples with an estimated MOS, for verifying carrier-privileged '
        'test-device uploads',
        'VoLTE/VoNR call-quality samples with an estimated MOS',
    ),
    '/r2p6ky': (
        'Declare a time-boxed emergency override of the rescue-lookup consent requirement',
        'Declare or end the emergency that turns location search on',
    ),
    '/r8x4ml': (
        'Provisional superadmin-only list of every device currently opted in to the Rescue Location beacon',
        'Every device currently opted in to rescue location sharing',
    ),
    '/r7t2wm': (
        'Every phone registered for NTC trace requests (DeviceCredential)',
        'Every phone registered for NTC location requests',
    ),
}


def apply(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for path, (old, new) in CHANGES.items():
        MenuItem.objects.filter(path=path, description=old).update(description=new)


def revert(apps, schema_editor):
    MenuItem = apps.get_model('core', 'MenuItem')
    for path, (old, new) in CHANGES.items():
        MenuItem.objects.filter(path=path, description=new).update(description=old)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0116_fix_device_location_trace_description'),
    ]

    operations = [
        migrations.RunPython(apply, revert),
    ]
