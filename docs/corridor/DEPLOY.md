# Deploying a world to Cloudflare

A baked world (or several) as a running copy: the built viewer as a Worker, the world's data in
R2. Rich, 2026-09-30: *"if I want to bake a single world into something I can deploy to
Cloudflare using R2 for assets and tiles and CF workers for the main app… copy just the assets
used in the game, not the full library… support world multiplexing too so you can deploy
multiple worlds to one URL."*

What the Cloudflare account needs first — R2 added, the token's permissions, the cache switches — is
in [CLOUDFLARE.md](CLOUDFLARE.md).

## From the world editor

Mode **9 · Deploy** (the top bar, or the `9` key). The form, top to bottom:

1. **Token.** `CLOUDFLARE_API_TOKEN` in the service's environment, or typed into the panel. A
   typed token is verified against Cloudflare and then held in the server process's memory: it is
   never written to disk, never returned by any route, and never appears in a log. "Forget it"
   clears it. **A rollout of the world editor forgets a typed token** (the process restarts); the
   panel checks before every deploy and says so. To keep one on the cluster, put it in a Secret
   and name it in the release file (`cloudflare.secretName`; key `CLOUDFLARE_API_TOKEN`):

   ```
   kubectl -n default create secret generic cloudflare --from-literal=CLOUDFLARE_API_TOKEN=<token>
   ```

   Both kinds of token work: a user token (My Profile → API Tokens) and an account-owned one
   (the account's Manage Account → API Tokens). The second cannot answer the user verify call, so
   it is verified by which accounts it can see. The token needs *Workers Scripts: Edit*, *Workers R2 Storage: Edit*, *Account
   Settings: Read* and, for a custom hostname, *Zone: Read* + *Workers Routes: Edit* on the zone.
   An account-owned token also needs to be able to read its own id (`/accounts/{id}/tokens/verify`),
   because a large object uses it — see *Large objects* below.
2. **Worlds.** Every baked world on the volume; tick one or several. Several share one address and
   the viewer's site picker chooses between them — that is the whole of "multiplexing".
3. **Query Cloudflare.** Accounts, the zones the token can see, the R2 buckets, and the account's
   `workers.dev` subdomain.
4. **Where it goes.** The Worker's name; `workers.dev` on or off; optionally a hostname in one of
   the zones (Cloudflare writes the DNS); the bucket, or a new one (made on the first deploy); the
   prefix under it, which defaults to `corridor/<world>-<stamp>`; and whether older copies of
   these worlds are deleted from the bucket afterwards.
5. **Plan**, then **Deploy.** The plan is a dry run: how many objects, how many bytes, by group
   (bake, docs, levels, assets), which models and builds are going, and every warning. Deploy is a
   run — it appears in the runs list with a log, and the last line of the log is the URL.

## What goes up, and where

Keys under the prefix are exactly the paths the viewer fetches from its own origin, so the viewer
is deployed unchanged:

| key | what |
|---|---|
| `sites/index.json` | the chosen worlds only — what the site picker lists |
| `sites/<slug>/web/**` | the bake's tiles and overviews (the export's `web/`) |
| `sites/<slug>/*.json`, `osm.geojson`, `preview.png` | the manifest and every authored document |
| `levels/<id>.json`, `api/levels` | the levels set in those worlds, and the list the stage picker reads |
| `api/programs/<path>` | each level's program, already transpiled (`{ id, js, errors }`) |
| `assetsvc/catalog/<id>`, `…/file/mesh.*.glb` | the models the worlds USE: finished, else raw; the glazed one when it exists |
| `assetsvc/vehicles`, `traffic`, … | the build lists, filtered to what is used |
| `assets/catalog.json` | the placement catalog, filtered the same way |
| `deploy.json` | this deploy's own manifest: every key it wrote |

**What is used is measured, not listed.** Every string in the bundled documents that is a catalog
id or a build id is followed — a level's hero build to its model, a traffic set to its builds to
their models, a fixture choice to its model — until nothing new appears. There is no table of
"fields that hold asset ids". The Route 3 jam comes to 254 objects and 129 MB: 92 MB of bake,
25 MB of models (11 of the library's cars), 11 MB of docs.

Not sent: the lidar, the GeoTIFFs, `web.staging`, the raw 26 MB reconstruction when a finished
mesh exists, and every model nothing in the world names.

The bucket also holds `corridor/deployments.json`, a ledger of every deploy made this way. Pruning
reads it: an older deploy of the same worlds (or the same Worker) has its keys deleted from its own
`deploy.json`, then its entry removed. Nothing depends on listing the bucket.

## The Worker

`tools/worldeditor/deploy/worker.mjs`, one module. Bindings: `ASSETS` (the built app), `DATA`
(the bucket), `PREFIX` (this deploy's prefix). A request for `/sites/…`, `/levels/…`,
`/assetsvc/…`, `/api/levels`, `/api/programs/…` or `/assets/catalog.json` is a bucket lookup at
`PREFIX/<path>`; everything else is the app, with `single-page-application` fallback. Tiles under
`web/` are `immutable`; documents are cached for a minute. Writes get a 405 that says to edit in the
world editor. `/api/*` anything else is a 404 rather than a silent `index.html`.

The app is whatever is at `WORLDEDITOR_APP` (the image's prebuilt `apps/corridor/dist`; on a
laptop, build it first with `npm run build -w apps/corridor`). It is ~140 MB across ~340 files,
well under the per-file limit; the upload session only sends what Cloudflare does not have yet.

## Over the API

```
GET    /api/deploy/status                  token presence + source (never the token), baked worlds
POST   /api/deploy/token      {token}      hold one in memory (verified first); DELETE forgets it
GET    /api/deploy/cloudflare[?account=]   accounts, zones, buckets, workers.dev subdomain
POST   /api/deploy/bucket     {account, name}
POST   /api/deploy/plan       {worlds}     the dry run
POST   /api/deploy/start      {worlds, account, bucket, prefix?, worker: {name, workersDev?, hostname?, zoneId?}, prune?, dryRun?}
GET    /api/deploy/revisions?account=&bucket=   the ledger
```

## Large objects

Objects go up through the REST API one PUT each — except anything over 32 MiB, which that API's
front refuses with an HTML `413 Payload Too Large` before R2 sees it (the dc-metro deploy,
2026-10-08: a 371 MiB `osm.geojson`; the bake also holds a 133 MiB `chm_2m.png` and a 78 MiB
`branches.json`). Those go to R2's S3 endpoint, `https://<account>.r2.cloudflarestorage.com`, as a
multipart upload in 32 MiB parts read from the volume one at a time, so neither the request nor the
pod's memory grows with the file. The S3 credentials are the ones Cloudflare derives from the same
token — access key = the token's id, secret = SHA-256 of the token — so there is nothing new to
configure. Parts are retried on a 429/5xx; any other failure aborts the upload so R2 keeps no
orphaned parts. The signer is checked against AWS's published S3 examples (`cloudflare.test.mjs`).

## What has and has not been proven

`tools/worldeditor/cloudflare.test.mjs` proves the client's side of every call (paths, headers,
the asset manifest's hashes, the multipart shapes, the bindings) against a stand-in;
`deploy.test.mjs` proves the closure, the keys, the ledger and the prune against a temp volume and
an in-memory bucket. The token route was seen to reach Cloudflare (a bad token comes back as
`6003: Invalid request headers`). **No real deploy has been run yet** — there is no token on this
machine. The first one will say, in its log, exactly which call Cloudflare disliked, if any.
