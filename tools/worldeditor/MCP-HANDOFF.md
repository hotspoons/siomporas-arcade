# Handoff: the editor as an MCP server

**From** the `agentmcp` lane. **Branch** `agent/mcp` (merged up to `main@1096267`, merges clean).
**Not merged.** Everything below is on that branch and nowhere else.

## Read this first: why Rich cannot see it

He looked in the editor for the MCP configuration and found nothing. That is correct and expected —
**the branch is not merged**. `main` is `1096267`; the deployed `worldeditor` and every local
server on 8780/8790 are running code that has none of this in it.

There is nothing to debug about its absence. There *is* one thing to verify about its presence,
and it is the honest gap in this work — see **The one unverified thing** below.

## What it does

An outside agent (Claude Code, or anything speaking MCP) drives the editor through one URL:

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

- **61 tools run server-side**, against this service's own `/api` handlers — so they work with no
  browser open. Worlds, levels, programs (files *and* folders, with rename), catalog, models,
  generated assets, materials, bakes, publishes, splat training, captures, places.
- **7 tools run in an attached editor page**, over a websocket the page dials out on: the wasm
  shell (`shell_exec`, `shell_list`) and Monaco's TypeScript service (`code_check`,
  `code_outline`, `code_hover`, `code_definition`), plus `editor_state`.
- **The token** is minted on first start, kept `0600` at `<data>/agent/mcp-token.json`, shown in
  the Agent tab with a copy button, overridable, regenerable, and required by default anywhere
  that is not plainly localhost.

`tools/worldeditor/MCP.md` is the full surface and the reasoning. This file is only what you need
to finish it.

## THE BLOCKER, and it is not mine

**`main` does not typecheck, and has not for at least a day.** Four files exist only uncommitted in
the shared checkout at `/workspaces/apex-conduit`:

```
apps/corridor/src/ui/actors.ts
apps/corridor/src/ui/weapons.ts
apps/corridor/src/ui/vehicles.ts
apps/corridor/src/weapons.ts
```

`apps/corridor/src/ui/assets.ts`, `apps/corridor/src/worldedit/main.ts` and
`apps/corridor/test/weapons.test.ts` all import them. Consequences:

- `npx tsc --noEmit -p apps/corridor/tsconfig.json` fails on `main` and on every branch cut from it
- `npx vitest run` — 679 tests pass, `test/weapons.test.ts` cannot load at all
- **the editor page cannot build for anyone but the lane with those files on disk**

They build for you because your working tree has both the committed and the uncommitted files, and
nothing distinguishes them when you run. This is the same trap two other lanes hit last week from
the other side. A worktree makes the gap loud.

`git add apps/corridor/src/{ui/actors.ts,ui/weapons.ts,ui/vehicles.ts,weapons.ts}` is presumably
all it wants, but they are yours and I have not read them, so I have not committed them. I did
borrow them once to try a browser test, found they also need `../actorspecs` and a newer
`AssetItem`, and backed them out rather than measure a half-merged state that is nobody's reality.

## The one unverified thing

**I have never seen the MCP pane render in a browser.** It could not be done: the editor page does
not build, for the reason above.

What IS verified, against a running service and a real socket:

| | |
|---|---|
| `tools/list` | 61 server tools; 68 with a page attached |
| no `Authorization` header | 401 |
| wrong token | 401, and a *different* message — the two mistakes are different |
| `world_list`, `program_list` | real worlds and programs |
| `asset_list`, `asset_services`, `material_list` | real data, against a live assetsvc |
| `shell_exec` with nothing attached | the actionable error, `isError: true` |
| MCP → bridge → page → back | `shell_exec` and `code_check` answered by an attached page in the same session as `world_list`; a client cannot tell which side ran |
| `node --test tools/worldeditor/*.test.mjs` | 113/113, including 6 new bridge tests |

