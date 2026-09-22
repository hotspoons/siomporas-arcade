# assetsvc — the backend that owns the asset pipeline

A described prop goes in, a game-ready `.glb` comes out, and **the browser never touches a GPU
service.** That last part is the reason this exists rather than the editor calling flux and
TRELLIS itself.

```
  editor (browser)
     │  knows exactly one origin: this service
     ▼
  assetsvc ──┬─► image model   (flux.2-dev today)      over cluster DNS
             ├─► mesh model    (TRELLIS.2 via recon)   over cluster DNS
             ├─► catalog on a volume  (a PVC in the cluster, a folder on a laptop)
             └─► an S3-compatible bucket, for save and load
```

```bash
# development: the models are port-forwards, the service runs here
kubectl port-forward -n default svc/high-brine-high-brine-flux2-dev-lws-api 18090:80
kubectl port-forward -n default svc/recon 8500:80

ASSETSVC_URL_FLUX2_DEV=http://127.0.0.1:18090 \
ASSETSVC_URL_TRELLIS2=http://127.0.0.1:8500 \
  node tools/assetsvc/server.mjs --port 8770 --data ext/assetsvc

curl -s localhost:8770/models | jq            # what is configured, and what actually answers
node tools/assetsvc/smoke.mjs                 # the whole loop, end to end, with numbers
```

## Why a service and not a script

`tools/assetgen` already does this chain from a laptop, and it works. What it cannot do is be used
by anyone who is not sitting at that laptop with two port-forwards open, because the model servers
are `ClusterIP` — they have no route from outside the cluster, deliberately. Exposing them so a
page could call them means publishing an endpoint that runs arbitrary inference on a GH200.

So the editor talks to this, and this talks to them. In the cluster that is
`http://recon.default.svc`; on a laptop it is a port-forward; the editor cannot tell the
difference and does not have credentials for either.

## The two interfaces, and swapping a model

`adapters.mjs` defines exactly two things:

| | in | out |
|---|---|---|
| `ImageModel` | a prompt, optionally source images | one PNG |
| `MeshModel` | one or more views | one GLB |

Nothing else in the service names a vendor. `OpenAIImagesModel` speaks the
`/v1/images/generations` + `/v1/images/edits` API, which covers flux.2-dev, flux.2-klein and most
local inference servers; `ReconMeshModel` speaks `tools/recon-service`. **Swapping a model is an
entry in `models.json` and one environment variable** — no route changes, no catalog changes,
nothing in the editor.

`models.example.json` is the worked example, including a `flux2-klein` entry with no URL to show
what an unconfigured model looks like (`GET /models` reports it rather than failing later).

## Everything slow is a job

An image is ~10 s and a reconstruction is minutes. Neither survives being held open on an HTTP
connection through an ingress, and the editor has to be closable. So `POST` starts a job and
returns its id, and `GET /jobs/<id>` polls it — the same shape `recon` itself uses.

Jobs run **one at a time per lane** (`image`, `mesh`). The GPU behind the mesh model serialises
internally; firing six reconstructions at it gets six that are each six times slower plus an
out-of-memory. A concurrency of one also makes queue depth an honest number to show someone —
"third in line" rather than a spinner.

Jobs are **in memory on purpose**. They are progress, not results: every result lands in the
catalog on the volume *before* the job is marked done, so a pod restart loses the progress bar and
nothing else.

## The catalog is a directory

```
<data>/catalog/<id>/item.json            the spec, the state, and the provenance of every step
<data>/catalog/<id>/views/*.png          generated views; `chosen` names the one to mesh
<data>/catalog/<id>/mesh.glb             what the mesh model returned, raw
<data>/catalog/<id>/mesh.finished.glb    after tools/assetgen/finish.mjs — what a game loads
```

A directory is the right size of database for a few hundred props, and it means a generated asset
survives a pod restart without another GPU-hour. `state` is **derived** from which files exist
(`spec` → `drawn` → `meshed` → `finished`) rather than stored, so it cannot go stale.

Provenance is not optional: every step appends to `history` with the model, the prompt, the seed
and the time. An asset whose origin nobody can reconstruct is one you cannot regenerate when the
style changes, and this pipeline exists to be re-run.

