# Auto-generated (2026-10-01) -- new schema for the multi-role RBAC
# feature (Manage Roles / Assign Roles / dynamic Permission Matrix / Menu
# Visibility). See Role/MenuItemRoleVisibility's own docstrings in
# core/models.py, and User.roles' comment there, for the full design --
# `User.role` itself is deliberately untouched by this migration (no
# RemoveField/AlterField on it anywhere in this file): it stays a real,
# persisted column kept in sync with the new `roles` M2M by a signal
# receiver, not replaced. 0077-0079 (separate migrations) seed the 4
# builtin Role rows, backfill every existing user's single role into
# this M2M, and seed the 3 new MenuItem rows for the new admin pages.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0075_seed_access_log_menuitem'),
    ]

    operations = [
        migrations.CreateModel(
            name='Role',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=20, unique=True)),
                ('label', models.CharField(max_length=50)),
                ('description', models.TextField(blank=True, default='')),
                ('is_builtin', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'v2_roles',
                'ordering': ['name'],
            },
        ),
        migrations.AddField(
            model_name='user',
            name='roles',
            field=models.ManyToManyField(blank=True, related_name='users', to='core.role'),
        ),
        migrations.CreateModel(
            name='MenuItemRoleVisibility',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('visible', models.BooleanField()),
                ('menu_item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='role_visibility', to='core.menuitem')),
                ('role', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='menu_visibility', to='core.role')),
            ],
            options={
                'db_table': 'v2_menu_item_role_visibility',
                'constraints': [models.UniqueConstraint(fields=('menu_item', 'role'), name='uniq_menu_item_role_visibility')],
            },
        ),
    ]
