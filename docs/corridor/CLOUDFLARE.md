# Cloudflare: what the deploy needs from the account

The world editor's Deploy panel (docs/corridor/DEPLOY.md) publishes a world as a Worker with static
assets, with the world's data in an R2 bucket. This is what has to be true of the Cloudflare account
before the first deploy, how to make the token, and what to switch on afterwards to keep the bill at
zero. Rich, 2026-09-30: *"a document for Cloudflare setup requirements (I needed to add R2 to the
account for example) with instructions on creating an API token with the necessary privileges, what
services need to be enabled, all that."*

## 1. The account

| Needed | Where | Notes |
|---|---|---|
| **Workers** | Workers & Pages | Free plan is enough: 100,000 requests/day, and static assets are free and unmetered. The paid plan ($5/mo) lifts the request cap. |
| **R2** | R2 Object Storage → *Purchase R2* (once) | R2 has to be **added to the account** before any bucket can exist, and it asks for a payment method even though the free tier (10 GB stored, 10 M reads/month, 1 M writes/month) covers a few worlds. Egress is free. |
| **workers.dev subdomain** | Workers & Pages → *Overview* → right column, *Change* | Set once per account (e.g. `rich`); every Worker gets `<name>.rich.workers.dev`. The panel reports "no subdomain set" until it exists. |
| **A zone** (optional) | *Add a domain* | Only for a custom hostname such as `play.siomporas.com`. The domain's nameservers must point at Cloudflare (a CNAME from elsewhere does not work for Workers custom domains). The repo's root `DEPLOY.md` walks through moving `siomporas.com`. |

## 2. The API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token** (a *user* token),
or **Manage Account → API Tokens** (an *account-owned* token; the panel accepts both).

Permissions:

| Scope | Permission | Level | Why |
|---|---|---|---|
| Account | Workers Scripts | Edit | publish the Worker and upload its assets |
| Account | Workers R2 Storage | Edit | list and create buckets, write and delete objects |
| Account | Account Settings | Read | list accounts and the workers.dev subdomain |
| Zone | Zone | Read | list the zones a hostname can hang on (custom hostname only) |
| Zone | Workers Routes | Edit | attach the Worker to the hostname (custom hostname only) |
| Zone | DNS | Edit | Cloudflare writes the hostname's record for a Workers custom domain |

Account resources: the account. Zone resources: *All zones from an account* (or the one zone). No
IP filter, no TTL, or a short one if you prefer to re-paste it. Copy it once; it is not shown again.

The panel verifies the token on entry. A user token answers `/user/tokens/verify`; an account-owned
token cannot (it has no user) and is verified by listing the accounts it can see instead.

### Where the token lives

- **Typed into the panel:** held in the world editor process's memory. Never written, never
  returned, never logged. **Every rollout of the world editor forgets it** — the panel checks
  before each deploy and asks for it again.
- **From the environment:** `CLOUDFLARE_API_TOKEN` in the service's environment, shown as "from
  the environment" in the panel. On the cluster, a Secret named in the release file survives
  rollouts:

  ```
  kubectl -n default create secret generic cloudflare --from-literal=CLOUDFLARE_API_TOKEN=<token>
  ```

  and in `deploy/gh200-1/worldeditor.yaml`:

  ```yaml
  cloudflare:
    secretName: cloudflare
  ```

## 3. The bucket

The panel lists the account's buckets and can create one (3–63 characters, lower-case letters,
digits, dashes). Everything a deploy writes lives under one prefix, `corridor/<world>-<stamp>/`,
plus a ledger at `corridor/deployments.json`. Nothing else has to be set on the bucket: no public
access, no custom domain — the Worker reads it through a binding, and players never touch R2
directly.

## 4. Keeping reads free: the cache

R2 bills reads as *Class B operations*: 10 million a month free, then $0.36 per million. A player
loading a world reads a few hundred tiles, so a busy world could reach the free ceiling. The
Worker therefore puts every object it reads in Cloudflare's edge cache under the request URL (the
Cache API), so a tile is read from the bucket once per data centre and served from the edge after
that. Tiles are cached for a year (they never change under a prefix); documents for a minute.

Two dashboard switches make that cache do more, both free:

1. **Tiered Cache** — for a custom hostname: the zone → **Caching → Tiered Cache → Smart Tiered
   Cache**. Edge data centres fetch from a regional tier instead of each going to R2, so a world
   is read from the bucket roughly once per region rather than once per city. (Not available on
   `workers.dev`, which has no zone; the per-data-centre cache still applies there.)
2. **Cache Reserve** (paid, optional) — the zone → **Caching → Cache Reserve**. Keeps cached
   objects for a month regardless of how often they are hit. Only worth it for a world that
   many people play a little.

Nothing has to be enabled for the Cache API itself; it works on both `workers.dev` and custom
hostnames. Static assets (the app) are already served from Cloudflare's own asset store and are
not R2 reads at all.

## 5. Limits to know

| What | Limit |
|---|---|
| Worker static assets | 20,000 files, 25 MiB each (the app is ~340 files, largest 6.6 MiB) |
| Worker script | 3 MiB compressed on the free plan (ours is a few KB) |
| R2 object via the API the panel uses | ~300 MiB each (a tile is kilobytes; the biggest model 26 MB) |
| Requests | 100,000/day on the free Workers plan, counting every tile |
| Bucket name | 3–63 characters, `a-z 0-9 -` |

## 6. Custom hostname, step by step

1. The zone is on Cloudflare (section 1).
2. In the panel, after *Query Cloudflare*, pick the zone and type the host label (`play` for
   `play.siomporas.com`).
3. Deploy. The panel attaches the Worker to the hostname (Workers custom domain) and Cloudflare
   writes the DNS record and issues the certificate; the first request works within a minute.
4. Then switch on Tiered Cache (section 4).

## 7. What a deploy does, for the record

Plan → objects to the bucket under the prefix (parallel, one PUT each) → `deploy.json` manifest and
the `corridor/deployments.json` ledger → the app's files as Worker assets (only what Cloudflare does
not already have is uploaded) → the Worker script with three bindings (`ASSETS`, `DATA` = the
bucket, `PREFIX`) → the workers.dev subdomain and/or the custom hostname → optionally, older
deploys of the same worlds deleted from the bucket by their own manifests. Every step logs; the
last line is the URL. The editor keeps its own record of every deploy (`<data>/deploys.json`), and
the panel's *Past deployments* loads one back into the form or redeploys it under a new prefix.
