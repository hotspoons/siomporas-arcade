# worldeditor: the pod where a person turns OSM into a corridor world.
#
# TWO STAGES, AND THE FIRST ONE IS THE POINT. This service serves the built `apps/corridor` — all
# three pages, the viewer, the site editor and the world editor — from its own origin, because the
# editor's save path is a PUT to `/sites/<slug>/<file>.json` on the SAME origin and there is no
# Vite in a pod to answer it. Shipping the service without the app would mean a second host, CORS,
# and a page that knows two origins; the whole design is that the browser knows one.
#
# No CUDA, no weights, no python. The bake runs in its own image (`ghcr.io/hotspoons/corridor`) as
# a Job this service creates; this one reads OSM, writes JSON and watches logs.

# ---- build the three pages ---------------------------------------------------------------------
FROM node:22-slim AS app
WORKDIR /src
# The lockfile and every workspace manifest first, so a change to a source file does not re-resolve
# the dependency tree. `npm ci` needs the WHOLE workspace layout — `workspaces: ["apps/*",
# "packages/*"]` — so one missing package.json fails the install even though this image builds a
# single app. `ls apps/*/package.json packages/*/package.json` is the list.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/conduit/package.json apps/conduit/
COPY apps/stuntin/package.json apps/stuntin/
COPY apps/coast/package.json apps/coast/
COPY apps/arcade/package.json apps/arcade/
COPY apps/fighter/package.json apps/fighter/
COPY apps/drivin-redirect/package.json apps/drivin-redirect/
COPY apps/corridor/package.json apps/corridor/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY packages/engine/ packages/engine/
COPY apps/corridor/ apps/corridor/
# `vite build`, not `npm run build` at the root: that builds every app in the repo and this image
# serves one of them.
RUN npm run build -w apps/corridor

# ---- the service -------------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
# No dependencies. Every module here is node builtins plus the four files beside it — SigV4 by
# hand, the Kubernetes API by hand, no SDK — which is why there is no `npm install` in this stage.
COPY tools/worldeditor/ tools/worldeditor/
COPY --from=app /src/apps/corridor/dist/ apps/corridor/dist/
# The seed: a volume with no worlds on it starts life knowing about the sites already in the repo,
# so a fresh pod is not an empty list. It is copied, never read at runtime after the first start.
COPY tools/corridor/sites.json tools/corridor/sites.json
# The placement catalog the editor reads, as the fallback under whatever the volume holds.
COPY apps/corridor/public/assets/catalog.json apps/corridor/public/assets/catalog.json

RUN useradd -u 10001 -m app && mkdir -p /data && chown app /data
USER 10001

ENV WORLDEDITOR_DATA=/data \
    WORLDEDITOR_APP=/app/apps/corridor/dist \
    WORLDEDITOR_SEED_SITES=/app/tools/corridor/sites.json \
    WORLDEDITOR_HOST=0.0.0.0 \
    WORLDEDITOR_PORT=8780 \
    NODE_ENV=production
VOLUME /data
EXPOSE 8780

ENTRYPOINT ["node", "tools/worldeditor/server.mjs"]
