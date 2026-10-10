# The editor as an MCP server

An outside agent — Claude Code, or anything that speaks MCP — drives this editor through one URL:
the worlds, the levels, the TypeScript programs, the asset catalog, the materials, the bakes and
the splat runs. Two of those need a browser tab open; the rest do not.

```json
{
  "mcpServers": {
    "corridor-world-editor": {
      "type": "http",
      "url": "https://<editor>/api/agent/mcp",
      "headers": { "Authorization": "Bearer aat_…" }
    }
  }
}
```

The Agent tab prints that block with the real URL and token in it. Copy it; do not retype it.

## The token

Minted on first start, kept `0600` at `<data>/agent/mcp-token.json`, and shown in the Agent tab
because its whole purpose is to be pasted into a config file. Override it by pasting your own and
pressing **Save this token**, or regenerate — which immediately breaks every client configured
with the old one, so the button says so.

| | |
|---|---|
| `WORLDEDITOR_MCP_TOKEN` | set it from a Secret and the file is never written. The tab then shows it read-only, because changing it belongs where it is set |
| `WORLDEDITOR_MCP_AUTH` | `off` to disable, anything else to force it on |
| default | **on**, unless `WORLDEDITOR_HOST` is plainly localhost |

The default is on because the failure modes are not symmetric: a needless token costs a
copy-paste, and a missing one costs whatever the cluster can reach.

`GET /api/agent/mcp/config` is deliberately **not** gated — it is what the Agent tab reads to show
you the token, and needing the secret to learn the secret is a locked door with the key inside.
It is same-origin, behind whatever fronts the editor.

## Where the tools run, and why it matters

```
  agent ──HTTP──> /api/agent/mcp ──┬── 57 tools run HERE, against this service's own /api
                                   │   (mcptools.mjs) — they work with no browser open
                                   │
                                   └── 7 tools run in an attached EDITOR PAGE, over a websocket
                                       the page dials out on (mcpbridge.mjs + agent/bridge.ts)
```

The sketch for this was to put every tool in the UI and have the service call the page. That is
right for three things and wrong for the rest, because the rest are already handlers here.
Server-side means an agent can fix a world at three in the morning with the tab shut, and it means
one implementation of each rule rather than two that drift.

Each server-side tool goes back through this service's **own HTTP API** rather than reaching into
`store` and `levels`. That hop is deliberate: a level written by an agent is validated by the code
that validates one written by a person clicking Save.

Three things genuinely cannot leave the page, so the bridge carries them:

| | |
|---|---|
| `shell_exec`, `shell_list` | a wasm build of coreutils, python and js in a Worker, whose filesystem is the projected documents. There is no process for the service to spawn |
| `code_check`, `code_outline`, `code_hover`, `code_definition` | Monaco's TypeScript service, with the program API's declarations loaded. A `tsc` on the service would not know what `api.physics` is |
| `editor_state` | what is open and selected right now |

When no page is attached those tools are **absent from `tools/list`** — advertising a tool that
must fail is worse than not having it — and calling one by name says *"no editor is attached, open
the world editor"* rather than "no such tool", which would send an agent hunting for a typo.

## The tools

| prefix | what |
|---|---|
| `world_*` | list, get, preview a boundary before committing, create, save, delete |
| `level_*` | list, get, **validate** (every problem, plus the vocabulary a scenario may use), save, delete |
| `program_*` | the program tab: list, read, write, **move** (rename in one operation), **mkdir**, delete — `recursive` for a folder, asked for explicitly so a mistyped file path cannot become a recursive delete |
| `code_*` | typecheck, outline, hover, definition — *needs a page* |
| `shell_*` | run commands over the documents — *needs a page* |
| `catalog_*`, `model_list` | what is placeable |
| `asset_*` | the generation catalog: describe, draw (2D), mesh (3D), choose a view, fork, job status, services, sync to S3 |
| `material_*` | generate a texture set as a **draft**, inspect it, save or discard — a wrong texture must not replace a working one before anyone looks |
| `run_*` | bake and publish, with logs and cancel. A bake is hours |
| `splat_*` | gaussian training: plan, gpus, runs, start, delete, and the manifest a run *would* submit |
| `capture_*` | the video a splat is trained from |
| `place_*` | search the earth, and the saved place index |
| `editor_config`, `editor_ready`, `editor_version` | what is configured, what is answering, and WHICH BUILD — a program that typechecks against one editor can fail in another |
| `program_api` | the program API's declarations (`@apex/program` and the other importable modules) — read before writing a program; nothing else says what `api` can do |
| `program_refs` | everything a program can name in ONE world — traffic zones, points, placements, stunts, races, the level's builds, every sound slot, every spawnable library id — each with a description and a snippet that typechecks as inserted (the Program pane's "In this world" list, the same rows) |
| `level_vocab` | the words a level and a program may use: weather, season, profiles, point kinds, hideables, transports, HUD parts, setting ids, every engine-sound setup |
| `site_roads`, `site_road_polygon`, `site_road_gate` | the roads of a bake in site metres; a zone polygon along one; a race gate across one |
| `site_project`, `address_search`, `point_add` | lat/lon → site metres through the bake's own frame; the bake's OSM addresses, places and roads by name; a named point (start, finish, home) into points.json — by metres, by lat/lon, or along a road |
| `traffic_zone_add`, `course_save`, `vehicle_*`, `traffic_set_*` | zones, races, vehicle builds and traffic sets: the level's moving parts |
| `asset_view` | **look** at a generated view, as an image — the only way to judge a drawing before meshing it |
| `list/read/write_document`, `validate_level` | the original four, unchanged |

## Traps, measured

**The assetsvc proxy is at `/assetsvc/…`, not `/api/assetsvc/…`.** Writing the asset tools by
analogy with every other tool produced a **404 from the router** rather than a 503 from the proxy,
which is the tell: the request never reached the proxy at all. Worth knowing because both look
like "the asset service is down".

**`/api/agent/mcp` matched `/api/agent/mcp/config`.** The existing GET handler does not check path
length, so the config route had to be declared *above* it. A route that matches more than it means
to fails silently in exactly one direction.

**A page that disconnects mid-call.** The call fails at once with *"the editor page disconnected"*
rather than sitting until the 120s timeout and reporting *"did not answer"* — the second reads as
"the tool is slow", which is the wrong thing to go and investigate.

## Running it

```bash
node tools/worldeditor/server.mjs --port 8780
curl -s localhost:8780/api/agent/mcp/config | jq        # the url, the token, who is attached
node --test tools/worldeditor/mcpbridge.test.mjs        # the socket, including its failures
```

The bridge tests assert the three things that must *fail*: a wrong token does not open the socket,
a disconnect fails the in-flight call, and an unclaimed tool names the fix. A check that can only
pass is not a check.
