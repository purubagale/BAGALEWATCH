# 2026-08-10 memory/size/performance audit finding — see models.py's
# DriveTestSample.Meta.indexes comment for the full "why": the `near`
# action's bounding-box lat/lng prefilter (core/drive_test.py) has always
# claimed in its own docstring to be a "cheap index range scan", but no
# index on lat/lng ever actually existed on this table — every Explore-
# by-Coordinates search was really doing a full sequential scan across
# every drive-test sample ever uploaded (this is the single largest table
# in the app; one upload batch alone can be 120,000+ rows).
#
# IMPORTANT — index name below is an UNVERIFIED GUESS, not Django's real
# computed name. Per this project's own hard-learned lesson (a prior
# hand-written index name mismatch broke `migrate` outright with
# "relation does not exist" — see the "Hand-guessed index names break
# migrate" note), do NOT just run `migrate` against this file as-is.
# Instead: run `python manage.py makemigrations core` first. If it
# reports "No changes detected", this guess happened to be exactly right
# and it's safe to migrate normally. If it instead generates a
# `RenameIndex` migration, that migration's own output will print the
# real target name (e.g. "~ Rename index v2_dt_sampl_lat_XXXXXX_idx to
# v2_dt_sampl_YYYYYY_idx") — copy that REAL name into the `name=` kwarg
# below, delete the generated RenameIndex migration, and re-run
# `makemigrations core` to confirm it now reports no changes, before
# migrating either database.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0024_widen_sector_sector_sector_tech'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='drivetestsample',
            index=models.Index(fields=['lat', 'lng'], name='v2_dt_sampl_lat_1a2b3c_idx'),
        ),
    ]
