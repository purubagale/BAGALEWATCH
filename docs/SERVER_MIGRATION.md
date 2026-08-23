# Migrating DT-WATCH BTS v2 to a LAN server

Goal: move the whole Docker Compose stack (Postgres, Redis, Django, the
Node gateway, the Go worker, the React frontend) off this Windows dev
machine onto your old Linux server, give that server a fixed private IP,
and let people on the same network reach it at `http://<that-ip>:5180`
with all of today's data (users, sites, sectors, uploaded icons/logo)
intact.

Everything below is written for the real files in this repo, not generic
Docker advice — commands reference the actual service names, ports, and
`.env` files that already exist here.

(Server runs Windows instead? See `docs/SERVER_MIGRATION_WINDOWS.md` —
same steps, Docker Desktop + PowerShell + Windows networking instead.)

---

## 0. What you'll end up with

- The server has a fixed IP on your LAN, e.g. `192.168.1.50` (yours will
  differ — pick one your router isn't already handing out via DHCP, or
  better, use a DHCP *reservation*, see step 2).
- Anyone on the same Wi-Fi/LAN opens `http://192.168.1.50:5180` in a
  browser and gets the app, logged out, ready to sign in.
- Your current database (users, sites, sectors, KPIs, menu config,
  uploaded icons/logo) is the SAME data, not a fresh empty install.

---

## 1. Prerequisites on the server

You need SSH access to the Linux server (or a keyboard/monitor on it
directly). Check Docker is installed:

```bash
docker --version
docker compose version
```

If either command isn't found, install Docker Engine + the Compose
plugin (Ubuntu/Debian-family — adjust for your distro):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out and back in for the group change to take effect
```

---

## 2. Give the server a fixed private IP

**Recommended: a DHCP reservation on your router**, not a static IP
configured on the server itself. Log into your router's admin page, find
the DHCP client list, locate this server by its MAC address, and set a
reservation (a fixed IP the router always hands to that MAC). This is
far less error-prone than editing Linux network config by hand, and
survives OS reinstalls.

If you'd rather set it on the server directly (e.g. no router access),
on modern Ubuntu that's netplan:

```bash
ip addr        # find your interface name, e.g. eth0, and current subnet
sudo nano /etc/netplan/00-installer-config.yaml
```

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: no
      addresses: [192.168.1.50/24]
      routes:
        - to: default
          via: 192.168.1.1        # your router's IP
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
```

```bash
sudo netplan apply
```

Pick an IP outside your router's DHCP range (check the router's DHCP
settings for the range it hands out automatically) so it can never be
double-assigned to another device.

Confirm it stuck: `ip addr show` should list the new address.

---

## 3. Get the project onto the server

You want a **plain file copy**, not a fresh `git clone` — a clone would
skip anything covered by `.gitignore`, which includes
`backend-django/media/` (your uploaded menu icons and branding logo) and
every `.env` file (your real secrets). A straight copy brings everything.

From this Windows machine, zip the whole `dt-watch` folder (and,
importantly, the `bagalewatch.db` file that sits one level above it —
`docker-compose.yml`'s `django` service expects it at `../bagalewatch.db`
relative to itself; without it Docker may refuse to start that service
even though nothing actively re-reads it after the initial legacy-data
seed you already ran).

```
DT-WATCH BTS RAN O&M MANAGEMENT/
├── bagalewatch.db          ← include this
└── dt-watch/         ← and this whole folder
```

Before zipping, it's worth excluding `backend-django/venv/`,
`frontend-react/node_modules/`, and `frontend-react/dist/` — Docker
reinstalls all of that fresh inside the containers during
`docker compose up --build` regardless, so shipping them across the
network just wastes time (these folders can be gigabytes; everything
else in the repo is a few MB).

Transfer via `scp` (from a terminal — WSL, Git Bash, or PowerShell with
OpenSSH client installed):

```bash
scp -r "dt-watch" "bagalewatch.db" youruser@192.168.1.50:/home/youruser/dtwatch/
```

