# Migrating BAGALEWATCH BTS v2 to a LAN server with no internet access

Addendum to `docs/SERVER_MIGRATION.md` (Linux) / `docs/SERVER_MIGRATION_WINDOWS.md`
(Windows). Read this FIRST if the server won't have internet access — it
replaces the "install Docker" and "build and start everything" steps in
those guides with an internet-free path. Everything else in those guides
(fixed IP, `.env` editing, firewall rules, testing, reboot resilience) is
unchanged — you'll be sent back to the relevant step in the main guide
for those.

---

## 0. First: do you have even ONE-TIME internet access?

A normal Docker setup needs the internet exactly twice: once to install
Docker itself, and once per `docker compose up --build` to pull base
images (`postgres`, `redis`, etc.) and run `pip install`/`npm install`
inside the build. It does **not** need internet on every subsequent
start, or ever again after a successful build.

So if the server can get online even briefly and just once — a phone
hotspot for 15 minutes, a temporary Ethernet cable to a router with
internet, anything — the simplest path is: do that, follow
`SERVER_MIGRATION.md` (or the Windows guide) normally, then physically
disconnect it from the internet afterward. Nothing about running the app
day-to-day requires internet; only the initial install/build does.

**If that's genuinely not possible (server is offline permanently, no
way to connect it even once), use the fully offline path below.** The
whole idea: do the "needs internet" parts on your current Windows
machine (which has internet), package the results into files, and carry
those files to the server on a USB drive or LAN copy. The server itself
never touches the internet.

---

## 1. Overview of the offline path

```
Windows dev machine (has internet)          Offline server
──────────────────────────────────          ──────────────
docker compose build      ─┐
docker save (→ .tar files) ├─ USB / LAN ──▶  docker load
pg_dump (→ .sql file)      │   copy      ──▶  psql restore
Docker install packages   ─┘               ─▶  install Docker
                                            ─▶  docker compose up -d (no --build)
```

Follow `SERVER_MIGRATION.md` steps 0–2 first (prerequisites framing,
fixed private IP) — those don't involve internet either way and aren't
repeated here.

---

## 2. On the Windows machine: build the images

From `bagalewatch-v2/` (with your `.env` files already filled in — same
as step 5 of the main guide, but do it now, BEFORE building, since the
frontend bakes its API URLs in at build time):

```bash
# Edit these first (see SERVER_MIGRATION.md step 5 for the exact values —
# use the server's fixed IP from step 2 of that guide, not localhost):
#   bagalewatch-v2/.env
#   backend-django/.env
#   backend-node/.env

docker compose build
```

This is the one command in this whole process that needs internet — it
pulls `postgres:16-alpine`, `redis:7-alpine`, and every OS/pip/npm
package the four custom images need, and bakes the frontend's
`VITE_DJANGO_API_URL`/`VITE_NODE_GATEWAY_URL` in as literal strings in
the compiled JS.

---

## 3. On the Windows machine: export the images to files

Find the exact image names/tags Compose actually built (don't guess —
Compose derives names from your folder name, and it's worth confirming
rather than assuming):

```bash
docker compose config --images
```

You should see six images: `postgres:16-alpine`, `redis:7-alpine`, and
four `bagalewatch-v2-*` images (django, node-gateway, go-worker,
frontend). Save all of them into one portable file:

```bash
docker save -o bagalewatch_images.tar \
  postgres:16-alpine redis:7-alpine \
  bagalewatch-v2-django bagalewatch-v2-node-gateway \
  bagalewatch-v2-go-worker bagalewatch-v2-frontend
```

(Substitute the real names from `docker compose config --images` if
they differ from the ones above.) This file will be several hundred MB
to a couple GB — that's expected, it's every dependency each image
needs, with nothing left to fetch later.

---

## 4. On the Windows machine: dump the database

Same as `SERVER_MIGRATION.md` step 4 — this part was never internet-
dependent:

```bash
docker compose exec -T db pg_dump -U bagalewatch -d bagalewatch_v2 > bagalewatch_v2_backup.sql
```

---

## 5. On the Windows machine: get a Docker install package with no internet needed on the server

This is the other place internet normally gets used — `curl -fsSL
https://get.docker.com | sh` (the command in the main guide) reaches out
to Docker's servers. Two ways around it, pick based on the server's OS:

### Linux server (Ubuntu/Debian) — download the `.deb` packages

