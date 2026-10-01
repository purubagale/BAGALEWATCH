# New model (2026-10-01) -- AuthEventLog, the login/access audit trail
# behind the new "Access Log" admin page (core/auth_log.py). See
# AuthEventLog's own docstring in core/models.py for the full design
# rationale -- this is a plain (non-partitioned) table, same convention
# as the structurally similar RescueLocationAccessLog added in 0043.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0073_brandingsettings_footer_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='AuthEventLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('event', models.CharField(choices=[
                    ('login_success', 'Local login succeeded'),
                    ('login_failed', 'Local login failed (bad credentials)'),
                    ('login_locked', 'Local login blocked (too many attempts)'),
                    ('login_disabled', 'Local login blocked (account disabled)'),
                    ('sso_login_success', 'SSO login succeeded'),
                    ('sso_login_failed', 'SSO login failed'),
                    ('logout', 'Signed out'),
                ], db_index=True, max_length=20)),
                ('username', models.CharField(blank=True, db_index=True, default='', max_length=150)),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('user_agent', models.CharField(blank=True, default='', max_length=255)),
                ('detail', models.CharField(blank=True, default='', max_length=200)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='auth_events', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_auth_event_log',
                'ordering': ['-created_at'],
            },
        ),
    ]
