#!/bin/sh
# Runs on every container start. `migrate` is idempotent (Django tracks
# applied migrations in django_migrations) so it's safe to run every time,
# not just once — this is what was missing before: the Dockerfile jumped
# straight to gunicorn with no schema ever created in Postgres, so every
# query 500'd with "relation ... does not exist" (found 2026-07-27, when
# browser login was tested against the container for the first time —
# curl/Invoke-RestMethod testing up to that point only ever exercised the
# local SQLite dev server, not this container).
#
# Seeding real data (seed_legacy_data) is deliberately NOT run here — it's
# a one-time, explicit action the user runs themselves via `docker compose
# exec django python manage.py seed_legacy_data ...`, same as the local
# dev workflow. Auto-seeding on every container restart would re-run
# against a database that already has data and fail on the primary-key
# collision (by design — see seed_legacy_data.py's docstring).
set -e
python manage.py migrate --noinput
exec "$@"
