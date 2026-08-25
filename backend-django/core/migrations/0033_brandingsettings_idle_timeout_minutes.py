# Hand-written (2026-08-25), same trivial AddField shape Django's own
# makemigrations would generate for a single new nullable
# PositiveIntegerField — no hand-guessed index name involved (that pitfall
# only applies to models.Index()), so this is safe to write by hand and run
# as-is. Written by hand rather than via `docker exec ... makemigrations`
# because the django service has no source bind mount here — a
# container-generated migration file would not land on the real host disk.
#
# Adds the in-app override for how many minutes of inactivity trigger
# auto-logout (2026-08-25 follow-up: "session time for logout is very low,
# add a feature to customize session time for logout"). NULL (the default)
# means "no override, use the IDLE_TIMEOUT_MINUTES env var" — same
# blank/null-means-default convention as every other field on this model —
# so every existing install is unaffected until a superadmin explicitly sets
# a value via the Branding page.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0032_seed_about_menuitem'),
    ]

    operations = [
        migrations.AddField(
            model_name='brandingsettings',
            name='idle_timeout_minutes',
            field=models.PositiveIntegerField(blank=True, default=None, null=True),
        ),
    ]