Easiest if you have access to any Ubuntu/Debian machine with internet
that's a similar version to the server (a spare laptop, a cloud VM, or
**WSL Ubuntu right here on this Windows machine** all work fine — the
packages aren't tied to a specific physical machine). From that
internet-connected Ubuntu/Debian environment:

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg
echo "deb [signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install --download-only --yes \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir docker-offline-debs
cp /var/cache/apt/archives/*.deb docker-offline-debs/
```

Copy the `docker-offline-debs/` folder to the server later. If the
server's Ubuntu/Debian version doesn't match what you ran this on, the
`.deb`s may not install cleanly — check `lsb_release -cs` matches
(`jammy`, `noble`, etc.) before you transfer.

### Windows server — the Docker Desktop installer is already a single offline-capable file

Unlike the Linux path, this one doesn't need a workaround: download
**Docker Desktop for Windows** from
https://www.docker.com/products/docker-desktop/ once, here, with
internet. The resulting `.exe` is a self-contained installer — running
it on the offline server doesn't reach out to the internet again except
to fetch the WSL2 Linux kernel update if that's not already present. To
avoid needing that too, also download the WSL2 kernel update package
ahead of time from
https://learn.microsoft.com/windows/wsl/install-manual#step-4---download-the-linux-kernel-update-package
and carry both files over together.

---

## 6. Move everything to the server

Via USB drive or a direct LAN copy (see `SERVER_MIGRATION.md`/
`SERVER_MIGRATION_WINDOWS.md` step 3 for transfer mechanics — same idea,
just with more files this time):

```
bagalewatch.db                    ← v1's data, for the legacy-data seed
bagalewatch-v2/                   ← the whole project folder (.env files included)
bagalewatch_images.tar            ← from step 3 above
bagalewatch_v2_backup.sql         ← from step 4 above
docker-offline-debs/              ← Linux only, from step 5
  (or Docker Desktop Installer.exe + the WSL2 kernel update .msi — Windows only)
```

---

## 7. On the server: install Docker offline

**Linux:**

```bash
cd docker-offline-debs
sudo dpkg -i *.deb
sudo usermod -aG docker $USER
# log out and back in
docker --version
docker compose version
```

If `dpkg -i` complains about missing dependencies, it means the
`.deb`s were built for a different Ubuntu/Debian version than this
server is running — go back to step 5 and regenerate them from a
matching version.

**Windows:** run the Docker Desktop installer, then install the WSL2
kernel update package if prompted (same install as normal, just with
both files already sitting on disk instead of being fetched
mid-install).

---

## 8. On the server: load the images and restore the database

```bash
cd bagalewatch-v2
docker load -i ../bagalewatch_images.tar
docker images    # confirm all six are now present locally

docker compose up -d db
# wait ~10s for it to become healthy
docker compose exec -T db psql -U bagalewatch -d bagalewatch_v2 < ../bagalewatch_v2_backup.sql
```

---

## 9. On the server: start everything — WITHOUT `--build`

This is the one command that differs from the main guide. Do **not** run
`docker compose up --build` — that would try to rebuild the images from
scratch, which needs internet and would undo the whole point of this
process. Since you already `docker load`ed images with the exact names
Compose expects, a plain `up -d` reuses them as-is:

```bash
docker compose up -d
docker compose ps
```

All six services should show `healthy` or `running`, same as the main
guide's step 6.

---

## 10. Continue with the main guide

From here everything is identical to `SERVER_MIGRATION.md` (or the
Windows equivalent) — pick up at:

- **Step 7** — firewall rules (only 5180/8000/8090 open, not
  5432/6379/8070)
- **Step 8** — testing from the server itself, then from another LAN
  machine
- **Step 9** — handing the URL to your friends
- **Step 10** — confirming it survives a reboot

---

## 11. Shipping a future update, later

Since `git pull` won't work on the server either, any future code
change means repeating steps 2–3 and 8–9 (rebuild on the Windows
machine → `docker save`/`docker load` the changed images → `docker
compose up -d` again on the server). You don't need to redo the
database dump/restore (step 4/8's db portion) or the Docker install
(step 5/7) — those only happen once. Worth keeping this doc's steps 2–3
as a short script on the Windows machine if updates are frequent, since
it's the same handful of commands every time.

---

## Troubleshooting

**`docker compose up -d` tries to rebuild anyway** — the image names in
your local `docker images` don't exactly match what `docker-compose.yml`
expects. Re-run `docker compose config --images` and compare against
`docker images`; re-`docker save`/`docker load` if they drifted (e.g.
you rebuilt on Windows after the tar was made, so the tags no longer
match).

**`dpkg -i` fails with dependency errors** — the `.deb` packages were
downloaded for the wrong Ubuntu/Debian version. Confirm `lsb_release -cs`
matches between the machine that downloaded them and the server, then
redo step 5.

**Frontend loads but API calls fail** — same root cause as the main
guide's troubleshooting section: the `VITE_*` URLs were baked in before
the server's real IP was known, or `.env` was edited after `docker
compose build` already ran. Fix the `.env` files and repeat steps 2–3 and
8–9 with the corrected values — a config-only change on the server can't
fix this, the frontend image has to be rebuilt.
