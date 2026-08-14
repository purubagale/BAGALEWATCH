# Written by hand (2026-08-11) to match EXACTLY what `docker compose exec
# django python manage.py makemigrations core` generated and the user
# already ran successfully — confirmed clean afterward via
# `makemigrations core --dry-run` ("No changes detected in app 'core'").
#
# This file was NOT on host disk until now — `django`'s docker-compose
# service has no source bind mount (see that service's own volumes
# comment), so running makemigrations inside the container writes the
# file only to the container's writable layer, which is discarded on the
# next image rebuild. Per this project's own established lesson (see
# memory feedback_docker_migrations_no_persist.md), that means this
# migration would have silently vanished the next time `docker compose
# build django` runs (which the TRP File Analysis submenu below requires
# anyway) — reconstructed here from the known-good `makemigrations
# --dry-run` output so it actually survives the rebuild instead of
# regenerating a duplicate rename against an index that's already been
# renamed (which would then fail with "index ... does not exist").
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0026_brandingsettings_login_disclaimer'),
    ]

    operations = [
        migrations.RenameIndex(
            model_name='drivetestsample',
            new_name='v2_dt_sampl_lat_1ab414_idx',
            old_name='v2_dt_sampl_lat_1a2b3c_idx',
        ),
    ]
