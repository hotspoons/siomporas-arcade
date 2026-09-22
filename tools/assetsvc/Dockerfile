# assetsvc: the backend that orchestrates asset generation. No CUDA, no model weights, no GPU.
#
# This image is deliberately boring. The GPUs live in `recon` and in the flux deployment; this
# calls them over the cluster network and does bookkeeping. That is why it is a 200 MB node image
# that builds in a minute for both architectures, rather than a CUDA base that takes an hour.
#
# WHAT IT DOES NEED is the glTF toolchain, because finishing a reconstruction runs
# @gltf-transform/cli three times. That is installed HERE rather than fetched by `npx` at runtime:
# a pod that reaches out to the npm registry the first time somebody finishes a mesh is a pod that
# fails on an air-gapped cluster and is slow on every cold start.
FROM node:22-slim

# gltf-transform's draco and meshopt paths are prebuilt wasm/native for linux; nothing to compile.
WORKDIR /app

# The CLI and the three libraries finish.mjs imports. Pinned major, so a surprise release cannot
# change the geometry of every asset generated after it.
RUN npm install --no-audit --no-fund --omit=dev \
      @gltf-transform/cli@4 \
      @gltf-transform/core@4 \
      @gltf-transform/extensions@4 \
      @gltf-transform/functions@4 \
      draco3dgltf@1 \
      meshoptimizer@0.22 \
 && npm cache clean --force

# The service, and the finisher it calls. finish-one.mjs imports finish() out of
# tools/assetgen/finish.mjs — the one copy of the simplify/unlit/Draco knowledge, not duplicated
# here — and THAT file imports loadSpecs and expand from proportion.mjs and generate.mjs at module
# level, so all three have to be present or the import throws. They pull in node builtins only,
# and assets.json is read when loadSpecs is CALLED (the CLI path, which assetsvc does not use), so
# three files is the whole closure. `grep "from './" tools/assetgen/*.mjs` if that ever changes.
COPY tools/assetsvc/ tools/assetsvc/
COPY tools/assetgen/finish.mjs tools/assetgen/proportion.mjs tools/assetgen/generate.mjs tools/assetgen/

# Data never lives in the image: ASSETSVC_DATA is the mount (a PVC in the chart).
RUN useradd -u 10001 -m app && mkdir -p /data && chown app /data
USER 10001

ENV ASSETSVC_DATA=/data \
    ASSETSVC_HOST=0.0.0.0 \
    ASSETSVC_PORT=8770 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=2048
VOLUME /data
EXPOSE 8770

# A reconstruction comes back as tens of megabytes and is held in memory while it is written, so
# the heap ceiling above is not decoration.
ENTRYPOINT ["node", "tools/assetsvc/server.mjs"]