## Finishing is not reimplemented

`mesh.glb` is what TRELLIS hands back: ~400k faces and two 2048px PBR maps, tens of megabytes.
The service shells out to `tools/assetgen/finish.mjs`, which already knows the two things that
cost someone a week — that **meshoptimizer** must do the simplifying because a collapse decimator
pulls UV seams apart and the texture rips along them, and that the **unlit transform must run
before Draco** or it decompresses to do its work and undoes the compression. One copy of that
knowledge.

## Endpoints

| | |
|---|---|
| `GET /health` | liveness: the process is up |
| `GET /ready` | readiness: both default models actually answer. 503 if not |
| `GET /models` | the roster, which are configured, which are reachable, and the S3 config |
| `GET /catalog` | every item with its derived state |
| `POST /catalog` | create or update an item's spec (`{id, subject, prompt, negative, tags}`) |
| `GET /catalog/:id` | one item |
| `DELETE /catalog/:id` | remove it and its files |
| `POST /catalog/:id/image` | start a 2D generation → `{job}` |
| `POST /catalog/:id/mesh` | start a reconstruction from the chosen view → `{job}` |
| `GET /catalog/:id/file/<path>` | serve a view, the mesh, the finished mesh |
| `GET /jobs` · `GET /jobs/:id` | progress |
| `POST /sync/push` · `POST /sync/pull` | the catalog to and from S3 |

## Configuration

Environment only, so the same code runs in the chart and on a laptop.

| | |
|---|---|
| `ASSETSVC_PORT` `ASSETSVC_HOST` | where to listen (`--port`, `--host`) |
| `ASSETSVC_DATA` | the volume (`--data`). Default `ext/assetsvc` |
| `ASSETSVC_MODELS` | path to models.json (`--models`) |
| `ASSETSVC_IMAGE_MODEL` `ASSETSVC_MESH_MODEL` | which entry is the default |
| `ASSETSVC_URL_<ID>` | override one model's URL — `flux2-dev` → `ASSETSVC_URL_FLUX2_DEV` |
| `ASSETSVC_CORS` | allowed origin. `*` by default, which is for development |
| `ASSETSVC_S3_BUCKET` `_ENDPOINT` `_REGION` `_PREFIX` | the bucket. R2 endpoint is `https://<account>.r2.cloudflarestorage.com` |
| `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` | its token |

S3 is signed by hand (`s3.mjs`) rather than with `@aws-sdk/client-s3`: SigV4 is eighty lines of
HMAC against a stable published spec, it works unchanged on AWS, R2, MinIO and Ceph RGW, and it
keeps a 20 MB dependency out of a repo that accounts for every dependency in `CREDITS.md`.
`tools/corridor/corridor/publish.py` does the same thing with boto3 because it is already Python.

## Traps, measured

**flux.2-dev crops tall subjects whatever you ask.** Verified again here: a mailbox on a 1.1 m
post, prompted with "whole object in frame with clear space around it", came back with the post
cut off at the bottom edge. It is a property of the model, not of the prompt. Compose for it —
ask for the subject small in frame, or generate the tall part separately.

**`reference_image` is klein-only.** flux.2-dev accepts the field, files it under its own
multi-modal key and never reads it, so a style reference is silently discarded and you get a
stranger drawn to an otherwise obeyed prompt. On dev, everything in the attachment list is an
*edit source* and is reproduced, not referred to.

**Send keyed cut-outs to the mesh model where you have them.** It keeps an alpha channel when one
is present, and a chroma key beats the background remover it would otherwise run. Passing
flattened RGB throws that away and makes the model guess again.

**`/readyz`, not `/healthz`, for a model server.** A GPU service answers `healthz` the moment its
process is up, and TRELLIS takes minutes to get 16 GB of weights onto the card. Probing liveness
would tell the editor the pipeline is available while a reconstruction would still fail.

## Not the default

Nothing here runs unless it is asked for. The Helm chart ships with the deployment disabled, and
corridor's viewer and editor work exactly as before without it — the asset catalog is an extra
panel that reports "no service configured" when there is none.
