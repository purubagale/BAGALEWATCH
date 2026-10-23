"""Stored reading count per drive-test session, kept by a trigger
(audit 2026-10-23).

The session list counted each session's readings on every request; that
visited every reading's table page (about 250 MB for 918,000 readings) and
took 26 s from a cold cache. `samples_total` is filled here once, then two
statement-level triggers on v2_dt_samples add the readings an INSERT (or
COPY) brings and subtract the ones a DELETE removes, per session, so every
write path keeps it right without application code. Readings are never
moved between sessions, so UPDATE needs no trigger.
"""
from django.db import migrations, models

FORWARD = """
UPDATE v2_dt_sessions s SET samples_total = c.n
FROM (SELECT session_id, count(*) AS n FROM v2_dt_samples GROUP BY session_id) c
WHERE c.session_id = s.id;

CREATE OR REPLACE FUNCTION v2_dt_samples_total_add() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE v2_dt_sessions s SET samples_total = s.samples_total + c.n
    FROM (SELECT session_id, count(*) AS n FROM added GROUP BY session_id) c
    WHERE s.id = c.session_id;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION v2_dt_samples_total_remove() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE v2_dt_sessions s SET samples_total = GREATEST(0, s.samples_total - c.n)
    FROM (SELECT session_id, count(*) AS n FROM removed GROUP BY session_id) c
    WHERE s.id = c.session_id;
    RETURN NULL;
END $$;

CREATE TRIGGER v2_dt_samples_total_add AFTER INSERT ON v2_dt_samples
    REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION v2_dt_samples_total_add();
CREATE TRIGGER v2_dt_samples_total_remove AFTER DELETE ON v2_dt_samples
    REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION v2_dt_samples_total_remove();
"""

BACKWARD = """
DROP TRIGGER IF EXISTS v2_dt_samples_total_add ON v2_dt_samples;
DROP TRIGGER IF EXISTS v2_dt_samples_total_remove ON v2_dt_samples;
DROP FUNCTION IF EXISTS v2_dt_samples_total_add();
DROP FUNCTION IF EXISTS v2_dt_samples_total_remove();
"""


def _run(sql):
    def apply(apps, schema_editor):
        # PostgreSQL only: the SQLite fallback (DJANGO_DB_ENGINE=sqlite) has
        # no plpgsql; there the column simply stays 0.
        if schema_editor.connection.vendor == 'postgresql':
            schema_editor.execute(sql)
    return apply


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0139_collection_session_label'),
    ]

    operations = [
        migrations.AddField(
            model_name='drivetestsession', name='samples_total',
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.RunPython(_run(FORWARD), _run(BACKWARD)),
    ]
