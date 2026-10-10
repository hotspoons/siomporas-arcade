# Splitting corridor out of the arcade: the piedmont repository

Status: **in progress** (started 2026-10-10). Owner: Rich. This page is the plan, the work on both
sides, and the acceptance criteria. The arcade keeps its corridor copy until every criterion in
[Acceptance](#acceptance-criteria) is checked off in the piedmont repo.

## What piedmont is

Everything that today is "corridor", moved to its own repository, `github.com/hotspoons/piedmont`
(checked out locally at `ext/piedmont`):

- the open-world game and its in-browser editors (today `apps/corridor`);
- the world baker (`tools/corridor`, Python);
- the services: world editor + MCP (`tools/worldeditor`), asset service (`tools/assetsvc`),
  Overpass instances and OSM imports (`tools/overpass`), recon service (`tools/recon-service`);
- the asset pipelines: AI image and mesh generation (flux2, TRELLIS.2 adapters), the asset
  library, Blender rigging, surfaces, sky and sound bank (`tools/assetlib`, `tools/assetgen`,
  `tools/blender`, `tools/rigging`, `tools/surfaces`, `tools/sky`, `tools/sounds` — the split
  inventory confirms each one belongs to the game and not to another arcade title);
- the splat pipeline's integration (the trainer itself stays in `hotspoons/gaussworks`, see below);
- its deploy story: Helm charts and cluster values, and the Docker/DinD stack (branch
  `agent/docker`, landing in piedmont rather than the arcade);
- its docs (`docs/corridor`), probes (`probes/corridor-*`, the world-editor and bake probes) and CI
  (`corridor-image`, `worldeditor-image`, `assetsvc-image`, `recon-image`, `blender-image`).

What stays in the arcade: `packages/engine`, `packages/enginesim`, `packages/stunt-pieces` (shared
library code), and the other games (`conduit`, `coast`, `stuntin`, `fighter`, `arcade`, …).

## Decisions (Rich, 2026-10-10)

| Question | Decision |
|---|---|
| How piedmont gets `@apex/engine`, `enginesim`, `stunt-pieces` | A pinned arcade git ref, fetched and prepared on install (`arcade.json` in piedmont). No registry, no tokens. If `ext/siomporas-arcade` is checked out, piedmont links to it instead, so both repos can be edited together. |
| Git history | Fresh start: one import commit in piedmont. History stays in the arcade. |
| gaussworks (splat trainer) | Stays its own repo. Piedmont's setup clones it into `ext/gaussworks` automatically so edits are handy; piedmont references the trainer by image. |
| Dev container | Based on the arcade's `.devcontainer` (its bind mounts, the cross-platform `initializeCommand`, `post-create.sh`, the Blender build volume), plus Docker-in-Docker, Helm, kubectl and the bake's Python/GDAL/PDAL toolchain. |
| Naming | No `corridor` anywhere in piedmont's source, APIs or docs — a CI check enforces it. |
| AI inference (flux2, TRELLIS) | Separate from the main Docker stack, reached by URL, so it can be outsourced. |

## The rename

`corridor` goes everywhere, including identifiers where it meant "the band along the roads" (those
become `roadBand` / `road_band`, which is what they are). The map the port follows:

| Today | In piedmont |
|---|---|
| `apps/corridor`, `@apex/corridor` | `apps/game`, `@piedmont/game` |
| `tools/corridor` (Python package `corridor`, `python -m corridor`) | `bake/` (package `piedmont_bake`, `python -m piedmont_bake`) |
| `tools/worldeditor`, `tools/assetsvc`, `tools/overpass`, `tools/recon-service` | `services/worldeditor`, `services/assetsvc`, `services/overpass`, `services/recon` |
| `tools/assetlib`, `assetgen`, `blender`, `rigging`, `surfaces`, `sky`, `sounds` | `pipelines/<same name>` |
| `docs/corridor/*` | `docs/*` |
| images `ghcr.io/hotspoons/corridor`, `worldeditor`, `assetsvc`, `recon`, `blender` | `ghcr.io/hotspoons/piedmont-bake`, `piedmont-worldeditor`, `piedmont-assetsvc`, `piedmont-recon`, `piedmont-blender` |
| env `CORRIDOR_*`, `WORLDEDITOR_*` | `PIEDMONT_*` (`PIEDMONT_EDITOR_*` for the editor) |
| `window.corridor`, `apex-corridor.*` storage keys | `window.piedmont`, `piedmont.*` |
| MCP server `corridor-world-editor` | `piedmont-world-editor` |
| k8s labels and Job names `corridor-bake-*` | `piedmont-bake-*` |
| `tools/corridor/data` (cache, sites — 60+ GB) | not in git: `$PIEDMONT_DATA` (default `data/`, ignored), bind-mounted in the dev container and the compose stack |

Stored state from the old names is not migrated (a clean break, as with the URL scheme). Worlds,
levels and assets move between deployments with the editor's own export/import (MCP
`world_export` / `world_import`), not by copying volumes.

## Work in the piedmont repo

1. **Import.** Copy the paths above from arcade `main` at a recorded commit into the new layout, one
   import commit. Record that commit in `docs/ORIGIN.md` so later arcade changes to the same files
   can be ported.
