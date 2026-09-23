# Real `makemigrations` output (2026-09-12) -- taken verbatim from a
# genuine Django 5.2.16 run against the actual model state, surfaced
# while chasing a container crash-loop on a fresh local rebuild.
#
# `DriveTestSessionAttachment` (the model behind DT Session History's
# "Attachments" column and the per-session file-upload action in
# drive_test.py) has apparently NEVER had a migration in this repo --
# the exact same class of bug as 0053's missing `remarks` column, just
# for a whole table this time instead of one field. How the table
# exists at all on any deployment where attachments already work is
# unclear (some earlier ad-hoc `migrate --run-syncdb` or a hand-run
# CREATE TABLE, most likely) -- but Django's own migration-state replay
# has no record of ever creating it, which is what actually matters for
# `makemigrations --check` to ever pass cleanly again.
#
# **This one is NOT safe to blindly `migrate` on every environment the
# way 0055 is.** Two different situations can be true depending on the
# deployment:
#   - The table already physically exists (e.g. production, where
#     Session History already shows attachment counts) -- there,
#     `migrate` will fail with "relation already exists" exactly like
#     0053 first did for `remarks`, and this migration needs
#     `python manage.py migrate core 0056 --fake` instead of a real run.
#   - The table genuinely does not exist yet (a fresh database that
#     never had attachments manually added) -- there, a normal
#     `migrate` creates it for real, which is correct.
# Check which situation applies (e.g. try `migrate` normally first; if
# it errors with "already exists", re-run with `--fake` instead) rather
# than assuming either case.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

import core.models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0055_alter_id_fields_to_bigautofield'),
    ]

    operations = [
        migrations.CreateModel(
            name='DriveTestSessionAttachment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('file', models.FileField(max_length=500, upload_to=core.models.dt_session_attachment_upload_path)),
                ('original_filename', models.CharField(blank=True, default='', max_length=255)),
                ('size_bytes', models.BigIntegerField(blank=True, null=True)),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
                ('session', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='attachments', to='core.drivetestsession',
                )),
                ('uploaded_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='dt_session_attachments', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_dt_session_attachments',
                'ordering': ['-uploaded_at'],
                'indexes': [models.Index(fields=['session'], name='v2_dt_sessi_session_b816ff_idx')],
            },
        ),
    ]
