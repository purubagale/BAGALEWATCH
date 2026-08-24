#!/usr/bin/env bash
#
# build-push.sh — Build, tag, and push the four DT-WATCH v2
# images to Nexus.
#
# Deliberately the same shape as dutychart/build-push.sh and
# pms/nt-pms/build-push.sh: same positional arguments, same branch-derived
# version suffix, same immutable tag format, same registry cache, same
# parallel builds, same env-var switches. The only structural difference is
# that dt-watch has FOUR build contexts instead of two.
#
# Usage Examples:
#   Interactive mode (prompts for version, suggesting latest tag + bump):
#     ./build-push.sh
#   Direct version mode (no prompt):
#     ./build-push.sh v1.0.0
#   Custom registry and namespace:
#     ./build-push.sh v1.0.0 nexus.ntc.net.np dtwatch
#   One component only (skips the other three):
#     ONLY=frontend ./build-push.sh v1.0.0
#
# Positional arguments (all optional):
#   [1] VERSION      - vX.Y.Z (interactive prompt when omitted)
#   [2] REGISTRY     - Nexus Docker registry (default: nexus.ntc.net.np)
#   [3] PROJECT_NAME - Project namespace (default: dtwatch)
#   [4] BUMP_TYPE    - major, minor, or bugfix (default: bugfix) — only used
#                      to compute the suggested version in interactive mode
#
# Branch convention: the current git branch decides the version suffix.
#   - `main`            -> clean release version (e.g. v1.2.0), tagged `latest`
#   - any other branch  -> `-dev` is enforced (e.g. v1.2.0-dev), never `latest`
#   Enforced regardless of whether VERSION came from the prompt or from $1.
#
# Builds and pushes FOUR components. Directory -> image name:
#   backend-django/  -> $REGISTRY/$PROJECT_NAME/django
#   backend-node/    -> $REGISTRY/$PROJECT_NAME/node-gateway
#   backend-go/      -> $REGISTRY/$PROJECT_NAME/go-worker
#   frontend-react/  -> $REGISTRY/$PROJECT_NAME/frontend
#
# Tags pushed to Nexus:
#   - Versioned:  <image>:$VERSION
#   - Immutable:  <image>:$VERSION-BUILDNO-NPTTIME-GITSHA  (identical across
#                 all four — one build, one correlatable tag)
#   - Latest:     <image>:latest (skipped for prerelease versions, and when
#                 NO_LATEST=1)
#
# Environment:
#   PLATFORMS      target platform(s), default linux/amd64
#   ONLY           build one component (django|node-gateway|go-worker|frontend)
#   NO_LATEST=1    never tag `latest`
#   NEXUS_USER / NEXUS_PASSWORD   non-interactive docker login
#   SKIP_LOGIN=1 / SKIP_GIT_TAG=1 / FORCE_GIT_TAG=1 / PUSH_GIT_TAG=y|n
#
# FRONTEND BUILD ARGS (2026-08-23). This block used to say build args do not
# work here, and it was right at the time: frontend-react/Dockerfile declared
# no `ARG`, so every --build-arg was silently discarded — a bug that shipped
# once and is documented in docker-compose.yml's `frontend` comment. The
# Dockerfile now declares ARG VITE_APP_VERSION / VITE_BUILD_TAG /
# VITE_GIT_SHA, so the version below really is baked into the bundle.
#
# Only the frontend needs them: Vite inlines VITE_* at build time, whereas
# Django reads APP_VERSION from its environment at runtime, so the backend
# image stays version-agnostic and the same image can be re-tagged.
#
# VITE_DJANGO_API_URL / VITE_NODE_GATEWAY_URL are still NOT passed — they
# remain blank on purpose (same-origin through nginx). Set them in
# frontend-react/.env if a build ever needs them.
#
set -euo pipefail

cd "$(dirname "$0")"

# Registry credentials only — never `set -a; source .env`. This stack's .env
# holds SECRET_KEY and the Postgres password, and sourcing it would export
# both into every child `docker buildx build`, i.e. into build environments
# with no business seeing them. Read exactly the keys needed. (dutychart's
# script carries the same note — it used to export everything.)
for env_file in .env.prod .env; do
  [[ -f "$env_file" ]] || continue
  for key in NEXUS_USER NEXUS_PASSWORD; do
    [[ -n "${!key:-}" ]] && continue
    value=$(grep -E "^[[:space:]]*${key}=" "$env_file" | tail -n1 | cut -d= -f2- || true)
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [[ -n "$value" ]] && export "$key=$value"
  done
done

DEFAULT_VERSION="v0.0.0"
DEFAULT_REGISTRY="nexus.ntc.net.np"
DEFAULT_PROJECT_NAME="dtwatch"
DEFAULT_PLATFORMS="linux/amd64"

