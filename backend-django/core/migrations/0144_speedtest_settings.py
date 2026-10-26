# 2026-10-26. Where phones run the speed test (core/speed_test.py): blank
# means this server's own /speedtest/; a public machine's address later.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0143_alarm_source_settings'),
    ]

    operations = [
        migrations.CreateModel(
            name='SpeedTestSettings',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('base_url', models.CharField(blank=True, default='', max_length=300)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                 related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'db_table': 'v2_speedtest_settings'},
        ),
    ]
