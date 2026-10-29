# "Help improve NTC's network": four anonymous readings a day (2026-10-29).
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0152_area_request_registered'),
    ]

    operations = [
        migrations.CreateModel(
            name='ScheduledReading',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('anon_hash', models.CharField(db_index=True, max_length=32)),
                ('ts', models.DateTimeField(db_index=True)),
                ('received_at', models.DateTimeField(auto_now_add=True)),
                ('slot', models.SmallIntegerField(blank=True, null=True)),
                ('network_type', models.CharField(blank=True, default='', max_length=12)),
                ('band', models.CharField(blank=True, default='', max_length=24)),
                ('level_dbm', models.IntegerField(blank=True, null=True)),
                ('rsrq_db', models.IntegerField(blank=True, null=True)),
                ('sinr_db', models.IntegerField(blank=True, null=True)),
                ('mcc', models.CharField(blank=True, default='', max_length=6)),
                ('mnc', models.CharField(blank=True, default='', max_length=6)),
                ('serving_site_id', models.CharField(blank=True, db_index=True, default='', max_length=40)),
                ('serving_sector', models.CharField(blank=True, default='', max_length=40)),
            ],
            options={
                'db_table': 'v2_scheduled_reading',
                'indexes': [models.Index(fields=['slot', 'ts'], name='v2_sched_slot_ts_idx')],
            },
        ),
    ]