Three of those bridge tests assert **failures**: a wrong token does not open the socket, a page
that disconnects mid-call fails *that call* instead of hanging to timeout, and an unclaimed tool
names the fix. A check that can only pass is not a check.

So the bridge *protocol* is proven end to end. The browser tool *bodies* — the shell and the
language service — are exercised by a fake page that speaks the wire format, not by the real
editor. **That is the gap and it closes the moment `main` builds.**

## What to do, in order

1. **Commit the four files.** Nothing else can be checked until the editor builds.
2. **Merge `agent/mcp`** (it merges clean as of `1096267`).
3. **Open the editor → Agent tab.** The MCP section is in the sidebar, below the session
   controls. Confirm it shows a URL, a token, and the `mcpServers` block, and that the status line
   under "This page" reads **attached**.
4. If it does not appear, the two likely causes, in order:
   - `api.mcpConfig()` failed → the pane says *"The service did not answer about MCP"*. Check
     `GET /api/agent/mcp/config` returns JSON rather than the `mcpServers` payload — see the route
     trap below.
   - `drawSidebar()` ran before the hook existed → the pane is appended by an optional
     `extraSections` callback at the END of `AgentPanel.drawSidebar()`. If you have since moved or
     rewritten that method, the call may have been dropped.
5. **Then exercise the two browser tool groups for real**: with the editor open, call `shell_exec`
   and `code_check` over MCP and confirm they come back from the page rather than erroring. That
   is the last untested path.

## What I changed in your files

Everything else is new files (`mcpauth.mjs`, `mcpbridge.mjs`, `mcptools.mjs`, `mcpbridge.test.mjs`,
`MCP.md`, `agent/bridge.ts`, `agent/lsp.ts`, `ui/mcppanel.ts`).

| file | lines | what |
|---|---|---|
| `tools/worldeditor/mcp.mjs` | +41 | merge three tool sources; route a call by origin |
| `tools/worldeditor/server.mjs` | +56 | `mcpAuth` + `mcpBridge`, an `apiFetch`, two config routes, one auth check, one `attach` beside your relay |
| `apps/corridor/src/ui/agentpanel.ts` | +11 | **one** optional `extraSections` hook, called last |
| `apps/corridor/src/worldedit/api.ts` | +17 | `mcpConfig`, `setMcpToken` |
| `apps/corridor/src/worldedit/main.ts` | +52 | the bridge and the pane, wired |
| `apps/corridor/src/ui/ui.css` | +31 | `.mcp-*` and a `.dot` |

The `agentpanel.ts` hook is a callback rather than an import on purpose: that panel should keep
knowing only about the session. The MCP pane is about an agent that is *not* in its transcript.

Any of these can be reverted on its own. Ask and I will hand you a patch instead.

## Traps, both of them route collisions

**`/api/agent/mcp` matched `/api/agent/mcp/config`.** Your GET branch does not check `seg.length`,
so it answered the config request with the `mcpServers` payload and the pane saw the wrong shape. I
declared the config routes *above* it rather than changing yours — same result, less invasive — but
the looseness is still there and will catch the next `/api/agent/mcp/<anything>`.

**The assetsvc proxy is at `/assetsvc/…`, not `/api/assetsvc/…`.** That one was mine: I wrote ten
tools by analogy with the rest of the table and got a **404 from the router** instead of a 503 from
the proxy. Both read as "the asset service is down" unless you look at the body. Only caught
because assetsvc was not running locally and I went to find out why the 404 said *no route*
instead of *not configured*.

## Not built, and why

Rich's brief also named **vehicles, actors, weapons, physics profiles** and **rigging through the
blender bridge**. I found no endpoints for them: no `rig`/`blender` route in either service, and
the vehicle/actor/weapon model appears to live on `AssetItem` in the very files that are not
committed. Rather than invent tool names against a shape I cannot see, I stopped. **Once the four
files land, tell me the shape and those tools are an afternoon** — the table in `mcptools.mjs` is
one entry per tool and needs nothing else.

— `agentmcp`
