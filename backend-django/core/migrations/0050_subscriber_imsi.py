# Adds SubscriberLastLocation.imsi (2026-09-05) -- schema-only for now.
# Nothing populates it yet: RescueEnrollView calls
# core.subscriber_network_resolver.resolve_subscriber_network_info(),
# which is a stub returning {} until Nepal Telecom subscriber-database
# access exists (an HLR/HSS/VLR-style msisdn->imsi lookup) or a future
# carrier-privileged SDK build can read it on-device. See that module's
# docstring and SubscriberLastLocation.imsi's field comment (core/
# models.py) for the full two-track rationale -- this migration exists
# so the column and its migration-ordering slot are settled now, ahead of
# either track actually landing.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0049_rescue_menu_items'),
    ]

    operations = [
        migrations.AddField(
            model_name='subscriberlastlocation',
            name='imsi',
            field=models.CharField(blank=True, db_index=True, max_length=20, null=True),
        ),
    ]
