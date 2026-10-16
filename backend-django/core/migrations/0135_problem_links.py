# Linked systems (2026-10-15, core/problem_notify.py): the customer's
# number on a problem report a linked NTC system sends, the systems with the
# address to tell about their reports (automatic, manual or off), and the
# log of every update sent.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0134_problem_dashboard'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='problemreport',
            name='msisdn',
            field=models.CharField(blank=True, db_index=True, default='', max_length=20),
        ),
        migrations.CreateModel(
            name='LinkedSystem',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=100, unique=True)),
                ('notify_url', models.URLField(blank=True, default='', max_length=500)),
                ('notify_secret', models.CharField(max_length=64)),
                ('notify_mode', models.CharField(choices=[('auto', 'Automatic'), ('manual', 'Manual'), ('off', 'Off')],
                                                 default='manual', max_length=8)),
                ('is_active', models.BooleanField(default=True)),
                ('note', models.CharField(blank=True, default='', max_length=200)),
                ('last_sent_at', models.DateTimeField(blank=True, null=True)),
                ('last_error', models.CharField(blank=True, default='', max_length=300)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                 related_name='linked_systems_created', to=settings.AUTH_USER_MODEL)),
            ],
            options={'db_table': 'v2_linked_system', 'ordering': ['name']},
        ),
        migrations.CreateModel(
            name='ProblemNotification',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('system', models.CharField(max_length=100)),
                ('event', models.CharField(max_length=16)),
                ('status', models.CharField(choices=[('pending', 'Waiting'), ('sent', 'Sent'), ('failed', 'Failed')],
                                            default='pending', max_length=8)),
                ('attempts', models.PositiveSmallIntegerField(default=0)),
                ('next_try_at', models.DateTimeField(blank=True, null=True)),
                ('response_code', models.SmallIntegerField(blank=True, null=True)),
                ('last_error', models.CharField(blank=True, default='', max_length=300)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('sent_at', models.DateTimeField(blank=True, null=True)),
                ('report', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='notifications',
                                             to='core.problemreport')),
                ('requested_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                   related_name='problem_notifications', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'v2_problem_notification',
                'ordering': ['-created_at'],
                'indexes': [models.Index(fields=['status', 'next_try_at'], name='v2_problem_notify_due_idx')],
            },
        ),
    ]
