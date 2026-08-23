# Keycloak SSO for DT-WATCH — design

**Date:** 2026-08-23
**Status:** approved, implementation in progress

## Goal

Let staff sign in to DT-WATCH with the existing NTC Keycloak SSO
(`sso.ntc.net.np`, realm `company`), restricted to members of a Keycloak group
`dtwatch`. Local username/password login stays available and is switched off
later by an environment variable, not by deleting code.

## Decisions

Settled with the user before implementation:

| Question | Decision |
|---|---|
| SSO vs local login | **Both.** Local login stays, gated by `LOCAL_LOGIN_ENABLED` (default `True`). SSO-only is reached by setting it to `False` — a config change, not a code change. Deleting local login is explicitly out of scope for this work. |
| Who may log in | Members of the Keycloak group **`dtwatch`**. A dedicated entitlement group, not one of the shared realm groups. |
| Role source | **Keycloak**, re-applied on every login. |
| Role mapping | `superadmin` → `superadmin`, `platform-admins` → `admin`, `viewers` → `viewer`, anything else in `dtwatch` → `viewer`. |
| Account linking | By Keycloak `sub` first; else by username **plus a verified matching email**; else create the account (JIT). A username collision with an *unverified* email is refused, never linked. |
| Hostname | `dtwatch.ntc.net.np`, via hosts-file entries until it is really routed. |

### Why the shared realm groups are not the gate

`platform-admins` / `developers` / `viewers` are realm-wide and already drive
Grafana, GitLab and Rocket.Chat (see `keycloak/CLAUDE.md`). Using them as the
gate would grant DT-WATCH to everyone holding any of them. Entitlement
("may use DT-WATCH") and privilege ("what they can do") are kept separate: the
`dtwatch` group is the gate, the shared groups set the role.

`developers` is deliberately **not** mapped. An earlier draft mapped it to
`superadmin`; the user then created a dedicated `superadmin` group, which
supersedes it. Members of `developers` who are in `dtwatch` land as `viewer`.

## Architecture

OIDC Authorization Code + PKCE, **brokered server-side**. Keycloak
authenticates; DT-WATCH keeps authorization. After validating Keycloak's ID
token the backend mints the app's **own SimpleJWT**, so every existing
consumer — DRF authentication classes, the permissions matrix,
`IsAdminOrSuperadmin`, `client.ts`'s refresh interceptor, `AuthContext` —
keeps working untouched.

This is a port of the same pattern already running in `pms/nt-pms`
(`backend/users/sso.py`, `sso_views.py`, `sso_config.py`) against this same
realm, not a fresh design. Following it means one proven flow in the
organisation rather than two divergent ones.

### Flow

```
Browser            DT-WATCH backend                    Keycloak
   |  GET /api/v2/auth/sso/login/  |                        |
   |------------------------------>|  build authorize URL   |
   |                               |  state+nonce+PKCE      |
   |                               |  -> Redis (TTL)        |
   |  302 + Set-Cookie: sso_state  |                        |
   |<------------------------------|                        |
   |  GET authorize ------------------------------------->  |
   |  (user authenticates, incl. 2FA/OTP if enrolled)       |
   |  302 back to backend callback with ?code&state <-----  |
   |  GET /api/v2/auth/sso/callback/                        |
   |------------------------------>|  state == cookie?      |
   |                               |  pop txn (single use)  |
   |                               |  POST token ------->   |
   |                               |  <------- tokens       |
   |                               |  verify id_token/JWKS  |
   |                               |  gate: dtwatch group   |
   |                               |  map role, link user   |
   |                               |  mint app SimpleJWT    |
   |                               |  one-time code->Redis  |
   |  302 to SPA /sso/callback?code=...                     |
   |<------------------------------|                        |
   |  POST /api/v2/auth/sso/token/ {code}                   |
   |------------------------------>|  GETDEL code           |
   |  {access, refresh, user}      |                        |
   |<------------------------------|                        |
```

The authorization code never reaches the browser, and no token is ever placed
in a URL fragment. The SPA receives only a single-use, short-TTL login code.

### Security properties carried over from the nt-pms implementation

- **PKCE S256** — verified supported by the realm's discovery document.
- **Nonce** bound into the ID token and checked on return.
- **`state` bound to an httponly cookie** (`sso_state`). `state` alone stops
  replay; the cookie is what stops login-CSRF / session fixation.
- **Confidential client** — the client secret lives only server-side.
- **Single-use artifacts** — the OIDC transaction is deleted on read; the login
  code uses Redis `GETDEL` so it is single-use even under concurrent requests.
- **No account enumeration** — every callback failure redirects to the SPA with
  a coarse reason code; specifics go to the server log only.

### Where DT-WATCH deliberately differs from nt-pms

| Aspect | nt-pms | DT-WATCH |
|---|---|---|
| Identity claim | `employee_id` | Keycloak `sub`, then verified email, then username |
| Unknown user | rejected — PMS accounts are admin-created | **created (JIT)** — group membership *is* the entitlement |
| Gate | realm role via `realm_access.roles` | group via the `groups` claim |
| Role | single yes/no `required_role` | tiered mapping to `superadmin`/`admin`/`viewer` |
| Keycloak Admin API | used to provision ERP users into groups | **not ported** — DT-WATCH only consumes identity |

