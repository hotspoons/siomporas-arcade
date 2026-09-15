# recon — image set in, 3D asset out

A service around [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) for the fighter pipeline:
POST a character's views, get a mesh back. Step 1 of
[`tools/photogrammetry/README.md`](../photogrammetry/README.md), packaged so it can be called
rather than babysat.

```bash
# start a job
curl -sF images=@kestrel-front.png -F images=@kestrel-side.png \
     https://recon.bradley-hartlove-gh200.basedweights.com/reconstruct
# {"job":"3f9a1c2d4e5b","views":2,"poll":"/jobs/3f9a1c2d4e5b"}

curl -s https://recon.../jobs/3f9a1c2d4e5b
# {"job":"...","state":"done","vertices":184320,"faces":368204,"seconds":41.2,"views":2, ...}

curl -sO https://recon.../jobs/3f9a1c2d4e5b/asset      # the .glb
```

Jobs are asynchronous because a reconstruction takes tens of seconds — too long to hold a
connection open for a whole roster. One GPU means one job at a time, so requests queue behind an
internal lock rather than racing each other into an out-of-memory.

**Send keyed cut-outs if you have them.** The service keeps an alpha channel when one is present.
Our green-screen key is better than any background remover the model would otherwise run, and
passing flattened RGB throws that away and makes it guess again.

## Why TRELLIS.2 and not TRELLIS

TRELLIS 1 cannot run on the GH200s. It needs `spconv`, which ships only as x86 wheels with no
source path that builds on aarch64. TRELLIS.2 dropped `spconv` entirely and builds its four CUDA
extensions from source, which is what makes it work here.

## Building on Grace-Hopper (aarch64 + CUDA 13)

Hard-won and all encoded in the `Dockerfile`; the notes below are why each line is there.

- **The full CUDA toolkit, not a runtime image.** The extensions compile against `cusparse.h` and
  then `cusolverDn.h`, and a trimmed install fails on them one at a time.
- **Install CuMesh *before* o-voxel.** o-voxel declares `cumesh` as a dependency, so if it is not
  already installed pip quietly builds its own unpatched copy and the patch never applies.
- **The CUDA 13 patch:** `cub::Sum()` was removed; replace it with `thrust::plus<float>()` in
  `CuMesh/src/atlas.cu`. Credit to `ehuqija217-max` in
  [microsoft/TRELLIS.2#19](https://github.com/microsoft/TRELLIS.2/issues/19).
- **`TORCH_CUDA_ARCH_LIST=9.0`.** GH200 is Hopper. The people in that issue were on Blackwell and
  used `12.0`; copying their flag builds for the wrong card.
- **No flash-attn.** TRELLIS.2 accepts `ATTN_BACKEND=sdpa` and torch's own attention, which skips a
  long, fragile source build. Set it, or the default tries to import flash-attn and dies.
- **`libeigen3-dev` plus a symlink.** o-voxel includes `<Eigen/Dense>`; Debian installs to
  `/usr/include/eigen3/Eigen`.
- **GL/EGL dev headers.** `utils3d` pulls in `glcontext`, which will not build without them.
- **`nvdiffrast` is not optional** despite being a flag in upstream's `setup.sh` — `o_voxel`
  imports it at module level.

## Loading the weights

Pass a **local snapshot directory**, not the repo id. `Trellis2ImageTo3DPipeline.from_pretrained`
wraps its sub-model loading in a bare `try/except` (`trellis2/pipelines/base.py:46`) whose fallback
re-splits a relative checkpoint path into a nonsense repo id — you get a 401 for a repository named
`ckpts/shape_dec_next_dc_f16c32_fp16` and no sign of the original error. Download the repo once and
point at the snapshot; everything then resolves as local files.

## Deploying

```bash
helm upgrade --install recon ./chart -n default
```

`values.yaml` defaults to the Gateway API `HTTPRoute` this cluster already uses. A classic Ingress
is included but off — enabling both means two objects claiming one hostname.

Weights (~16GB) go on a PVC so a restart is seconds rather than a re-download. The startup probe
allows 15 minutes: the liveness probe deliberately hits `/healthz` rather than `/readyz`, so a long
reconstruction is never mistaken for a hung process.
