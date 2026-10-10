# Plan: accounts, roles and per-user worlds in the world editor

Status: **plan, not started** (2026-10-10). To be executed later, in lanes, by agents or by hand.

Rich, 2026-10-10: *"Can we add a simple username / password auth system plus oidc to the deployed
editor? Two roles — user and admin. Admin will be able to assume any user's view and act as the
user. Users should have their assets and maps completely separate from each other, and manage their
own bakes and publishing. Users shouldn't be able to use the new map source data feature, that
should be admin only. OIDC will have a claim to role mapping configuration."*

This document is grounded in a survey of the code as of `c1b0c61` / `e4de399`. File and line
references are to that tree and will drift.

---

## 1. Where we start from

**There is no user anywhere.** The editor (`tools/worldeditor/server.mjs`) is one Node process
serving a flat route chain (`server.mjs:477–524`, `api()` at `:526`). It has no sessions, cookies or
idea of who is asking. The ingress (`tools/worldeditor/chart/templates/ingress.yaml`) only does TLS
and body-size settings, and CORS is `*` (`server.mjs:258–265`).

**The one secret is the MCP token, and it leaks.** `mcpauth.mjs` mints an `aat_…` bearer token.
It is checked only on `POST /api/agent/mcp` and the bridge WebSocket. But
`GET /api/agent/mcp/config` hands it to any caller in clear (`server.mjs:1049`), and
`POST /api/agent/mcp/config` regenerates it with no check at all.

**Every piece of data is global.** The volume (`store.mjs:12–21`) holds the following, each keyed
by a world slug (one flat namespace, no owner) or by a global id:
- `worlds/`, `sites/<slug>/`, `levels/`, `programs/`, `places/`, `captures/`, `uploads/`,
  `runs/`, `deploys.json`, `assets/catalog.json`, `blender/`;
- the two indexes `sites/index.json` and `sites.json`.

The asset service (`tools/assetsvc`, separate pod and PVC) has no auth either. Its "shared vs this
world" scope is a `world` field that only the *client* filters on (`assets.ts:425`).

**Some of what runs on a caller's behalf is privileged.**
- **Bake Jobs** mount the whole PVC at `/data` (`runs.mjs:271–335`).
- **Splat training** accepts an arbitrary `image`/`command`/`args` (`training.mjs:73–96`).
- **Blender:** `/api/blender/exec` runs Python, and `/load` and the rig routes take arbitrary paths.
- **Git:** `/api/git/*` treats the whole volume as a repository, with credentials at its root.
- **MCP:** server-side tools call back into the API over loopback with no identity
  (`server.mjs:454–475`). The page bridge has one global "owner" window (`mcpbridge.mjs:140`).

## 2. What we are building

| | user | admin |
| --- | --- | --- |
| sign in with a password or with OIDC | ✓ | ✓ |
| own worlds, sites, levels, programs, places, captures | own only | all, and their own |
| own assets (catalog items, builds, materials, sounds) | own, plus the shared library read-only | everything; curates the shared library |
| bake, publish, deploy | own worlds only | anyone's |
| runs viewer | own runs | everyone's |
| **map source data** (OSM coverage dialog, `osm-import`, Overpass routing, cache purge) | — | ✓ |
| settings, git, agent platform credential, MCP token admin | — | ✓ |
| Blender `exec`/`bridge`/arbitrary paths, training image overrides, site import from URL | — | ✓ |
| user management, role changes | — | ✓ |
| **act as** another user | — | ✓ |

What we are **not** building: groups, sharing a world between two users, per-world ACLs, billing.
They are kept possible (see §9) but are out of scope.

## 3. Identity

### 3.1 Accounts

`<data>/auth/users.json` holds one record per user. The `auth/` directory is service-wide and
never inside a user's namespace.

```jsonc
{ "id": "u_7f3c…",            // stable, never reused; the namespace key on disk
  "username": "rich",          // unique, case-folded
  "display": "Rich Siomporas",
  "role": "admin",             // "admin" | "user"
  "password": { "alg": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "…", "hash": "…" },  // absent for OIDC-only
  "oidc": [{ "iss": "https://…", "sub": "…" }],   // linked identities
  "disabled": false, "created": "…", "lastLogin": "…" }
```

**Passwords** use Node's built-in `crypto.scrypt`, so no dependency is added. The cost parameters
are stored with each hash so they can be raised later, and the comparison is constant-time. The
policy is a minimum length of 12 with no composition rules. Login attempts are rate-limited per IP
and per username, with exponential lockout recorded in memory and in the audit log.

