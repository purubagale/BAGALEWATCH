# External data-exchange API (2026-08-12, "add feature to create api to
# share certain data of system to other and to receive certain data from
# other system") — see ApiKey's own docstring in models.py and
# core/api_auth.py's module docstring for the full auth-design reasoning.
#
# Hand-written (sandbox was unavailable to run makemigrations for this
# session) but a plain CreateModel with no guessed index/constraint names
# — unlike the RenameIndex situation memory `feedback_hand_guessed_
# index_names_break_migrate.md` warns about, Django's autodetector always
# derives CreateModel's own shape deterministically from the model
# definition, so there's nothing here that could drift from what
# `makemigrations` would have generated. Field order/options match
# models.py's ApiKey class exactly.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0028_seed_trp_analysis_submenu'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ApiKey',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=100)),
                ('key_prefix', models.CharField(db_index=True, max_length=16, unique=True)),
                ('key_hash', models.CharField(max_length=64)),
                ('scopes', models.JSONField(default=list)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_used_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='api_keys_created', to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'v2_api_keys',
                'ordering': ['-created_at'],
            },
        ),
    ]
