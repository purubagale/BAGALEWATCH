# Hand-authored migration (2026-09-14), following this repo's established
# convention for hand-writing a migration when a live container isn't
# available to run a real `makemigrations` against (see 0054's own
# comment for the same situation). `Issue` (the site/sector issue
# tracker, linked to OptimizationActivity via `resolved_by_activity` --
# see Issue's docstring in core/models.py) is a brand-new table, so this
# is a plain single CreateModel, no data migration needed.
#
# **Learned from 0055's root cause**: this app's settings.py sets
# DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField', and the earlier
# OptimizationActivity/OptimizationActivitySession/LiveSiteSource bug was
# a hand-written migration copying an OLDER migration's literal
# `models.AutoField(...)` PK style instead of matching that setting --
# `id` below is deliberately `models.BigAutoField(...)`, not AutoField,
# to not repeat that mistake a third time.
#
# **Whoever applies this**: also run `python manage.py makemigrations
# --check` afterward against a live container with the real Django 5.2.16
# model state, exactly like was done to verify/correct 0054-0056 earlier
# this month -- a hand-authored migration in this repo has been wrong
# before (0053's missing column, 0054/0052's wrong PK type, 0056's
# never-migrated table) and should not be trusted blind just because it
# parses and looks plausible.
# Note on the `site` index below: CORRECTED 2026-09-15 -- an earlier
# version of this migration left it as `models.Index(fields=['site'])`
# with NO explicit `name=`, on the theory that Django would resolve the
# name deterministically at apply time the same way it does for a live
# model's Meta.indexes. That theory was wrong for a *migration operation*:
# ModelState.__init__ requires every Index passed through CreateModel's
# options to already carry a `.name` -- it has no live model class to call
# `set_name_with_model()` against, so an unnamed Index here raises
# `ValueError: Indexes passed to ModelState require a name attribute`
# on every `migrate` (confirmed against a real container 2026-09-15).
# Fixed by computing the exact name Django's own
# `Index.set_name_with_model()` would produce for db_table='v2_issues',
# column='site_id' (verified by running the real algorithm against
# Django==5.2.16, matching requirements.txt, in an isolated throwaway
# model -- not hand-guessed).
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0056_drivetestsessionattachment'),
    ]

    operations = [
        migrations.CreateModel(
            name='Issue',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('title', models.CharField(max_length=255)),
                ('description', models.TextField(blank=True, default='')),
                ('status', models.CharField(
                    choices=[
                        ('open', 'Open'),
                        ('in_progress', 'In Progress'),
                        ('resolved', 'Resolved'),
                        ('closed', 'Closed'),
                    ],
                    db_index=True, default='open', max_length=12,
                )),
                ('severity', models.CharField(
                    choices=[
                        ('low', 'Low'),
                        ('medium', 'Medium'),
                        ('high', 'High'),
                        ('critical', 'Critical'),
                    ],
                    default='medium', max_length=10,
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('site', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name='issues', to='core.site',
                )),
                ('sector', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='issues', to='core.sector',
                )),
                ('assignee', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='assigned_issues', to=settings.AUTH_USER_MODEL,
                )),
                ('created_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='created_issues', to=settings.AUTH_USER_MODEL,
                )),
                ('resolved_by_activity', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='resolved_issues', to='core.optimizationactivity',
                )),
            ],
            options={
                'db_table': 'v2_issues',
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['site'], name='v2_issues_site_id_639982_idx')],
            },
        ),
    ]