2. **Rename** per the table, with a `scripts/check-names.mjs` that fails on any `corridor`
   (case-insensitive) in tracked files, run by CI and by `npx vitest run`.
3. **Arcade dependency.** `arcade.json` pins `{ repo, ref, packages }`. `npm run setup`:
   - if `ext/siomporas-arcade` exists, links its `packages/*`;
   - else shallow-fetches `ref` into `.cache/arcade/<ref>` and links those;
   - either way the packages resolve as npm workspaces (`vendor/arcade/packages/*`), source-level
     TypeScript as they are consumed today (`"exports": {"./*": "./src/*.ts"}`), so `tsc -b`, vitest
     and Vite see them exactly as in the arcade.
   `npm run arcade:bump <ref>` updates the pin.
4. **gaussworks.** `npm run setup` clones `hotspoons/gaussworks` into `ext/gaussworks` if absent.
5. **Dev container** from the arcade's (decision above), adding DinD (`docker-in-docker` feature),
   Helm, kubectl (already in `post-create.sh`), Python 3 with the bake's requirements, GDAL/PDAL, and
   the data bind mount. Ports: the game's dev server, the world editor, the asset service.
6. **CI** (GitHub Actions): typecheck, `npx vitest run` (game, services' node suites, oxlint, the
   names check), the bake's `python -m unittest discover`, the build, and the image builds under
   the new names.
7. **Deploy:** Helm charts under `deploy/helm`, cluster values under `deploy/<cluster>/` with the
   namespace as a value (no hard-coded `corridor`/default namespace), and the Docker/DinD stack
   under `deploy/docker` (+ the separate AI stack).
8. **Docs:** README quick start (devcontainer → setup → dev → bake a small world → play), an
   architecture page, one page per service and pipeline, deploy (Helm and Docker), the MCP
   reference, the acceptance checklist; every link checked by CI.

## Work in the arcade repo

1. **Now:** this page. Corridor stays where it is and keeps working; nothing is removed.
2. **Pin target:** tag the commit piedmont pins (e.g. `engine-v2026.10.10`) and keep the shared
   packages' public surface stable across tags; note breaking engine changes in a changelog.
3. **While both exist:** new corridor work goes to piedmont. Branches already open against the
   arcade (`agent/full-world`, `agent/docker`) are ported to piedmont, not merged here. Any fix that
   does land in the arcade's corridor copy is ported, using `docs/ORIGIN.md` in piedmont.
4. **After acceptance:** one PR removes `apps/corridor`, the corridor-only tools, probes, docs and
   workflows (the `corridor-image`, `worldeditor-image`, `assetsvc-image`, `recon-image`,
   `blender-image` CI), and the corridor ports from the devcontainer; the arcade's build, tests and
   other games must stay green. The cluster's old `corridor`-named releases are retired once the
   new namespace serves everything.

## Acceptance criteria

Checked off in piedmont's `docs/ACCEPTANCE.md`, each with the command or link that proves it.

**Bootstrap and build**
- [ ] A fresh clone opened in the dev container reaches a working shell with Node, Python, GDAL,
      PDAL, Docker (DinD), kubectl and Helm, and the host bind mounts (`~/.kube`, `~/.claude`,
      opencode, the data volume) in place.
- [ ] `npm run setup` fetches the pinned arcade packages (no `ext/siomporas-arcade`), clones
      gaussworks into `ext/gaussworks`, and installs Node and Python dependencies, from nothing.
- [ ] With `ext/siomporas-arcade` checked out, setup links it instead, and an edit to
      `packages/engine` shows up in piedmont's dev server without reinstalling.
- [ ] `npx tsc -b`, `npx vitest run` (including the services' suites, oxlint and the names check),
      the bake's unit tests and `npm run build` all pass locally and in CI.
- [ ] `scripts/check-names.mjs` reports zero `corridor` references in tracked files.

**Runs locally**
- [ ] The game's dev server serves a baked world, which boots headlessly
      (`--use-gl=swiftshader`) with no page errors and reaches `window.piedmont.site`.
- [ ] The editor opens that world; the world editor service starts and lists worlds; its MCP
      endpoint answers `tools/list` under the new server name.
- [ ] A small world bakes with the local runner, publishes, and plays.

**Images and deploy**
- [ ] CI builds and pushes every image under its new name.
- [ ] A fresh deployment in a NEW namespace on the cluster (Helm, Rich runs or approves it) brings
      up the world editor, asset service and at least one Overpass instance, all healthy.
- [ ] From that deployment: draw a small world, bake it (single Job, and sharded), publish it, play
      it in a browser; run an OSM region import; generate one asset through the asset service
      against the configured AI endpoints; start a splat training run where a GPU is available.
- [ ] The Docker/DinD compose stack comes up on a host with one `docker compose up` and bakes a
      small world (the docker lane's own smoke test).

**Docs**
- [ ] README quick start works as written on a fresh machine.
- [ ] Every service, pipeline and deploy path has its page; the link check passes; no page names
      `corridor` or points into the arcade for anything piedmont now owns.

**Arcade side (closes the split)**
- [ ] The arcade tag piedmont pins exists and piedmont builds against it.
- [ ] The removal PR is green in the arcade and merged only after every box above is checked.
