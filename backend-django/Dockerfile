FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x entrypoint.sh

EXPOSE 8000

# entrypoint.sh runs `manage.py migrate` before handing off to gunicorn —
# without this, the container starts fine but every DB query 500s because
# Postgres never gets a schema (found 2026-07-27, see entrypoint.sh).
#
# Worker count/threads/timeout moved into gunicorn.conf.py (2026-08-08,
# "100 concurrent users" scaling pass) — was a hardcoded `--workers 3` /
# `--timeout 120` here, replaced with a config file so the worker count
# can be COMPUTED from whatever server this actually runs on (this app
# moves between machines — see docs/SERVER_MIGRATION.md) instead of a
# number that was only ever right for the box it happened to be written
# on. See gunicorn.conf.py's own comment for the full worker-count math
# and the `timeout=120` carried forward unchanged from here.
ENTRYPOINT ["./entrypoint.sh"]
CMD ["gunicorn", "bagalewatch_v2.wsgi:application", "-c", "gunicorn.conf.py"]
