#!/usr/bin/env bash
# Render ONE flattened docker-compose.yml for a deploy host (2026-08-23).
#
# WHY
# This repo's compose is a chain: docker-compose.yml + remote-db + deploy,
# activated by COMPOSE_FILE in .env. That chain is right for a dev machine,
# where each override is a switch you flip. On a deploy host it is three
# files, a separator-ordered env var, and no way to see the effective config
# without running compose — so a deploy host gets one rendered file instead.
#
# WHAT IT GUARANTEES
# `--no-interpolate` keeps every ${VAR} unresolved. Without it, `config`
# would substitute values from .env and bake SECRET_KEY, the Postgres
# password and the Keycloak client secret into a file that then gets scp'd
# around. Check any regenerated output for a literal secret before copying.
#
# `--no-path-resolution` keeps bind mounts relative (./data/media), instead
# of rewriting them to this machine's absolute /mnt/d/... paths.
#
# `name:` is forced to $PROJECT_NAME because `config` derives it from the
# checkout's directory name (dt-watch), while the deploy host's containers
# are named after its own directory (dtwatch). A mismatch does not error —
# it silently starts a SECOND stack alongside the running one. The default
# network's generated name (networks.default.name) carries the same stale
# prefix and is rewritten for the same reason.
#
# USAGE
#   scripts/render-deploy-compose.sh [OUTPUT]        # default: stdout
#   PROJECT_NAME=dtwatch scripts/render-deploy-compose.sh out.yml
#
# The result is a build artifact, not a source file: regenerate it rather
# than editing it, and keep edits in docker-compose*.yml here.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT_NAME="${PROJECT_NAME:-dtwatch}"
OUT="${1:-/dev/stdout}"

# Explicit -f list, deliberately ignoring COMPOSE_FILE from .env: this
# machine's chain may include docker-compose.shared-redis.yml, which points
# redis at a container that exists only here.
rendered=$(docker compose \
  -f docker-compose.yml \
  -f docker-compose.remote-db.yml \
  -f docker-compose.deploy.yml \
  --env-file .env \
  config --no-interpolate --no-path-resolution)

# Force the project name and the derived default-network name (see above).
rendered=$(printf '%s\n' "$rendered" \
  | sed -E "0,/^name: /s|^name: .*|name: ${PROJECT_NAME}|" \
  | sed -E "s|^( +)name: .*_default$|\1name: ${PROJECT_NAME}_default|")
for expected in "^name: ${PROJECT_NAME}$" "^ +name: ${PROJECT_NAME}_default$"; do
  grep -Eq "$expected" <<<"$rendered" || {
    echo "render-deploy-compose: rendered output has no line matching $expected" >&2
    exit 1
  }
done

{
  echo "# GENERATED FILE — do not edit."
  echo "#"
  echo "# scripts/render-deploy-compose.sh flattened this out of dt-watch's"
  echo "# docker-compose.yml + docker-compose.remote-db.yml +"
  echo "# docker-compose.deploy.yml. Edit those and re-render; edits made here"
  echo "# are lost on the next deploy."
  echo "#"
  echo "# Source commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "#   on branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "#"
  echo "# Every value still comes from .env next to this file — nothing is"
  echo "# inlined. IMAGE_TAG and POSTGRES_HOST have no default and will fail"
  echo "# loudly if unset."
  echo ""
  printf '%s\n' "$rendered"
} > "$OUT"