The gate needs no new mechanism: nt-pms resolves the claim through a
configurable dotted path (`_claim_by_path`), so `KEYCLOAK_ROLES_CLAIM=groups`
with `KEYCLOAK_REQUIRED_GROUP=dtwatch` expresses this directly.

### Group path normalisation

Keycloak's group-membership mapper emits either `dtwatch` or `/dtwatch`
depending on whether "full path" is enabled, and nested groups arrive as
`/parent/child`. Matching normalises leading slashes and compares the last
path segment, so either mapper setting works instead of silently denying
everyone.

## Components

New, all under `backend-django/core/`:

- **`sso_config.py`** — every setting behind an accessor function, plus
  `is_configured()`. Mirrors nt-pms so the two are comparable.
- **`sso.py`** — Redis-backed transaction and login-code stores, PKCE, token
  exchange, JWKS-backed ID-token validation, claim extraction, the group gate,
  role mapping, and ID-token retention for RP-initiated logout.
- **`sso_views.py`** — `SSOLoginView`, `SSOCallbackView`, `SSOTokenExchangeView`.
- **`tests_sso.py`** — added to the existing `manage.py test core` suite.

Modified:

- **`core/models.py`** — `User.auth_source` (`local`/`sso`) and
  `User.sso_subject`. One migration.
- **`core/views.py`** — `LoginView` returns 403 when `LOCAL_LOGIN_ENABLED` is
  false; the public branding payload gains `sso_enabled` and
  `local_login_enabled` so the unauthenticated login page can render correctly.
- **`dtwatch/settings.py`** — `KEYCLOAK_*` settings and `LOCAL_LOGIN_ENABLED`.
- **`requirements.txt`** — `cryptography` (PyJWT cannot verify RS256 without
  it) and `requests`. PyJWT 2.13.0 and redis 5.0.8 are already present.

Frontend:

- **`SsoCallbackPage.tsx`** — new `/sso/callback` route; posts the one-time
  code, stores the returned tokens through the existing auth path.
- **`LoginPage.tsx`** — "Sign in with NTC SSO" button; password form hidden
  when `local_login_enabled` is false.
- **`UsersPage`** — role shown read-only for SSO-backed users. Without this an
  admin's edit silently reverts at the user's next login.

## Session lifetime and revocation

Because SSO-only is the intended end state, a user disabled in Keycloak must
lose DT-WATCH access promptly. The app's tokens are its own, so Keycloak
revocation is not immediate.

Chosen: **SSO-originated sessions get a shorter refresh lifetime** than the
current 12 hours (`SSO_REFRESH_TOKEN_LIFETIME`, default 1 hour). No extra
Keycloak calls, and no bearer credential stored at rest.

Documented as a later upgrade, not built now: store Keycloak's refresh token
per session and re-validate on every app-token refresh, re-reading `groups` to
re-apply the role. That cuts revocation to minutes and keeps roles live, at the
cost of holding a credential at rest for every active user. Not worth it for an
internal tool at this stage.

## Error handling

| Condition | Result |
|---|---|
| `KEYCLOAK_*` unset | `503`, or redirect with `sso_unavailable`. SSO absent, never half-working |
| Not in `dtwatch` | redirect `no_app_access`; log records the claim path and groups found |
| `state`/cookie mismatch | redirect `bad_state` |
| Expired transaction or reused login code | redirect / `400` `bad_login_code` |
| Username collision, unverified email | redirect `link_conflict`; **never** auto-linked |
| Keycloak unreachable | redirect `idp_unreachable` |
| Local login attempted while disabled | `403`, explicit message |

## Testing

Unit tests with JWKS and the token endpoint mocked, so CI needs no live
Keycloak: gate pass and fail, each role mapping including the unmapped-group
default, linking by `sub`, linking by verified email, refusal on unverified
collision, JIT creation, invalid signature, wrong issuer, wrong audience,
nonce mismatch, group-path normalisation, login-code single use, and
`LOCAL_LOGIN_ENABLED` both ways.

Mocked tests cannot prove the realm config is right, so a manual smoke-test
checklist against real Keycloak is part of the deliverable.

## Keycloak configuration (applied by the user, not by this work)

The live realm serves GitLab, Grafana and Rocket.Chat and is in its
post-cutover soak window, so nothing here touches it. Required:

1. **Client** `dtwatch` — client authentication **on** (confidential),
   Standard Flow only, PKCE `S256` required, `groups` client scope attached.
2. **Redirect URIs** — `http://dtwatch.ntc.net.np:5180/api/v2/auth/sso/callback/`
   now, `https://dtwatch.ntc.net.np/api/v2/auth/sso/callback/` later.
3. **Group** `dtwatch`, created and populated.
4. **Hosts entries** → `127.0.0.1` in both
   `C:\Windows\System32\drivers\etc\hosts` and WSL's `/etc/hosts`.

Until the client exists, the SSO endpoints stay dark and local login is
unaffected — which is the reason local login is kept through the transition.

## Out of scope

- Deleting local login, `LoginView`, or the legacy password hashers.
- Provisioning users into Keycloak (nt-pms's Admin API sync).
- Single-logout beyond retaining the ID token to support it later.
- Routing `dtwatch.ntc.net.np` through Traefik.
