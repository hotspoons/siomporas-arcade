# assetlib — a spec becomes a model

One spec, end to end: flux.2-dev draws it, a chroma key cuts it out, TRELLIS.2 reconstructs it,
`finish` lights it. 120 specs today — 77 hero cars, 43 traffic and commercial — plus the building
materials.

    node tools/assetlib/build.mjs --list
    node tools/assetlib/build.mjs --id rx7-fd --dry-run     # the prompt only, nothing spent
    node tools/assetlib/build.mjs --id rx7-fd
    node tools/assetlib/build.mjs --class hero-car          # the whole roster, resumable

`ASSETLIB_DATA` points `specs/`, `out/` and `candidates/` at a volume. Unset, they are beside this
file, which is what a checkout looks like. In the pod it is the editor's volume, so a finished
model outlives the image that made it.

## Where this came from, and what changed

It lived at `ext/assetlib/tool/`, untracked, because it was staging. The unification handoff of
2026-09-27 asks for it in the tree so it can run in the world-editor pod, so it is here, and the
only edits are the two that a move requires: imports of `tools/assetgen` are now relative to
`tools/`, and the data root is configurable rather than "one directory up from the code". The
recipe itself is untouched.

**`ext/assetlib/` is still the asset-library agent's working copy.** This is a copy, not a move,
so nothing was taken out from under a running session. When they are at a stopping point that
directory should go and this becomes the only one.

## The recipe, which is measured and not taste

Reconstruction quality is set almost entirely by the source image. All of this was found by
building the same car repeatedly and looking at it:

1. **Saturated mid-tone paint. Never black, white, grey or silver.** Black gives no shading
   gradient, so the mesh is blotchy and the far flank comes back black; grey and silver arrive
   mottled; white makes the glass key drift. Paint is recolourable downstream and a bad mesh is
   not — 39 specs were repainted for this, including most of the commercial roster, which is
   realistically white.
2. **Lightbox-flat lighting, stated explicitly.** TRELLIS bakes lighting into base colour and
   wraps it onto the half it never saw. Flat light fixed a black far flank outright.
3. **Camera raised about 20 degrees.** At eye level the roof is edge-on and the rear window
   invisible, so both get invented — in plausible brown, not the glass key.
4. **Glazing is keyed at generation, not inferred afterwards.** Inferring glass by colour or luma
   does not port: a black car keys as 42% glass. Paint the windows a key colour in the render and
   select by lookup. Which keys survive is measured: **green backdrop → magenta, blue or red;
   magenta backdrop → green or cyan.**
5. **Choose the key by hue distance from the paint.** First-fit put magenta on a bronze van; they
   share red, the key desaturated into the paint, and 0.05% of faces were selectable. Hue-distance
   scoring gives that van blue glass: 2.41%.
6. **`finish()` is not the source of mesh roughness.** 0.05/1024px against 0.30/2048px is visually
   identical; the ripple is in the raw reconstruction. Do not spend time there.

Known boundary: a car with a tiny, steeply raked cabin (Countach) shows almost no glazing in any
single view, so the key cannot survive it. Single-view reconstruction is the limit. `1536_cascade`
exists in TRELLIS.2 and needs the same loaded models as `1024_cascade`, but `reconsvc/main.py`
does not expose `pipeline_type` — that is an open ask with the photogrammetry agent and the single
biggest quality lever available.

## The two model classes, and why the editor cares

| | cost | what that means |
|---|---|---|
| image (flux.2-dev) | ~10 s a 1024² view | iterate freely, show options |
| mesh (TRELLIS.2) | ~30-40 s, one GPU, serialised | only reconstruct what a human accepted |

The editor's job is to make that asymmetry visible: **pick from pictures, commit to meshes.** A
120-asset run is unattended hours on one GPU; queue it, do not fan out expecting parallelism.

## A seed is part of a spec

Two generations from one prompt are two different cars. The accepted seed is the only thing that
makes an asset reproducible, so `candidates.mjs` draws N and the one a human picks is pinned.
