# Migrating BAGALEWATCH BTS v2 to a LAN server (Windows)

Same goal as `docs/SERVER_MIGRATION.md` (move the whole Docker Compose
stack — Postgres, Redis, Django, the Node gateway, the Go worker, the
React frontend — onto your old server, give it a fixed private IP, let
people on the same network reach it at `http://<that-ip>:5180` with all
of today's data intact) — this version is for a server that runs
**Windows** instead of Linux. Read the caveat in step 0 before you start;
it affects whether Windows is really the right choice for an always-on
server versus Linux.

---

## 0. One real caveat before you commit to Windows for this

Docker on Windows normally runs through **Docker Desktop**, which is
designed around an interactive desktop session — historically it needs
a user logged in for its background service to keep running containers
alive (newer versions support running without an active session in some
configurations, but this isn't as bulletproof as Linux's `dockerd`,
which is a true background service with no login required at all).

Practically, that means: if this server is meant to sit in a corner and
just run 24/7 unattended, set the Windows account to **auto-login on
boot** (step 10) and make sure Docker Desktop is set to start
automatically with it — otherwise a reboot (power outage, Windows
Update) can leave the containers not running until someone physically
logs in. If you have any choice in the matter, Linux (see the other
guide) is the more "just works as a server" option for genuinely
unattended uptime. If Windows is what you have, this is completely
workable — just budget for that one gotcha.

---

## 1. Prerequisites on the server

Install **Docker Desktop for Windows**
(https://www.docker.com/products/docker-desktop/) with the **WSL2**
backend (the installer defaults to this on modern Windows 10/11 — accept
it; it's faster and more compatible than the older Hyper-V backend).
Requires virtualization enabled in the BIOS, which most "old but
powerful" hardware already has — Docker Desktop's installer will tell
you plainly if it's off.

After installing, open PowerShell and confirm:

```powershell
docker --version
docker compose version
```

Docker Desktop must actually be **running** (check the system tray icon)
before any `docker` command works — unlike Linux, there's a GUI
application in the loop.

---

## 2. Give the server a fixed private IP

**Recommended: a DHCP reservation on your router** — log into your
router's admin page, find the DHCP client list, locate this server by
its MAC address (see `ipconfig /all` on the server for `Physical
Address`), and set a reservation. Far less error-prone than static IP
config on the machine itself, and survives a Windows reinstall.

If you'd rather set it directly on the server:

1. Settings → Network & Internet → Ethernet (or Wi-Fi) → click your
   active connection → **Edit** next to "IP assignment" → **Manual** →
   turn on IPv4.
2. Fill in an IP address outside your router's DHCP range (check the
   router's DHCP settings for the range it hands out automatically),
   the subnet mask (usually `255.255.255.0`), the gateway (your
   router's IP), and a DNS server (`1.1.1.1` works fine).

Or via PowerShell (run as Administrator):

```powershell
Get-NetAdapter                      # find your adapter's Name, e.g. "Ethernet"
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.1.50 -PrefixLength 24 -DefaultGateway 192.168.1.1
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses 1.1.1.1,8.8.8.8
```

Confirm it stuck: `ipconfig` should list the new address.

---

## 3. Get the project onto the server

You want a **plain file copy**, not a fresh `git clone` — a clone would
skip anything covered by `.gitignore`, which includes
`backend-django/media/` (your uploaded menu icons and branding logo) and
every `.env` file (your real secrets). A straight copy brings everything.

From this current machine, copy the whole `bagalewatch-v2` folder
**and** the `bagalewatch.db` file that sits one level above it —
`docker-compose.yml`'s `django` service expects it at
`../bagalewatch.db` relative to itself; without it Docker may refuse to
start that service even though nothing actively re-reads it after the
initial legacy-data seed you already ran.

```
BAGALEWATCH BTS RAN O&M MANAGEMENT\
├── bagalewatch.db          ← include this
└── bagalewatch-v2\         ← and this whole folder
```

Before copying, it's worth excluding `backend-django\venv\`,
`frontend-react\node_modules\`, and `frontend-react\dist\` — Docker
reinstalls all of that fresh inside the containers during
`docker compose up --build` regardless, so copying them across just
wastes time (these folders can be gigabytes; everything else in the
repo is a few MB).

Easiest options for getting it onto the server, roughly easiest-to-set-up
first:

- **A USB drive.** Works with zero setup either machine. Fine for a
  one-time migration.
- **A Windows network share (SMB).** On the server: right-click a folder
  → Properties → Sharing → Share..., grant your user access. From this
  machine, `\\192.168.1.50\ShareName` in File Explorer's address bar, then
  drag-and-drop.
- **`scp` over SSH**, if you want it scriptable/repeatable: enable the
  optional **OpenSSH Server** feature on the Windows server first
  (Settings → Apps → Optional Features → Add a feature → "OpenSSH
  Server"), then from this machine:

  ```powershell
  scp -r "bagalewatch-v2" "bagalewatch.db" youruser@192.168.1.50:C:\bagalewatch\
  ```

---

## 4. Bring your current database over

Postgres data lives in a Docker-managed volume on THIS machine, not as
plain files you can copy — dump it to a portable `.sql` file instead.

**On this machine**, with the stack currently running (PowerShell):

```powershell
docker compose exec -T db pg_dump -U bagalewatch -d bagalewatch_v2 > bagalewatch_v2_backup.sql
```

Copy `bagalewatch_v2_backup.sql` to the server using whichever method
you used in step 3 (USB / share / `scp`).

**On the server**, start just the database first so it initializes an
empty schema, then load your real data into it:

```powershell
cd C:\bagalewatch\bagalewatch-v2
docker compose up -d db
# wait ~10s for it to become healthy
Get-Content ..\bagalewatch_v2_backup.sql | docker compose exec -T db psql -U bagalewatch -d bagalewatch_v2
```

(`Get-Content ... | docker compose exec -T ...` is PowerShell's
equivalent of bash's `< file` input redirection into a command.)

Your uploaded menu icons/branding logo already came along for free in
step 3 (they're real files under `backend-django\media\`, and that
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
`http://192.168.1.50:5180` for everything. Leave `frontend-react\.env`
and the root `.env` blank as shipped — do NOT set `VITE_DJANGO_API_URL`/
`VITE_NODE_GATEWAY_URL` unless you have a genuinely unusual setup (see
`frontend-react\.env`'s own comment).

**The backend does still need to accept the Host header your friends'
browsers will send** (the server's real IP, not "localhost"). Edit
`backend-django\.env` on the server:

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

`backend-node\.env`'s `CORS_ALLOWED_ORIGIN` is unaffected by this pass —
leave it as `http://192.168.1.50:5180`.

(Replace `192.168.1.50` everywhere above with whatever IP you actually
assigned in step 2.)

---

## 6. Build and start everything

```powershell
cd C:\bagalewatch\bagalewatch-v2
docker compose up --build -d
docker compose ps
```

All six services should show `healthy` or `running` within a minute or
so. `docker compose logs -f django` if anything looks stuck.

---

## 7. Open Windows Firewall — but only the one port people actually need

**Updated 2026-08-10** — this got shorter too. Since the 2026-08-10
port-hiding pass, django/node-gateway/go-worker no longer publish host
ports at all (they're reachable only from inside the Docker network), so
there is genuinely nothing listening on 8000/8090/8070 for a firewall
rule to matter for. Only `5180` (the `frontend`/nginx container) is
published:

PowerShell, run as Administrator:

```powershell
New-NetFirewallRule -DisplayName "BAGALEWATCH frontend" -Direction Inbound -LocalPort 5180 -Protocol TCP -Action Allow
```

Deliberately **not** opening 5432 (Postgres) or 6379 (Redis) — nothing
outside the server needs to reach those directly, and their `ports:`
publishing was already removed from `docker-compose.yml` entirely (a
bare host-port publish would have made your database reachable by
anyone on the LAN with the password sitting in `.env`). 8000/8090/8070
are the same situation now — not publishing the port is a stronger
guarantee than a firewall rule, since there's no host-side listener to
reach even from the server itself over anything but Docker's internal
network.

If Docker Desktop's WSL2 backend prompted you with its own separate
Windows Defender Firewall network-profile question the first time you
ran it (common on install), make sure that prompt was allowed too — it
governs whether WSL2's virtual network can accept inbound LAN traffic at
all, on top of the per-port rules above.

---

## 8. Test it

From the server itself first (PowerShell; updated 2026-08-10 —
`8000`/`8090` are no longer published to the host, so go through the
nginx proxy on `5180` instead, or use `docker compose exec` for a direct
container-internal check):

```powershell
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

Every service in `docker-compose.yml` already has `restart:
unless-stopped`, so once Docker Desktop itself is running, the whole
stack comes back on its own. Getting Docker Desktop itself running
without anyone physically present is the Windows-specific part (see the
step 0 caveat):

1. **Docker Desktop → Settings → General → "Start Docker Desktop when you
   log in"** — turn this on.
2. **Set the Windows account to auto-login** so a reboot doesn't sit at
   the lock screen waiting for a password. Run as Administrator:

   ```powershell
   # Prompts for and securely stores the password for auto-login
   netplwiz
   # In the dialog: uncheck "Users must enter a password...", select
   # the account, click OK, enter the password when prompted.
   ```

Test it for real — `Restart-Computer`, wait, then repeat step 8 — rather
than assuming it'll come back on its own.

---

## Troubleshooting

**Friends can open the page but login/search/everything else fails
silently or shows a network error** — almost always step 5 wasn't
applied to ALL of the listed files, or the frontend wasn't rebuilt after
editing them (`VITE_*` vars are compiled in — a config-only restart
won't pick up a change, you need `docker compose up --build frontend`
again).

**"Bad Request (400)" from Django** — `ALLOWED_HOSTS` in
`backend-django\.env` doesn't include the server's IP; re-check step 5
and restart the django container.

**CORS errors in the browser console** — `CORS_ALLOWED_ORIGINS` (Django)
or `CORS_ALLOWED_ORIGIN` (Node gateway) doesn't match the exact origin
(scheme + IP + port) the browser is actually loading the frontend from.

**`docker compose up` fails immediately on the django service** — check
that `bagalewatch.db` actually made it to `..\bagalewatch.db` relative to
`bagalewatch-v2\` on the server (step 3); that bind mount source must
exist even though nothing routinely reads it after the initial legacy
data seed.

**Everything was working, then a reboot broke it** — this is the step 0
caveat in practice; check Docker Desktop is actually running (system
tray icon) and that the account auto-logged in, then `docker compose ps`
to see what state the containers are in.
