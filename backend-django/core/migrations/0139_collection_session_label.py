"""Collection sessions get a name, the phone's number and a district
(2026-10-19, core/collection.py): "<district> · <source> · <start>". Existing
sessions are named here from their own readings."""
from zoneinfo import ZoneInfo

from django.db import migrations, models
from django.db.models import Q

NEPAL_TZ = ZoneInfo('Asia/Kathmandu')
SOURCE_LABELS = {
    'crowd_drive': 'Crowd drive', 'staff_drive': 'Staff drive', 'operator_investigation': 'Operator investigation',
    'operator_case': 'Operator case', 'drive_test': 'Drive test (team)',
}


def name_existing(apps, schema_editor):
    from django.contrib.gis.db.models.functions import Distance
    from django.contrib.gis.geos import Point
    from django.contrib.gis.measure import D

    CollectionSession = apps.get_model('core', 'CollectionSession')
    TelemetrySample = apps.get_model('core', 'TelemetrySample')
    Site = apps.get_model('core', 'Site')
    DeviceCredential = apps.get_model('core', 'DeviceCredential')
    SubscriberDevice = apps.get_model('core', 'SubscriberDevice')
    TraceRequest = apps.get_model('core', 'TraceRequest')

    for s in CollectionSession.objects.all().iterator():
        district = ''
        msisdn = ''
        if s.trace_id:
            msisdn = TraceRequest.objects.filter(pk=s.trace_id).values_list('msisdn', flat=True).first() or ''
        elif s.drive_session_id:
            readings = TelemetrySample.objects.filter(device_id=s.device_hash, drive_session_id=s.drive_session_id)
            site_id = (readings.exclude(serving_site_id='').order_by('ts').values_list('serving_site_id', flat=True).first())
            if site_id:
                district = Site.objects.filter(pk=site_id).values_list('district', flat=True).first() or ''
            if not district:
                first = readings.exclude(lat__isnull=True).order_by('ts').values('lat', 'lng').first()
                if first:
                    point = Point(first['lng'], first['lat'], srid=4326)
                    district = (Site.objects.filter(location__distance_lte=(point, D(km=20))).exclude(district='')
                                .annotate(d=Distance('location', point)).order_by('d')
                                .values_list('district', flat=True).first()) or ''
        if not msisdn and s.device_hash:
            msisdn = (DeviceCredential.objects.filter(Q(device_hash=s.device_hash) | Q(sdk_device_hash=s.device_hash))
                      .exclude(msisdn__isnull=True).exclude(msisdn='').order_by('-created_at')
                      .values_list('msisdn', flat=True).first()) or \
                (SubscriberDevice.objects.filter(device_hash=s.device_hash, ended_at__isnull=True)
                 .order_by('-last_seen_at').values_list('msisdn', flat=True).first()) or ''
        started = s.started_at.astimezone(NEPAL_TZ)
        name = f'{district or "Unknown area"} · {SOURCE_LABELS.get(s.source, s.source)} · {started:%Y-%m-%d %H:%M}'
        CollectionSession.objects.filter(pk=s.pk).update(name=name, district=district, msisdn=msisdn)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0138_complaint_location'),
    ]

    operations = [
        migrations.AddField(
            model_name='collectionsession', name='name',
            field=models.CharField(blank=True, default='', max_length=200),
        ),
        migrations.AddField(
            model_name='collectionsession', name='msisdn',
            field=models.CharField(blank=True, db_index=True, default='', max_length=24),
        ),
        migrations.AddField(
            model_name='collectionsession', name='district',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.RunPython(name_existing, migrations.RunPython.noop),
    ]
