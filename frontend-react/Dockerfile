# Multi-stage build: compile the Vite app, then serve the static output
# with nginx. Build-time env vars (VITE_DJANGO_API_URL etc.) are baked in
# at build time — see docker-compose.yml build args.
FROM node:22-slim AS build
WORKDIR /app
# .npmrc (legacy-peer-deps=true) MUST be copied before `npm install` — it's
# what makes react-leaflet-cluster@2.1.0's react@^18 peer-dep declaration
# not fail the install even though this project is on react@19 (confirmed
# 2026-07-27: the package's actual runtime code has no React-18-specific
# behavior, this is purely an unmaintained peer-range declaration).
COPY package.json package-lock.json* .npmrc ./
RUN npm install
COPY . .

# Build-time version stamp (2026-08-23). These ARGs are the whole reason a
# --build-arg now takes effect here: Vite only inlines import.meta.env.VITE_*
# values that exist as real environment variables when `npm run build` runs,
# and until these lines existed the Dockerfile declared no ARG at all, so
# every --build-arg passed to it was silently discarded. That exact bug
# shipped once already (see docker-compose.yml's `frontend` comment).
# Defaults keep a plain `docker compose build` honest: it stamps `dev`
# rather than claiming a release version it was not built from.
ARG VITE_APP_VERSION=dev
ARG VITE_BUILD_TAG=
ARG VITE_GIT_SHA=
ENV VITE_APP_VERSION=$VITE_APP_VERSION \
    VITE_BUILD_TAG=$VITE_BUILD_TAG \
    VITE_GIT_SHA=$VITE_GIT_SHA

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
