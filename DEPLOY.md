# Publishing the arcade

One site, one Worker, one address. Every game is a path beneath it:

| What | Directory | Worker | Address |
|---|---|---|---|
| The arcade | `apps/arcade` | `siomporas-arcade` | https://arcade.siomporas.com |
| ↳ Turbo Radrun | `apps/coast` | — | https://arcade.siomporas.com/radrun |
| ↳ Stuntin’ | `apps/stuntin` | — | https://arcade.siomporas.com/stuntin |
| ↳ Apex Conduit | `apps/conduit` | — | https://arcade.siomporas.com/apex |
| An old address | `apps/drivin-redirect` | `drivin` | https://drivin.siomporas.com → /stuntin |

Only `apps/arcade` is deployable. The three game directories are libraries now: they have no
`wrangler.jsonc` and no `deploy` script, and the arcade imports each one as a lazily-loaded chunk.
They keep their own `index.html` and dev server, because that is where tuning, the operator bridge
and the smoke harness live — but nothing publishes them on their own.

It is a static site: Vite builds it, Wrangler uploads the built files as the Worker's assets, and the
Worker serves them from the edge. There is no server code, no Pages project, and no build step running
on Cloudflare — the build happens in GitHub Actions, which uploads the result.

Every path below `/` is resolved in the browser, not on the edge, so the Worker is configured with
`not_found_handling: single-page-application` and `/apex/settings/controls` arrives as `index.html`.

## The three old subdomains

`radrun`, `stuntin` and `apex.siomporas.com` are no longer published to — nothing in this repository
builds anything for them. **Deploying this as it stands leaves whatever is currently on those three
addresses running and getting staler**, because a Worker keeps serving its last upload for ever.

Decide one of two things:

1. **Redirect them into the arcade.** Copy `apps/drivin-redirect` three times, keeping each Worker's
   existing `name` (`turbo-radrun`, `stuntin`, `apex-conduit`) so it takes over the custom domain it
   already holds, point each `TO` at the matching path, and add three `build: skip` rows to the
   deploy matrix. Old links keep working. This is what `drivin.siomporas.com` already does.
2. **Delete them.** Cloudflare dashboard → Workers & Pages → delete each Worker, which releases its
   custom domain. Old links stop working.

Doing nothing is the one option that is actively wrong.

## 1. Get the domain onto Cloudflare

The domain is registered with Squarespace (which bought Google Domains). Registration stays there;
only the DNS moves.

1. Cloudflare dashboard → **Add a domain** → `siomporas.com` → **Free** plan.
2. Cloudflare scans for existing records. Check the list before continuing: anything currently live on
   the domain (mail especially — MX and any SPF/DKIM TXT records) has to appear here, or it stops
   working the moment the nameservers change. Add by hand whatever the scan missed.
3. Cloudflare gives you two nameservers, something like `xxx.ns.cloudflare.com`.
4. Squarespace → **Domains** → `siomporas.com` → **DNS** → **Nameservers** → *Use custom nameservers*,
   and enter both. Save.
5. Wait. Propagation is usually minutes, occasionally a couple of hours. The Cloudflare dashboard
   flips the domain to **Active** when it has taken.

You had this set up before and it vanished from the account. That happens when a zone is deleted
after long inactivity — the domain is unaffected, and adding it again is the whole fix. If Cloudflare
says the domain is *already* in another account, it is on an old account of yours: log into that one
and remove the zone, or use Cloudflare's "release domain" flow, before adding it here.

Nameserver delegation is required. Cloudflare only attaches Workers custom domains to zones it serves,
so pointing a single CNAME at Cloudflare from Squarespace's DNS will not do.

## 2. Make an API token for CI

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → *Edit Cloudflare Workers*.

- Account resources: your account.
- Zone resources: `siomporas.com` (the template asks for this so it can manage the custom domains).

Copy the token once — it is never shown again. Then grab the **Account ID** from Workers & Pages, in
the right-hand column.

In GitHub: repository → **Settings** → **Secrets and variables** → **Actions** → **New repository
secret**, twice:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |

## 3. Push

`.github/workflows/deploy.yml` runs on every push to `main`: lint, typecheck and tests first, then it
builds and publishes the arcade. A red check means nothing ships. Until the two secrets exist the
workflow still builds and simply says it had nothing to publish with, so the repository is not red
while you are still setting Cloudflare up.

The first deploy also creates the DNS record for `arcade.siomporas.com`, because the custom domain is
declared in `apps/arcade/wrangler.jsonc`. Nothing to click.

## 4. Deploying by hand

From a checkout, with `npx wrangler login` done once:

```bash
npm run deploy -w apps/arcade
```

That builds and publishes the whole arcade. `npx wrangler deployments list` from `apps/arcade` shows
what is live, and `npx wrangler rollback` puts the previous version back.

## Renaming a game

Drivin’ became Stuntin’, which is the worked example — though it happened back when each game had a
Worker and a subdomain of its own, so half of it is now about a path instead. See *Changing a game's
name or its path* below for where a name lives today.

Two things not to move. Players' saved data is keyed by the old name in their browsers —
`apex-drivin.tracks.v1` and friends — so those keys stay put and say why; rename them and every track
anyone has built disappears. And the old *address* keeps working: `apps/drivin-redirect` is a Worker
with no assets and no build that holds `drivin.siomporas.com` and 301s into the arcade. It is a
matrix entry like any other, marked `build: skip`, and it keeps the *old* Worker name on purpose: a
custom domain belongs to one Worker, so publishing the redirect as `drivin` replaces the game that
used to be there. Under a new name Cloudflare would refuse it the domain and leave the old game
running at the old address for ever. That is the pattern to copy for the other three subdomains.

## Changing a game's name or its path

A game's name lives in four places now: its own `index.html` title, its title card in
`src/app/Game.ts`, its menu title, and its `title` in `apps/arcade/src/catalog.ts`. Its **path** is
the `id` in that catalog entry, which must match the `id` its `module.ts` exports and the directory
its cabinet art sits in under `apps/arcade/public/cabinets/`. Change all three together or the
cabinet loses its artwork and the URL stops resolving.

Changing a path breaks links to it, and there is no redirect machinery for paths inside the arcade —
an unknown path quietly lands the player in the lobby rather than on a 404.

## What this costs

Nothing, at this scale. Cloudflare's free plan covers 100,000 Worker requests a day, and a static
asset response served from cache does not count against it. The games are a single HTML file, one JS
bundle and their assets; the sprite atlas is baked in the player's browser on first load and cached in
their IndexedDB, so it is never served over the wire.