REGISTRY="${2:-$DEFAULT_REGISTRY}"
PROJECT_NAME="${3:-$DEFAULT_PROJECT_NAME}"
PLATFORMS="${PLATFORMS:-$DEFAULT_PLATFORMS}"

# dir:image — the two differ for every component here (backend-django ->
# django, frontend-react -> frontend), so keep them paired explicitly rather
# than deriving one from the other with string surgery.
COMPONENTS=(
  "backend-django:django"
  "backend-node:node-gateway"
  "backend-go:go-worker"
  "frontend-react:frontend"
)

if [[ -n "${ONLY:-}" ]]; then
  filtered=()
  for entry in "${COMPONENTS[@]}"; do
    [[ "${entry#*:}" == "$ONLY" ]] && filtered+=("$entry")
  done
  if [[ ${#filtered[@]} -eq 0 ]]; then
    echo "Error: ONLY='$ONLY' matches no component. Valid: django node-gateway go-worker frontend" >&2
    exit 1
  fi
  COMPONENTS=("${filtered[@]}")
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ "$CURRENT_BRANCH" == "main" ]]; then
  BRANCH_SUFFIX=""
else
  BRANCH_SUFFIX="-dev"
fi

prompt_with_default() {
  local prompt_text="$1"
  local default_value="$2"
  local input_value
  read -r -p "$prompt_text [$default_value]: " input_value
  if [[ -z "$input_value" ]]; then
    echo "$default_value"
  else
    echo "$input_value"
  fi
}

VERSION="${1:-}"
BUMP_TYPE="${4:-bugfix}"

# Interactive mode if no version given
if [[ -z "$VERSION" ]]; then
  LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -n1)
  [[ -z "$LATEST_TAG" ]] && LATEST_TAG="$DEFAULT_VERSION"
  echo "Latest version: $LATEST_TAG"
  echo "Building from branch: ${CURRENT_BRANCH:-unknown}${BRANCH_SUFFIX:+ (will suffix $BRANCH_SUFFIX)}"

  MAJOR=$(echo "$LATEST_TAG" | sed -E 's/^v?([0-9]+)\.[0-9]+\.[0-9]+.*/\1/')
  MINOR=$(echo "$LATEST_TAG" | sed -E 's/^v?[0-9]+\.([0-9]+)\.[0-9]+.*/\1/')
  PATCH=$(echo "$LATEST_TAG" | sed -E 's/^v?[0-9]+\.[0-9]+\.([0-9]+).*/\1/')

  [[ ! "$MAJOR" =~ ^[0-9]+$ ]] && MAJOR=1
  [[ ! "$MINOR" =~ ^[0-9]+$ ]] && MINOR=0
  [[ ! "$PATCH" =~ ^[0-9]+$ ]] && PATCH=0

  if [[ "$BUMP_TYPE" == "major" ]]; then
    SUGGESTED_VER="v$((MAJOR+1)).0.0"
  elif [[ "$BUMP_TYPE" == "minor" ]]; then
    SUGGESTED_VER="v${MAJOR}.$((MINOR+1)).0"
  else
    SUGGESTED_VER="v${MAJOR}.${MINOR}.$((PATCH+1))"
  fi
  SUGGESTED_VER="${SUGGESTED_VER}${BRANCH_SUFFIX}"

  VERSION=$(prompt_with_default "Enter image version" "$SUGGESTED_VER")
fi

# Enforce the branch's version convention however VERSION arrived.
if [[ "$CURRENT_BRANCH" == "main" && "$VERSION" == *-dev ]]; then
  echo "Error: refusing to build a '-dev' version ($VERSION) from main. main only produces release images." >&2
  exit 1
elif [[ "$CURRENT_BRANCH" != "main" && "$VERSION" != *-dev ]]; then
  VERSION="${VERSION}-dev"
  echo "Non-main branch (${CURRENT_BRANCH:-unknown}) — appending -dev: $VERSION"
fi

if [[ ! "$VERSION" =~ ^(v|release\.)?[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[A-Za-z0-9.]+)?$ ]]; then
  echo "Error: VERSION must look like v1.0.0, v1.0.0.1, or v1.0.1-rc1"
  exit 1
fi

# Git-tag real releases only (main). Dev builds stay fully traceable through
# the immutable image tag, which embeds the commit sha — tagging every dev
# build would just clutter `git tag --list` with entries nobody checks out
# again. FORCE_GIT_TAG=1 overrides.
if [[ "$CURRENT_BRANCH" != "main" && "${FORCE_GIT_TAG:-}" != "1" ]]; then
  echo "Skipping git tag: non-release branch (${CURRENT_BRANCH:-unknown}). Set FORCE_GIT_TAG=1 to override."
