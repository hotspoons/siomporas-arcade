# Publishing the arcade

Three games, three subdomains of `siomporas.com`, one Cloudflare account:

| Game | Directory | Worker | Address |
|---|---|---|---|
| Turbo Radrun | `apps/coast` | `turbo-radrun` | https://radrun.siomporas.com |
| Drivin’ | `apps/drivin` | `drivin` | https://drivin.siomporas.com |
| Apex Conduit | `apps/conduit` | `apex-conduit` | https://apex.siomporas.com |

Each is a static site: Vite builds it, Wrangler uploads the built files as a Worker's assets, and the
Worker serves them from the edge. There is no server code, no Pages project, and no build step running
on Cloudflare — the build happens in GitHub Actions, which uploads the result.

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
builds and publishes each game in turn. A red check means nothing ships. Until the two secrets exist
the workflow still builds all three and simply says it had nothing to publish with, so the repository
is not red while you are still setting Cloudflare up.

The first deploy of each Worker also creates the DNS record for its subdomain, because the custom
domain is declared in that app's `wrangler.jsonc`. Nothing to click.

## 4. Deploying by hand

From a checkout, with `npx wrangler login` done once:

```bash
npm run deploy -w apps/coast      # or drivin, or conduit
```

That builds and publishes one game. `npx wrangler deployments list` from an app directory shows what
is live, and `npx wrangler rollback` puts the previous version back.

## Changing a name or an address

The game names live in three places: the app's `index.html` title, its title card in
`src/app/Game.ts`, and its menu title. The address lives in two: the `routes` entry in the app's
`wrangler.jsonc` and the matrix in the deploy workflow. Renaming the Worker itself (the `name` field)
publishes a *new* Worker rather than renaming the old one, so delete the old one from the dashboard
afterwards.

## What this costs

Nothing, at this scale. Cloudflare's free plan covers 100,000 Worker requests a day, and a static
asset response served from cache does not count against it. The games are a single HTML file, one JS
bundle and their assets; the sprite atlas is baked in the player's browser on first load and cached in
their IndexedDB, so it is never served over the wire.