(A USB drive works exactly as well if `scp` isn't set up yet.)

> **Before you copy: strip the shared-Redis lines out of `.env`.** This
> Windows dev machine points the stack at a single workspace-wide Redis
> (`d:\Projects\shared-redis`) via three lines at the bottom of `.env` —
> `COMPOSE_PATH_SEPARATOR`, `COMPOSE_FILE`, `SHARED_REDIS_PASSWORD`. Since
> the copy above deliberately includes `.env`, those lines travel to the
> server, where that Redis does not exist. Delete them (and, optionally,
> `docker-compose.shared-redis.yml`) and the server falls back to the
> `redis` service bundled in `docker-compose.yml`, which is what a
> standalone deploy wants. **This fails loudly, not silently** — if you
> forget, the very first `docker compose up` stops immediately with
> `network shared-redis declared as external, but could not be found`, and
> nothing starts. Sharing one Redis across apps is a dev-box convenience;
> on a production host each app should keep its own (see RUNBOOK,
> 2026-08-21).


---

## 4. Bring your current database over

Postgres data lives in a Docker-managed volume on THIS machine, not as
plain files you can copy — dump it to a portable `.sql` file instead.

**On this Windows machine**, with the stack currently running:

```bash
docker compose exec -T db pg_dump -U dtwatch_user -d dtwatch_db > dtwatch_backup.sql
```

Copy that file to the server too:

```bash
scp dtwatch_backup.sql youruser@192.168.1.50:/home/youruser/dtwatch/
```

**On the server**, start just the database first so it initializes an
empty schema, then load your real data into it:

```bash
cd /home/youruser/dtwatch/dt-watch
docker compose up -d db
# wait ~10s for it to become healthy
docker compose exec -T db psql -U dtwatch_user -d dtwatch_db < ../dtwatch_backup.sql
```

Your uploaded menu icons/branding logo already came along for free in
step 3 (they're real files under `backend-django/media/`, and that
folder is bind-mounted into the container — see `docker-compose.yml`'s
comment on that mount).

---

## 5. Point the app at the server's IP, not localhost

**Updated 2026-08-10 (port-hiding / reverse-proxy pass) — this step got
much shorter.** Previously the browser called django (8000) and
node-gateway (8090) directly, so `frontend-react`'s build-time API URLs
had to be hand-set to the server's real IP. That's no longer true: nginx
(the `frontend` container, the only one still publishing a host port)
now proxies `/api/`, `/media/`, and `/admin/` straight to django over
Docker's internal network, so the browser only ever talks to
`http://192.168.1.50:5180` for everything. Leave `frontend-react/.env`
blank as shipped — do NOT set `VITE_DJANGO_API_URL`/
`VITE_NODE_GATEWAY_URL` unless you have a genuinely unusual setup (see
`frontend-react/.env`'s own comment).

**The backend does still need to accept the Host header your friends'
browsers will send** (the server's real IP, not "localhost"). Edit the
root `.env` on the server (as of 2026-08-21 that single file IS the
django/node environment — `backend-django/.env` and `backend-node/.env`
no longer exist):

```
ALLOWED_HOSTS=*
CORS_ALLOWED_ORIGINS=http://192.168.1.50:5180
CSRF_TRUSTED_ORIGINS=http://192.168.1.50:5180
```

`ALLOWED_HOSTS=*` is the shipped default (chosen deliberately for this
internal-only LAN tool, now that django itself is unreachable except
through nginx) — you only need to narrow it if you want an explicit
allowlist instead. `CORS_ALLOWED_ORIGINS` is mostly moot now too (same-
origin requests through nginx never trigger a CORS check) but harmless
to set. `CSRF_TRUSTED_ORIGINS` DOES still matter if you want Django
admin reachable at `http://192.168.1.50:5180/admin/` from another
machine — note the port is now **5180**, not 8000, since that's the only
address that's actually reachable from outside the server.

The node gateway's own singular `CORS_ALLOWED_ORIGIN` (note: no trailing
S — a different var from django's) now lives in that same root `.env`,
and is left unset by default because the code's built-in default is
`http://localhost:5180`. On a LAN server that default is wrong, so add
`CORS_ALLOWED_ORIGIN=http://192.168.1.50:5180` alongside the three lines
above — it only matters once something actually calls the gateway from a
browser, which no frontend code does yet.

(Replace `192.168.1.50` everywhere above with whatever IP you actually
assigned in step 2.)

---

## 6. Build and start everything

```bash
cd /home/youruser/dtwatch/dt-watch
docker compose up --build -d
docker compose ps
```

All six services should show `healthy` or `running` within a minute or
so. `docker compose logs -f django` if anything looks stuck.

---

## 7. Open the firewall — just the one port people actually need

**Updated 2026-08-10** — this got shorter too. Since the 2026-08-10
port-hiding pass, django/node-gateway/go-worker no longer publish host
ports at all (they're reachable only from inside the Docker network),
so there is genuinely nothing listening on 8000/8090/8070 for a firewall
rule to matter for. Only `5180` (the `frontend`/nginx container) is
published:

```bash
sudo ufw allow 5180/tcp   # the app itself — the only port anyone outside the server needs
sudo ufw enable
sudo ufw status
```

Deliberately **not** opening 5432 (Postgres) or 6379 (Redis) — nothing
outside the server needs to reach those directly, and their `ports:`
publishing was already removed from `docker-compose.yml` (a bare
`"5432:5432"` would have made your database reachable by anyone on the
LAN with the password sitting in `.env`, and on Linux a ufw rule alone
doesn't reliably block this — Docker manipulates iptables directly and
commonly bypasses ufw's own rules). 8000/8090/8070 are the same
situation now — not publishing the port is a stronger guarantee than a
firewall rule, since there's no host-side listener to reach even from
the server itself over anything but Docker's internal network.

---

## 8. Test it

From the server itself first (updated 2026-08-10 — `8000`/`8090` are no
longer published to the host, so go through the nginx proxy on `5180`
instead, or use `docker compose exec` for a direct container-internal
check):

```bash
curl http://localhost:5180/api/v2/health/
docker compose exec node-gateway wget -qO- http://localhost:8090/health
```

Then from another machine on the same LAN (your own laptop is a good
first test before involving friends):

```
http://192.168.1.50:5180
```

You should land on the login page with your existing users able to sign
in. Check a site loads, an existing menu icon shows up, etc. — anything
that touches uploaded media or the database is the best proof the
migration actually carried the data over correctly.

---

## 9. Give it to your friends

Just the URL: `http://192.168.1.50:5180` — as long as their device is on
the same LAN/Wi-Fi as the server, that's it. No install, no VPN, nothing
else to configure on their end.

---

## 10. Survives a reboot

Every service in `docker-compose.yml` already has `restart: unless-stopped`,
and Docker itself starts on boot once installed via `get.docker.com`. If
the server loses power and comes back, the whole stack should come back
up on its own — worth actually testing once (`sudo reboot`, wait, then
repeat step 8) rather than assuming.

---

## Troubleshooting

**Friends can open the page but login/search/everything else fails
silently or shows a network error** — almost always step 5 wasn't
applied to ALL of the listed files, or the frontend wasn't rebuilt after
editing them (`VITE_*` vars are compiled in — a config-only restart
won't pick up a change, you need `docker compose up --build frontend`
again).

**"Bad Request (400)" from Django** — `ALLOWED_HOSTS` in the root `.env`
doesn't include the server's IP; re-check step 5
and restart the django container.

**CORS errors in the browser console** — `CORS_ALLOWED_ORIGINS` (Django)
or `CORS_ALLOWED_ORIGIN` (Node gateway) doesn't match the exact origin
(scheme + IP + port) the browser is actually loading the frontend from.

**`docker compose up` fails immediately on the django service** — check
that `bagalewatch.db` actually made it to `../bagalewatch.db` relative to
`dt-watch/` on the server (step 3); that bind mount source must
exist even though nothing routinely reads it after the initial legacy
data seed.
