# 2026-10-26. The active-alarm connection set on the Live Site Sync page
# (core/alarms.py), so the address and key need not live in .env. Singleton;
# the key is stored encrypted.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0142_telemetry_reading_status'),
    ]

    operations = [
        migrations.CreateModel(
            name='AlarmSourceSettings',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('api_url', models.CharField(blank=True, default='', max_length=500)),
                ('api_key_encrypted', models.TextField(blank=True, default='')),
                ('auth_scheme', models.CharField(choices=[('Bearer', 'Bearer <key>'), ('Token', 'Token <key>')], default='Bearer', max_length=10)),
                ('cache_seconds', models.PositiveIntegerField(default=60)),
                ('enabled', models.BooleanField(default=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                 related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'db_table': 'v2_alarm_source_settings'},
        ),
    ]
