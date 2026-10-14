# 50 m squares of drive-test readings for Explore's wide searches
# (2026-10-14, core/dt_plot_squares.py). Builds the squares of every stored
# session once; later sessions are built when first searched.
import django.contrib.gis.db.models.fields
import django.db.models.deletion
from django.db import migrations, models

CELLS_PER_DEGREE = 111_000.0 / 50

BUILD_SQL = f"""
    INSERT INTO v2_dt_plot_squares
        (session_id, sx, sy, lat, lng, location, n,
         rsrp_min, rsrp_max, rsrp_avg, rsrq_min, rsrq_avg, sinr_min, sinr_avg, dl_min, dl_avg,
         cqi_min, cqi_avg, rscp_min, rscp_avg, ecno_min, ecno_avg, rx_qual_max, rx_qual_avg, rep_id)
    SELECT session_id, sx, sy, avg(lat), avg(lng),
           ST_SetSRID(ST_MakePoint(avg(lng), avg(lat)), 4326)::geography, count(*),
           min(rsrp), max(rsrp), avg(rsrp), min(rsrq), avg(rsrq), min(sinr), avg(sinr), min(dl), avg(dl),
           min(cqi), avg(cqi), min(rscp), avg(rscp), min(ecno), avg(ecno), max(rx_qual), avg(rx_qual),
           (array_agg(id ORDER BY COALESCE(rscp, rsrp) ASC NULLS LAST, id))[1]
    FROM (SELECT *, floor(lat * {CELLS_PER_DEGREE})::int AS sx, floor(lng * {CELLS_PER_DEGREE})::int AS sy
          FROM v2_dt_samples
          WHERE session_id = ANY(%s) AND lat IS NOT NULL AND lng IS NOT NULL) s
    GROUP BY session_id, sx, sy
"""


def build(apps, schema_editor):
    Session = apps.get_model('core', 'DriveTestSession')
    ids = list(Session.objects.values_list('id', flat=True))
    with schema_editor.connection.cursor() as cursor:
        for i in range(0, len(ids), 20):
            cursor.execute(BUILD_SQL, [ids[i:i + 20]])
    Session.objects.update(plot_squares_stale=False)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0129_problem_report'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsession',
            name='plot_squares_stale',
            field=models.BooleanField(default=True),
        ),
        migrations.CreateModel(
            name='DtPlotSquare',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('sx', models.IntegerField()),
                ('sy', models.IntegerField()),
                ('lat', models.FloatField()),
                ('lng', models.FloatField()),
                ('location', django.contrib.gis.db.models.fields.PointField(geography=True, srid=4326)),
                ('n', models.IntegerField()),
                ('rsrp_min', models.FloatField(blank=True, null=True)),
                ('rsrp_max', models.FloatField(blank=True, null=True)),
                ('rsrp_avg', models.FloatField(blank=True, null=True)),
                ('rsrq_min', models.FloatField(blank=True, null=True)),
                ('rsrq_avg', models.FloatField(blank=True, null=True)),
                ('sinr_min', models.FloatField(blank=True, null=True)),
                ('sinr_avg', models.FloatField(blank=True, null=True)),
                ('dl_min', models.FloatField(blank=True, null=True)),
                ('dl_avg', models.FloatField(blank=True, null=True)),
                ('cqi_min', models.FloatField(blank=True, null=True)),
                ('cqi_avg', models.FloatField(blank=True, null=True)),
                ('rscp_min', models.FloatField(blank=True, null=True)),
                ('rscp_avg', models.FloatField(blank=True, null=True)),
                ('ecno_min', models.FloatField(blank=True, null=True)),
                ('ecno_avg', models.FloatField(blank=True, null=True)),
                ('rx_qual_max', models.FloatField(blank=True, null=True)),
                ('rx_qual_avg', models.FloatField(blank=True, null=True)),
                ('rep_id', models.BigIntegerField()),
                ('session', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='plot_squares', to='core.drivetestsession')),
            ],
            options={
                'db_table': 'v2_dt_plot_squares',
                'indexes': [models.Index(fields=['session'], name='v2_dt_plotsq_session_idx')],
            },
        ),
        migrations.RunPython(build, migrations.RunPython.noop),
    ]