elif ! git tag --list | grep -q "^$VERSION$"; then
  if [[ "${SKIP_GIT_TAG:-}" != "1" ]]; then
    git tag "$VERSION"
    PUSH_TAG="${PUSH_GIT_TAG:-n}"
    if [[ -t 0 && -z "${PUSH_GIT_TAG:-}" ]]; then
      read -r -p "Push git tag $VERSION to origin now? (y/N): " PUSH_TAG
    fi
    if [[ "$PUSH_TAG" =~ ^[Yy]$ ]]; then
      git push origin "$VERSION"
    fi
  fi
fi

# Docker login once, not once per component.
if [[ "${SKIP_LOGIN:-}" != "1" ]]; then
  if [[ -n "${NEXUS_USER:-}" && -n "${NEXUS_PASSWORD:-}" ]]; then
    echo "$NEXUS_PASSWORD" | docker login "$REGISTRY" -u "$NEXUS_USER" --password-stdin
  else
    docker login "$REGISTRY"
  fi
fi

# Build metadata computed ONCE, before any build, so all four images share an
# identical immutable tag and can be correlated as a single release. Computed
# per component instead, a second boundary mid-build yields tags that no
# longer look like one build.
BUILD_NO="${BUILD_NO:-$(date +%s)}"
NPTTIME=$(TZ=Asia/Kathmandu date +%Y%m%d%H%M%S)
GITSHA=$(git rev-parse --short HEAD)
IMMUTABLE_TAG="$VERSION-$BUILD_NO-$NPTTIME-$GITSHA"

TAG_LATEST=0
if [[ ! "$VERSION" =~ - && "${NO_LATEST:-}" != "1" ]]; then
  TAG_LATEST=1
fi

# A named builder is required, not optional, on the LXC hosts in this
# workspace: the default builder trips that environment's AppArmor
# restriction on any `RUN` step (see the root CLAUDE.md note). Harmless
# everywhere else.
docker buildx create --name dtwatch-builder --use >/dev/null 2>&1 \
  || docker buildx use dtwatch-builder

# binfmt installs QEMU emulators at the cost of a privileged container plus an
# image pull. Only needed when building for an architecture this host isn't.
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  x86_64) NATIVE_PLATFORM="linux/amd64" ;;
  aarch64|arm64) NATIVE_PLATFORM="linux/arm64" ;;
  *) NATIVE_PLATFORM="" ;;
esac
if [[ "$PLATFORMS" != "$NATIVE_PLATFORM" ]]; then
  echo "Cross-building ($PLATFORMS on $HOST_ARCH) — installing binfmt emulators"
  docker run --privileged --rm tonistiigi/binfmt --install all || true
fi

echo "============================================="
echo " Registry : $REGISTRY/$PROJECT_NAME"
echo " Version  : $VERSION"
echo " Immutable: $IMMUTABLE_TAG"
echo " Platforms: $PLATFORMS"
echo " Tag latest: $([[ $TAG_LATEST == 1 ]] && echo yes || echo no)"
echo "============================================="

# All components build concurrently against a per-image registry cache written
# with mode=max, so intermediate builder stages are reused too, not just the
# final layers. The Go compile and the Vite build are the slow ones here and
# benefit most.
build_component() {
  local dir="${1%%:*}"
  local name="${1#*:}"
  local image="$REGISTRY/$PROJECT_NAME/$name"
  local cache="$image:cache"
  local args=(
    --push
    --platform "$PLATFORMS"
    -t "$image:$VERSION"
    -t "$image:$IMMUTABLE_TAG"
    --cache-from "type=registry,ref=$cache"
    --cache-to "type=registry,ref=$cache,mode=max"
    -f "$dir/Dockerfile"
  )
  [[ $TAG_LATEST == 1 ]] && args+=(-t "$image:latest")
  # Vite inlines these at build time; see the FRONTEND BUILD ARGS note above.
  if [[ $name == frontend ]]; then
    args+=(
      --build-arg "VITE_APP_VERSION=$VERSION"
      --build-arg "VITE_BUILD_TAG=$IMMUTABLE_TAG"
      --build-arg "VITE_GIT_SHA=$GITSHA"
    )
  fi
  docker buildx build "${args[@]}" "./$dir"
}

PIDS=()
NAMES=()
for entry in "${COMPONENTS[@]}"; do
  echo "Starting build: ${entry#*:}"
  build_component "$entry" & PIDS+=($!)
  NAMES+=("${entry#*:}")
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    printf '%-14s pushed\n' "${NAMES[$i]}:"
  else
    printf '%-14s BUILD FAILED\n' "${NAMES[$i]}:" >&2
    FAILED=1
  fi
done
[[ $FAILED == 1 ]] && exit 1

echo "============================================="
echo " Pushed to $REGISTRY/$PROJECT_NAME:"
echo "   :$VERSION"
echo "   :$IMMUTABLE_TAG"
[[ $TAG_LATEST == 1 ]] && echo "   :latest"
echo "============================================="
