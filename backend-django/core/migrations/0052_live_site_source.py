# LiveSiteSource (2026-09-08) -- "add feature of multiple source api
# connection in import api access page along with their separate
# automatic sync time set option and manual sinc". Replaces the old
# LiveSiteSyncConfig/LiveSiteSyncStatus singleton pair -- see that
# model's docstring (core/models.py) for the full reasoning (config AND
# status on one row per source; every enabled source polled/synced
# independently on its own interval by the same site-sync loop; all
# sources merged into the same Site table by site id).
#
# The data migration below copies whatever was already configured in
# LiveSiteSyncConfig/LiveSiteSyncStatus (a single-source deployment's
# existing URL/key/scheme + run history) into the FIRST LiveSiteSource
# row, named "Default", so upgrading a deployment that already had a
# source configured does not lose it or silently stop syncing. A fresh
# deployment with no LiveSiteSyncConfig row yet gets no LiveSiteSource
# rows either -- exactly like today, where an admin has to configure a
# source before anything is fetched (only now via "Add source" on the
# Live Site Sync page instead of the old single config form). Both old
# tables are left in place (not deleted) -- nothing in this migration or
# in current code drops them, so no data is destroyed even if a rollback
# is ever needed.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def copy_singleton_into_first_source(apps, schema_editor):
    LiveSiteSyncConfig = apps.get_model('core', 'LiveSiteSyncConfig')
    LiveSiteSyncStatus = apps.get_model('core', 'LiveSiteSyncStatus')
    LiveSiteSource = apps.get_model('core', 'LiveSiteSource')

    config = LiveSiteSyncConfig.objects.filter(pk=1).first()
    status = LiveSiteSyncStatus.objects.filter(pk=1).first()
    if not config and not status:
        # Nothing was ever configured -- nothing to carry forward.
        return

    # settings isn't available inside a data migration's historical
    # model state, so the old env-var default (86400s = 1440min) is
    # inlined here rather than imported -- this only ever runs once, at
    # upgrade time, against whatever LIVE_SITE_SYNC_INTERVAL_SECONDS was
    # in effect when this migration is applied; a deployment that
    # customized that env var keeps its own value via os.environ below.
    import os
    interval_seconds = int(os.environ.get('LIVE_SITE_SYNC_INTERVAL_SECONDS', 86400))
    interval_minutes = max(interval_seconds // 60, 1)

    LiveSiteSource.objects.create(
        name='Default',
        api_url=(config.api_url if config else '') or '',
        api_key=(config.api_key if config else '') or '',
        auth_scheme=(config.auth_scheme if config else 'Bearer') or 'Bearer',
        sync_interval_minutes=interval_minutes,
        enabled=True,
        updated_by_id=(config.updated_by_id if config else None),
        last_run_at=(status.last_run_at if status else None),
        last_success_at=(status.last_success_at if status else None),
        last_created=(status.last_created if status else None),
        last_updated=(status.last_updated if status else None),
        last_warnings=(status.last_warnings if status else None),
        last_error=(status.last_error if status else ''),
    )


def noop_reverse(apps, schema_editor):
    # Deliberately a no-op -- reversing this migration only drops the
    # LiveSiteSource TABLE (the schema operation below handles that on
    # its own); it must not also delete the still-intact
    # LiveSiteSyncConfig/LiveSiteSyncStatus rows this migration read
    # from, since those were never touched in the forward direction.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0051_live_site_sync_config'),
    ]

    operations = [
        migrations.CreateModel(
            name='LiveSiteSource',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=100)),
                ('api_url', models.CharField(blank=True, default='', max_length=500)),
                ('api_key', models.CharField(blank=True, default='', max_length=500)),
                ('auth_scheme', models.CharField(
                    choices=[('Bearer', 'Bearer <token>'), ('Token', 'Token <token> (NetBox)')],
                    default='Token', max_length=10,
                )),
                ('sync_interval_minutes', models.PositiveIntegerField(default=60)),
                ('enabled', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('last_run_at', models.DateTimeField(blank=True, null=True)),
                ('last_success_at', models.DateTimeField(blank=True, null=True)),
                ('last_created', models.PositiveIntegerField(blank=True, null=True)),
                ('last_updated', models.PositiveIntegerField(blank=True, null=True)),
                ('last_warnings', models.JSONField(blank=True, null=True)),
                ('last_error', models.TextField(blank=True, default='')),
                ('updated_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_live_site_sources',
                'ordering': ['id'],
            },
        ),
        migrations.RunPython(copy_singleton_into_first_source, noop_reverse),
    ]
