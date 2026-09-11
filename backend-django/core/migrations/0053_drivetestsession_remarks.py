# Missing migration, found 2026-09-11 -- DriveTestSession.remarks (models.py)
# was added on 2026-09-07 ("add ... provision to provide remarks/comments on
# the session if needed") but no migration was ever generated for it, so
# every deployment's `v2_dt_sessions` table never actually got the column.
# Silent until now because nothing forced a schema check in between --
# surfaced as `django.db.utils.ProgrammingError: column "remarks" of
# relation "v2_dt_sessions" does not exist` on BOTH listing sessions
# (SELECT ... remarks) and saving one (INSERT ... remarks), the moment
# someone next tried the DT Session Upload / History pages against a real
# deployment. Coincidentally noticed right after an unrelated Reset
# Site Data + Live Site Sync run, but this has nothing to do with
# Site/Sector data -- it's a pre-existing gap from the 2026-09-07 change,
# unmasked by this just being the first save/list attempt since then.
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0052_live_site_source'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsession',
            name='remarks',
            field=models.TextField(blank=True, default=''),
        ),
    ]
