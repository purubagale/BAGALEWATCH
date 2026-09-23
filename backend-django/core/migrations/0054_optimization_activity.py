# OptimizationActivity / OptimizationActivitySession (2026-09-12) --
# "record that a set of DriveTestSession rows belong together as one
# optimization effort" (before drive -> change -> after drive, sometimes
# several rounds). See both models' docstrings in core/models.py for the
# full reasoning; this migration is a plain two-table CreateModel, no
# data migration needed since nothing previously recorded this
# relationship at all.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0053_drivetestsession_remarks'),
    ]

    operations = [
        migrations.CreateModel(
            name='OptimizationActivity',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=255)),
                ('notes', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_optimization_activities',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='OptimizationActivitySession',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('role', models.CharField(choices=[
                    ('baseline', 'Baseline (pre)'),
                    ('after_change', 'After Change'),
                    ('re_verify', 'Re-verify'),
                ], max_length=12)),
                ('note', models.TextField(blank=True, default='')),
                ('linked_at', models.DateTimeField(auto_now_add=True)),
                ('activity', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='session_links', to='core.optimizationactivity',
                )),
                ('session', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='activity_links', to='core.drivetestsession',
                )),
            ],
            options={
                'db_table': 'v2_optimization_activity_sessions',
                'ordering': ['linked_at'],
                'unique_together': {('activity', 'session')},
            },
        ),
    ]