**Bootstrapping.** On first start with no users, the server creates `admin` with the password from
the Secret value `WORLDEDITOR_ADMIN_PASSWORD`. If that is unset, it prints a one-time setup link to
the pod log; the link is valid for 30 minutes and lets you set the first admin password.

**Who creates accounts:**
- An admin creates password accounts in a Users panel.
- Self-registration is **off** (open question 1).
- OIDC accounts are created on first login (§3.3).

### 3.2 Sessions

A server-side session lives in `<data>/auth/sessions/` (or in memory with a file journal). The
browser holds an opaque random id in a cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`.

**Why a cookie and not a bearer header.** About 40 call sites use a raw `fetch` that bypasses
`api.ts`'s `call()`. They include `world/site.ts`, `assets/assetsvc.ts`, `editor/store/*`, and the
`minimap` and `maproads` workers. Same-origin fetches send the cookie with no code change. A bearer
header would need every one of them edited.

**Lifetime:** idle timeout 12 h, absolute timeout 30 days. The session id rotates at login, at
"act as" and at "stop acting".

**CSRF protection** comes from `SameSite=Lax` plus a check on every non-GET request that the
`Origin` (or `Referer`) is the editor's own host. CORS goes from `*` to same-origin only. Then
nothing cross-site can send an authenticated mutation.

**WebSockets** (`/api/agent/tunnel`, `/api/agent/bridge`) authenticate by the same cookie on the
upgrade request. The `?access_token=` query form is removed, because tokens in URLs end up in
access logs.

### 3.3 OIDC

The flow is authorization code with PKCE (S256), plus a `state` and `nonce` held in the pre-login
session. Endpoints come from the issuer's `/.well-known/openid-configuration`. The `id_token` is
verified against the issuer's JWKS for signature, `iss`, `aud`, `exp`, `nbf` and `nonce`; keys are
cached and refetched when an unknown `kid` appears. Node's `crypto.createPublicKey({ key: jwk,
format: 'jwk' })` verifies RS256/ES256 with no dependency. If more is needed, `jose` (a single
dependency) is the fallback.

**Configuration** lives in the chart values; the secret goes in a k8s Secret:

```yaml
auth:
  password: true                 # username/password on or off
  oidc:
    enabled: true
    issuer: https://auth.example.com/realms/patapsco
    clientId: corridor-editor
    clientSecretRef: { name: worldeditor-oidc, key: client-secret }
    scopes: [openid, profile, email, groups]
    username: preferred_username # claim for the display username; falls back to email, then sub
    roles:
      claim: groups              # dotted path into the id_token or userinfo, e.g. realm_access.roles
      admin: [corridor-admins]   # any of these values → admin
      user:  [corridor-users]    # any of these → user ("*" = any authenticated identity)
      default: deny              # no match → deny | user
      sync: every-login          # re-derive the role at each login (a revoked group demotes)
    allowedDomains: []           # optional e-mail domain allow-list
```

**The claim mapping:**
- The claim at `roles.claim` may be a string or an array.
- `admin` wins over `user`.
- `default: deny` refuses a login that matches neither list, with a page explaining why.
- With `sync: every-login`, the role is recomputed at each login, so removing someone from the IdP
  group demotes them. An admin can pin a role by hand, which turns sync off for that user.

**Linking identities.** The first OIDC login for an `(iss, sub)` pair either links to an existing
account with the same verified e-mail (admin-confirmable, open question 3) or creates a new one.

**Logout** clears the local session and, if the IdP advertises `end_session_endpoint`, redirects
there.

### 3.4 Machine access: MCP and scripts

The single shared MCP token is replaced by **per-user API tokens**:
- Each user creates and revokes their own in a "Tokens" tab of their user menu.
- Tokens are stored hashed (sha256), shown once at creation, and prefixed `aat_` so existing
  `.mcp.json` files keep their shape.
- `Authorization: Bearer aat_…` resolves to the token's user. Everything a token does is scoped
  exactly as that user's session would be.
- `GET/POST /api/agent/mcp/config` stops returning a token; it returns the caller's token list.

**Loopback calls.** Server-side MCP tools call the API through `apiFetch`. Each loopback call
carries `x-corridor-internal: <per-process random secret>` and `x-corridor-subject: <user id>`
(and `x-corridor-actor` when acting as someone). These are honoured only from `127.0.0.1` with the
matching secret. The longer-term fix is to call handlers in-process with a context object
(§4.3, phase 5).

**Role filtering.** The MCP tool list a token sees depends on its user's role. Admin-only tools
(§6) are absent for users, not just refused, so an agent never plans around a tool it cannot call.

**The bridge.** The page bridge's "owner window" becomes per user: a map from user id to window. An
agent working for user A can only drive A's tabs. `editor_claim` moves ownership among the caller's
own windows.

## 4. Data isolation

### 4.1 Namespaces on the volume

```
/data/
  auth/                     users, sessions, tokens, audit.log          (service)
  settings.json             service settings                            (service, admin)
  cache/                    overpass, naip, usgs1m, osmtiles, basemap…  (service, shared by everyone)
  overpass/                 coverage.json, geofabrik-index.json         (service, admin — map source data)
  assets/catalog.json       the shipped placement kit                   (service, read-only to users)
  users/<uid>/
    worlds/  sites/  sites.json  levels/  programs/  places/
    captures/  uploads/  runs/  deploys.json  blender/
```

**`Store` gains a root** (`store.mjs:50–60`). `store.for(user)` returns a `Store` whose root is
`users/<uid>` and whose cache paths still point at `/data/cache`. Every route handler takes the
caller's store from the request context. Nothing touches the global `store` except the service
parts (settings, auth, overpass, cache).

**Client URLs don't change.** The editor and the game fetch `/sites/<slug>/…`, `/api/levels`,
`/api/programs/…` and `/assets/catalog.json`. The server resolves these against the caller's
namespace. Not one of the ~40 raw fetch sites has to learn about users, and the editor-served game
preview works as it does today. Slugs are unique *per user*, so two users can each have a
`crofton`.

**Admin "all users" views.** The Worlds list, Runs and Deploys get an owner column for admins. An
admin opening another user's world does it by acting as them (§5); there is no second URL scheme.

### 4.2 Bakes and other cluster Jobs

**Mounts.** A bake Job mounts the PVC twice:
- `subPath: users/<uid>` at `/data`, so `CORRIDOR_DATA=/data`, `sites.json` and `sites/index.json`
  become per-user with no change to the Python;
- `subPath: cache` at `/data/cache`, so the expensive downloads stay shared.

Coverage files for Overpass routing are mounted read-only from `overpass/`. A Job therefore cannot
read or write another user's tree. This is a property of the mount, not of the code inside it.

**Labels** on every Job, TrainingDeployment and pod gain `corridor.owner=<uid>`. Listing, logs,
cancel and delete filter on that label, and admins see all.

**Quotas.** Each user gets a concurrency limit, by default one running bake and one GPU job. Bakes
take hours and shards fan out, so without a limit one user's DC bake starves everyone.
`osm-import` is admin-only, so it is not counted against anyone's quota.

**Run records** gain `owner` (and `actor` when an admin started them while acting). Run ids are
already unique, and the records move under `users/<uid>/runs/`.

### 4.3 The asset service

The asset service stays **cluster-internal**: no ingress, plus a NetworkPolicy that admits only
the editor pod. It is reached only through the editor's `/assetsvc` proxy and `deploy.plan`.

**Trusting the proxy.** The proxy (`server.mjs:407–422`) adds `x-corridor-user`,
`x-corridor-role` and `x-corridor-ts`, plus an HMAC over them and the method and path. The HMAC
key is a shared Secret (`assetsvc-auth`). The asset service rejects any request without a valid
HMAC.

**Scoping rules, enforced on the server:**
- **Catalog items** gain `owner: <uid> | null`. `null` is the shared library.
  - `world` keeps meaning "this world only", within the owner.
  - `GET /catalog` returns shared items plus the caller's own; today it returns everything.
  - Writing or deleting a shared item is admin-only.
  - `fork` copies a shared item into the caller's ownership. This is how a user customises a
    library car.
- **Builds** (vehicles, actors, weapons, presets, traffic, facades) move from one file per kind to
  `owners/<uid>/<kind>.json` plus a shared `<kind>.json`. The shared file is admin-written and
  read by everyone; a user's own file overrides it by id. `facades` keeps its shared default.
  Per-world building pools already live in `sites/<slug>/surfaces.json`, which is now per user.
- **Materials and sounds** follow the same split: shared (admin-written) plus own.
- **GPU jobs** (draw, mesh, material generate) record their owner, count against that user's GPU
  quota, and are listed per owner.
- **`/sync/push|pull`** and `PUT /settings` are admin-only.

**Migration.** Every existing item becomes shared (`owner: null`), or is assigned to Rich (open
question 4).

### 4.4 Publishing and deploys

Users can publish and deploy their own worlds. The Cloudflare side keeps one account, the
service's token held by the editor, with users namespaced inside it:
- **R2 prefix:** `corridor/<uid>/<slug>-<stamp>/`
- **Worker name:** `corridor-<username>-<slug>`
- **`deploys.json`:** per user, under `users/<uid>/`

A user sees and deletes only their own deploys. **Custom domains** (`dc-nightmare.siomporas.com`)
need an admin to attach them, because a hostname belongs to the account, not the user.

Per-user Cloudflare tokens are a later option (open question 2). The token store would become
per user, encrypted at rest with a key from a Secret.

`/api/runs/publish` (the shared `corridor-r2` bucket) follows the same prefix rule. `deploy.plan`
reads only the caller's namespace and the shared plus own asset scopes.

## 5. Acting as a user (admin)

- **Entering.** An admin picks "Act as…" in the user menu, or uses the Users panel. The session
  then carries `actor = admin` and `subject = user`, and the session id rotates.
- **What the admin sees.** Everything is scoped and authorised as the **subject**. The admin sees
  exactly what the user sees, including the *absence* of admin features, so "it works for me" means
  something.
- **Audit and exit.** The actor is kept for two things only: the audit log, and the
  **Stop acting** route, which is the one admin route that stays reachable while acting.
- **Banner.** A fixed banner across the top of every page reads "Acting as *Jane* — Stop", in a
  colour nothing else uses. The browser tab title gains "⟨as Jane⟩".
- **Audit log.** Every mutation by any user is recorded, with actor and subject when they differ,
  in `auth/audit.log` (JSON lines: time, actor, subject, method, route, target ids, outcome). Login,
  logout, failed login, token create/revoke, role change, act-as start/stop are all recorded too.
  Admins can read it in the Users panel.
- **MCP.** An admin's token can act as another user with `x-corridor-act-as: <user>` on the MCP
  request. This is logged the same way, and works only for admin tokens.

## 6. Admin-only surface (from the survey)

The authorisation table belongs in one module (`authz.mjs`) as a list of route patterns with the
role each needs, so a review reads one file. **Admin-only:**

**Map source data**
- the OSM data dialog
- `osm-import` runs and their MCP tool
- `overpass/coverage.json` writes and the `overpass.regions` setting
- `POST /api/osm/cache/purge-empty`

Users still get *read* access to map data through their bakes (routing applies to everyone), and
can see a read-only coverage summary on their world, e.g. "covered by overpass-na".

**Service settings**
- `PUT /api/settings`: `bake.image`, `splat.*`, `blender.bin` and service URLs, which choose what
  code runs
- the asset service's `PUT /settings`
- `/api/config`, trimmed for users to what the client needs

**Infrastructure and secrets**
- `/api/git/*` (the volume as a repository, and its credentials)
- `/api/agent/credential` (the platform PAT)
- `/api/agent/agents` and `/api/agent/tunnel` while they use the service PAT (a per-user PAT is a
  later option)
- `/api/deploy/token` and `/api/deploy/bucket`

**Arbitrary code or paths**
- `/api/blender/exec` and `/bridge/start|stop`
- `/api/blender/load` and the rig routes. Users get these with paths validated to inside their own
  namespace.
- training runs with `image`, `command` or `args` overrides. Users get the default image only.
- `/api/training/gpus` (a cluster-wide read)
- `POST /api/sites/import` with `{url}` (an outbound fetch) or `?replace=1` over a world the caller
  doesn't own

**Shared libraries**
- `/api/catalog` POST/DELETE (the placement kit)
- writes to shared asset-service items, builds, materials and facades
- `/sync/*`

**Accounts:** user management and role changes.

The MCP tools that map onto any of the above (survey §4: `blender_exec`, `blender_bridge`,
`asset_sync`, `deploy_cloudflare` admin parts, `splat_start` with overrides, `site_import` by URL,
`catalog_add`, `catalog_delete`, `building_class_set` without a slug, the coming `osm_import`) are
hidden from user tokens.

## 7. Client

- **Login page** (`/login`, served by the editor and outside the SPA) with username, password,
  "Sign in with ⟨IdP name⟩", and an error line. Every other page redirects there when there is no
  session. API calls answer `401` with JSON, and a small shared wrapper sends the page to
  `/login?next=…`. A raw fetch that gets a 401 shows a "Signed out — sign in again" toast from one
  global `unhandledrejection`/fetch hook, rather than editing all 40 sites.
- **User menu** next to the settings cog (`worldedit/main.ts:719`): name and role, My tokens,
  Act as… (admin), Users (admin), Audit (admin), Sign out.
- **Admin features hidden for users**, driven by `GET /api/me` (`{ user, role, actor?, features }`):
  the Settings dialog's `git` and `services` tabs, the OSM data dialog, Blender exec, training
  overrides, shared-library edit controls. The server still refuses them; hiding is courtesy, not
  security.
- **The `?assetsvc=` query override** (`assetsvc.ts:154–172`) is ignored in a production build, so
  a page can't be pointed at a different origin's asset service.

## 8. Deployment

New Secrets, following deploy/README.md (no secrets in values files):
- `worldeditor-auth`: session key, bootstrap admin password, internal HMAC key
- `worldeditor-oidc`: client secret
- `assetsvc-auth`: the proxy HMAC key, shared by both pods

Chart changes:
- `auth.*` values (as in §3.3)
- `secretKeyRef`s in `deployment.yaml`
- CORS to the editor host
- a NetworkPolicy for the asset service
- the bake Job spec's two `subPath` mounts and owner label

**RBAC is unchanged.** The editor still creates Jobs; scoping happens in what it creates.

Data migration runs as a one-shot, idempotent startup step guarded by `auth/migrated.json`:
1. Create Rich's admin account from the bootstrap Secret.
2. Move `worlds/`, `sites/`, `levels/`, `programs/`, `places/`, `captures/`, `uploads/`, `runs/`,
   `deploys.json`, `blender/` into `users/<rich>/`. Use renames on the same filesystem, so it is
   instant and nothing is copied.
3. Rewrite run records with `owner`.
4. Mark existing asset-service items shared.

**Rollback** is the reverse rename, by the same script with `--undo`. Take a snapshot of the
ceph-filesystem volume before the migration.

The deployed Cloudflare games stay public: published means public. Only the editor and its
preview need sign-in.

## 9. Order of work (lanes)

Each phase ends deployable, with a probe that fails without it.

1. **Identity core.** `auth/` store, scrypt passwords, sessions, login and logout pages, `/api/me`,
   CSRF/Origin check, CORS tightening, rate limiting, audit log, bootstrap admin. Every route
   requires a session; no scoping yet, everyone sees everything as today. Tests: spawn the server
   on a temp volume (the `server-mcp.test.mjs` pattern) and log in, log out, check 401s, 403 on
   cross-origin POST, lockout.
2. **Roles and admin-only routes.** `authz.mjs`, the §6 table enforced, client hiding by `features`.
   The OSM data feature lands behind admin from its first commit. Tests: every admin route answers
   403 to a user; a table-driven test fails when a new route is added without an entry.
3. **Per-user namespaces.** `store.for(user)`, the migration, request-context stores in every
   handler, per-user `sites.json` and `index.json`, slugs per user, the bake Job's two mounts plus
   owner labels plus quotas, runs and deploys per user. Tests: two users bake the same slug without
   seeing each other's files, runs or deploys; a Job spec carries only the owner's `subPath`.
4. **Asset service scoping.** The HMAC proxy, `owner` on items, per-owner builds, materials and
   sounds, shared-library admin writes, the NetworkPolicy, migration. Tests: user B can't list,
   fetch, fork-from or delete user A's items; a request without the HMAC is refused.
5. **Machine access.** Per-user API tokens, MCP role-filtered tool lists, loopback identity (then
   in-process handler calls), the per-user bridge owner, `x-corridor-act-as` for admin tokens.
   Tests: a user token's `tools/list` omits admin tools; one user's agent can't drive another's tab.
6. **OIDC.** Discovery, PKCE flow, JWKS verification, claim → role mapping with sync, identity
   linking, IdP logout. Tests against a local stub IdP that signs tokens with a test key: mapping
   table cases, a demotion on re-login, `default: deny`.
7. **Acting as.** The actor/subject session, the banner, audit entries, stop-acting. Tests: while
   acting, admin routes are refused except stop-acting; mutations log both ids.

Phases 1–2 are about one lane each; phase 3 is the big one (every handler); 4–7 are one lane each.
Phase 6 can run in parallel with 3–5 once phase 1 has landed.

## 10. Open questions for Rich

1. **Self-registration:** should anyone be able to create a password account, or only an admin
   (the plan's default), or only via OIDC?
2. **Cloudflare:** one account with per-user namespaces (the plan's default), or each user brings
   their own token and account?
3. **Linking an OIDC login to an existing password account** by verified e-mail: automatic, or
   admin-confirmed?
4. **Existing assets:** all into the shared library (the plan's default), or all owned by Rich and
   then curated into the shared library by hand?
5. **GPU features for users** (asset draw/mesh, material generate, splat training with the default
   image): on with a quota (the plan's default), or admin-only to start?
6. **The IdP:** which one (Keycloak, Authentik, Google Workspace, GitHub)? It decides the role
   claim's default path (`groups` vs `realm_access.roles`), and whether GitHub-style non-OIDC OAuth
   needs supporting.
