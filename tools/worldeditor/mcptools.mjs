// The editor's own API, as MCP tools.
//
// WHY THESE ARE SERVER-SIDE. Rich's sketch was to put the tools in the UI and have the service
// call the page over a websocket. That is right for the three things only a page can do — the wasm
// shell, Monaco's TypeScript service, what is currently on screen — and it is wrong for everything
// else, because everything else is ALREADY a handler in server.mjs. Implementing those here means
// they work with no browser open, which is the difference between an agent that can fix a world at
// three in the morning and one that needs somebody to leave a tab up.
//
// EACH TOOL IS THE EDITOR'S OWN REQUEST. They go back through this service's HTTP API rather than
// reaching into `store` and `levels` directly. That is a deliberate hop: a level written through
// MCP is validated by the same code that validates one written by a person clicking Save, and a
// world created here gets the same warnings. Bypassing the route to save a millisecond would mean
// two paths to the same document, and the agent's would be the one nobody tested.
//
// THE SCHEMAS ARE THE DOCUMENTATION. An agent picks a tool by reading its description and nothing
// else, so each says what the thing IS and names the surprising part — that a write is live, that
// a delete of a folder is recursive, that a bake takes hours. None of them explain that `list`
// lists.

/** Tool names are grouped by prefix so a client that sorts them shows something coherent. */
const T = (name, description, properties, required = [], run) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  run,
})

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const obj = (description) => ({ type: 'object', description })

/**
 * Build the tool table.
 *
 * `apiFetch(method, path, body)` is the service calling itself — injected rather than imported so
 * this file has no opinion about ports, and so a test can hand it a fake.
 */
export function serverTools({ apiFetch }) {
  const get = (p) => apiFetch('GET', p)
  const post = (p, b) => apiFetch('POST', p, b)
  const put = (p, b) => apiFetch('PUT', p, b)
  const del = (p) => apiFetch('DELETE', p)

  return [
    /* ---- worlds ------------------------------------------------------------------------------
     * A world is WHERE: a boundary on the earth, a spine road, and the levels set in it. Creating
     * one is cheap and reversible; baking one is neither, which is why they are different tools.
     */
    T('world_list', 'Every world this editor knows: slug, name, where it is, and whether it has been baked.', {}, [], () => get('/api/worlds')),
    T('world_get', 'One world definition in full — boundary, spine, levels, bake state.', { slug: str('the world slug') }, ['slug'], (a) => get(`/api/worlds/${a.slug}`)),
    T(
      'world_preview',
      'What a boundary would contain before you commit to it: area, road length, how many tiles, whether it is too big to bake. Takes either a polygon or a centre and radius. Changes nothing.',
      { boundary: { type: 'array', description: '[[lat, lon], …]', items: { type: 'array', items: { type: 'number' } } }, centre: obj('{lat, lon}'), radius_m: num('metres, with centre') },
      [],
      (a) => post('/api/worlds/preview', a),
    ),
    T(
      'world_create',
      'Make a world from a boundary. Returns the world and any warnings — a warning is not a refusal, and a world with warnings still bakes.',
      { name: str('human name'), slug: str('optional; derived from the name otherwise'), boundary: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, centre: obj('{lat, lon}'), radius_m: num(''), spine: str('OSM ref or name of the main road') },
      ['name'],
      (a) => post('/api/worlds', a),
    ),
    T('world_save', 'Replace a world definition. LIVE: everyone with the editor open sees it. Moving a boundary after a bake reports how far it moved, because the bake no longer matches.', { slug: str(''), world: obj('the whole world document') }, ['slug', 'world'], (a) => put(`/api/worlds/${a.slug}`, a.world)),
    T('world_delete', 'Delete a world definition. The baked output, if any, is left alone.', { slug: str('') }, ['slug'], (a) => del(`/api/worlds/${a.slug}`)),

    /* ---- levels: a stage set inside a world -------------------------------------------------- */
    T('level_list', 'Every level: id, the world it belongs to, and its scenario.', {}, [], () => get('/api/levels')),
    T('level_get', 'One level document.', { id: str('') }, ['id'], (a) => get(`/api/levels/${a.id}`)),
    T(
      'level_validate',
      'Check a level without saving. Returns EVERY problem rather than the first, plus the vocabulary of facts and actions a scenario may use — which is the fastest way to find out what a level is allowed to say.',
      { level: obj('the whole level document') },
      ['level'],
      (a) => post('/api/levels/validate', a.level),
    ),
    T('level_save', 'Create or replace a level. Validated first; an invalid level is refused with its problems rather than written.', { id: str(''), level: obj('') }, ['id', 'level'], (a) => put(`/api/levels/${a.id}`, a.level)),
    T('level_delete', 'Delete a level.', { id: str('') }, ['id'], (a) => del(`/api/levels/${a.id}`)),

    /* ---- programs: the TypeScript beside the levels -------------------------------------------
     * This is the "program tab" surface. A program id IS a path — `levels/rooftop/run` — so
     * folders are real and `move` is a rename rather than a copy-and-delete that can lose a file
     * if the tab closes in between.
     */
    T('program_list', 'Every program file and folder. Folders are listed even when empty, because an empty folder is something somebody just made.', {}, [], () => get('/api/programs')),
    T('program_read', 'One program’s source.', { path: str('e.g. levels/rooftop/run — no extension unless it has one') }, ['path'], (a) => get(`/api/programs/${a.path}`)),
    T('program_write', 'Create or replace a program. LIVE: the editor reloads it. Writing is not compiling — use code_typecheck to find out whether it is valid.', { path: str(''), source: str('the whole file') }, ['path', 'source'], (a) => put(`/api/programs/${a.path}`, { source: a.source })),
    T('program_move', 'Rename or move a program or folder, in one operation.', { path: str('current path'), to: str('new path') }, ['path', 'to'], (a) => put(`/api/programs/${a.path}`, { move: a.to })),
    T('program_mkdir', 'Make a folder.', { path: str('') }, ['path'], (a) => post(`/api/programs/${a.path}`, {})),
    T('program_delete', 'Delete a program. Set recursive for a FOLDER and everything inside it — which is asked for explicitly so a mistyped file path can never become a recursive delete.', { path: str(''), recursive: bool('delete a folder and its contents') }, ['path'], (a) => del(`/api/programs/${a.path}${a.recursive ? '?dir=1' : ''}`)),

    /* ---- the asset catalog -------------------------------------------------------------------
     * Two different stores, and they are not the same thing. `catalog` is what this editor places:
     * the models it knows about. `assetsvc` is where an asset is GENERATED — a described prop in,
     * a textured glb out — and it is proxied through this service so the browser never reaches a
     * GPU. See tools/assetsvc/README.md.
     *
     * THE PROXY IS AT `/assetsvc/…`, NOT UNDER `/api`. Writing these by analogy with every other
     * tool here produced a 404 from the ROUTER rather than a 503 from the proxy, which is the
     * tell — the request never reached the proxy at all.
     */
    T('catalog_list', 'Everything placeable: models, their categories and where they came from.', {}, [], () => get('/api/catalog')),
    T('catalog_add', 'Add or update a catalog entry.', { entry: obj('the catalog item') }, ['entry'], (a) => post('/api/catalog', a.entry)),
    T('catalog_delete', 'Remove a catalog entry. The underlying model file is left alone.', { id: str('') }, ['id'], (a) => del(`/api/catalog/${a.id}`)),
    T('model_list', 'Every model file on the volume, with its size and format.', {}, [], () => get('/api/models')),

    T('asset_list', 'The generation catalog: described props and how far along each is — described, drawn, meshed, ready.', {}, [], () => get('/assetsvc/catalog')),
    T('asset_get', 'One generated asset: its prompt, its views, its mesh, and the provenance of every step.', { id: str('') }, ['id'], (a) => get(`/assetsvc/catalog/${a.id}`)),
    T(
      'asset_describe',
      'Create or edit an asset’s SPEC — what it is, the prompt, what to avoid. Describing does not generate; asset_draw does.',
      { id: str('lower-case, hyphens'), subject: str('the noun'), prompt: str('the full description'), negative: str('what must not appear'), tags: { type: 'array', items: { type: 'string' } } },
      ['id'],
      (a) => post('/assetsvc/catalog', a),
    ),
    T(
      'asset_draw',
      'Generate a 2D view from the asset’s prompt. Returns a JOB — poll asset_job. About ten seconds. Costs GPU time on a shared cluster.',
      { id: str(''), seed: num(''), steps: num(''), size: str('e.g. 1024x1024') },
      ['id'],
      (a) => post(`/assetsvc/catalog/${a.id}/image`, { seed: a.seed, steps: a.steps, size: a.size }),
    ),
    T(
      'asset_mesh',
      'Reconstruct a 3D mesh from the chosen view, and finish it for the game. Returns a JOB — poll asset_job. Minutes, one at a time, and it is the expensive one.',
      { id: str(''), seed: num(''), finish: bool('run the simplify/unlit/Draco finisher; default true') },
      ['id'],
      (a) => post(`/assetsvc/catalog/${a.id}/mesh`, { seed: a.seed, finish: a.finish }),
    ),
    T('asset_job', 'How a generation job is going: queued, running with progress, done with numbers, or failed with why.', { job: str('') }, ['job'], (a) => get(`/assetsvc/jobs/${a.job}`)),
    /* ---- materials: a surface rather than a prop -------------------------------------------
     * A second kind of generated asset with a different shape. A prop is a mesh that belongs to
     * one item; a material is three maps — colour, normal, roughness — that several buildings
     * share, so it belongs to no item and is addressed by its own id.
     *
     * Generating one produces a DRAFT rather than overwriting what is live: a texture that turns
     * out wrong should not have replaced the one that was working before anybody looked at it.
     */
    T('material_list', 'Every material: its id, its maps, and what it is meant to be.', {}, [], () => get('/assetsvc/materials')),
    T(
      'material_generate',
      'Generate a texture set from a prompt. Produces a DRAFT — nothing live changes until material_save. Returns a JOB; poll asset_job.',
      { id: str('lower-case, hyphens or underscores'), prompt: str('what the surface IS — "weathered red brick, running bond, mortar gone grey"'), seed: num('') },
      ['id', 'prompt'],
      (a) => post(`/assetsvc/materials/${a.id}/generate`, { prompt: a.prompt, seed: a.seed }),
    ),
    T('material_draft', 'The pending draft for a material, if there is one.', { id: str('') }, ['id'], (a) => get(`/assetsvc/materials/${a.id}/draft`)),
    T('material_save', 'Commit the draft: the generated maps become the live material.', { id: str('') }, ['id'], (a) => post(`/assetsvc/materials/${a.id}/save`, {})),
    T('material_discard', 'Throw the draft away and leave the live material alone.', { id: str('') }, ['id'], (a) => del(`/assetsvc/materials/${a.id}/draft`)),

    T('asset_choose', 'Pick which generated view is the one to mesh from.', { id: str(''), view: str('a file name from asset_get') }, ['id', 'view'], (a) => post(`/assetsvc/catalog/${a.id}/choose`, { view: a.view })),
    T('asset_fork', 'Copy an asset and its spec under a new id — the way to try a variation without losing the one that works.', { id: str(''), to: str('the new id') }, ['id', 'to'], (a) => post(`/assetsvc/catalog/${a.id}/fork`, { to: a.to })),
    T('asset_sync', 'Push the generated catalog to the bucket, or pull it back. Objects whose size already matches are skipped.', { direction: { type: 'string', enum: ['push', 'pull'], description: '' } }, ['direction'], (a) => post(`/assetsvc/sync/${a.direction}`, {})),

    T('asset_services', 'Which generation models this editor is configured for and which are actually answering right now. Read-only: the roster is a deployment decision.', {}, [], () => get('/assetsvc/models')),

    /* ---- bakes and publishes ------------------------------------------------------------------ */
    T('run_list', 'Every bake and publish, newest first, with state and duration.', {}, [], () => get('/api/runs')),
    T('run_get', 'One run.', { id: str('') }, ['id'], (a) => get(`/api/runs/${a.id}`)),
    T('run_log', 'A run’s log.', { id: str('') }, ['id'], (a) => get(`/api/runs/${a.id}/log`)),
    T('run_bake', 'Bake a world: OSM, terrain, imagery, lidar. HOURS, and it occupies the runner. Check run_list before starting another.', { slug: str('') }, ['slug'], (a) => post('/api/runs/bake', { slug: a.slug })),
    T('run_publish', 'Publish a baked world to the bucket the viewer reads.', { slug: str('') }, ['slug'], (a) => post('/api/runs/publish', { slug: a.slug })),
    T('run_cancel', 'Stop a running bake or publish.', { id: str('') }, ['id'], (a) => post(`/api/runs/${a.id}/cancel`, {})),

    /* ---- gaussian splat training -------------------------------------------------------------- */
    T('splat_plan', 'What this cluster can actually run: which trainer, which GPUs, and whether the platform wrapper is available.', {}, [], () => get('/api/training/plan')),
    T('splat_gpus', 'The GPUs, and what is on them now.', {}, [], () => get('/api/training/gpus')),
    T('splat_runs', 'Every splat training run and its state.', {}, [], () => get('/api/training/runs')),
    T('splat_run', 'One training run in detail.', { id: str('') }, ['id'], (a) => get(`/api/training/runs/${a.id}`)),
    T('splat_start', 'Start a splat training run from a capture. Hours on a GPU.', { capture: str('capture id'), name: str(''), options: obj('trainer options') }, ['capture'], (a) => post('/api/training/runs', a)),
    T('splat_delete', 'Delete a training run and its job.', { id: str('') }, ['id'], (a) => del(`/api/training/runs/${a.id}`)),
    T('splat_manifest', 'The manifest a run WOULD submit, without submitting it. Use it to see what changes before spending a GPU-hour.', { capture: str(''), options: obj('') }, [], (a) => post('/api/training/preview', a)),

    /* ---- captures: the video a splat is trained from ------------------------------------------- */
    T('capture_get', 'One capture: its chapters, its frames, and what has been trained from it.', { id: str('') }, ['id'], (a) => get(`/api/captures/${a.id}`)),
    T('capture_update', 'Edit a capture’s metadata.', { id: str(''), patch: obj('') }, ['id', 'patch'], (a) => apiFetch('PATCH', `/api/captures/${a.id}`, a.patch)),

    /* ---- the map ------------------------------------------------------------------------------ */
    T('place_search', 'Find somewhere on earth by name. The first step in making a world.', { q: str('') }, ['q'], (a) => get(`/api/osm/search?q=${encodeURIComponent(a.q)}`)),
    T('place_list', 'The saved place index — somewhere somebody marked as worth baking.', {}, [], () => get('/api/places')),
    T('place_add', 'Save a place to the index.', { place: obj('') }, ['place'], (a) => post('/api/places', a.place)),
    T('place_delete', 'Remove a place from the index.', { id: str('') }, ['id'], (a) => del(`/api/places/${a.id}`)),

    /* ---- which editor window you are talking to -------------------------------------------------
     * ONE WINDOW OWNS THE BROWSER TOOLS. `shell_exec`, `code_check` and the rest run inside an
     * editor page, and when two are open they would otherwise run in whichever attached first —
     * so an agent's commands would land in somebody else's tab, against their projection and their
     * open files, plausibly and silently. Every window has a name; one of them owns the
     * connection; you can move it.
     */
    T('editor_windows', 'The editor windows attached right now, their names, and which one owns the MCP connection. Browser tools (shell_*, code_*, editor_state) run in the OWNER. Call this when a browser tool says it is not offered, or when you want to be sure which screen you are acting on.', {}, [], async () => (await get('/api/agent/mcp/config')).bridge),
    T('editor_claim', 'Move the MCP connection to a named editor window. The window that had it is told it lost it — there is no asking, because the case this exists for is a window nobody is watching holding the connection. Takes the window NAME (as editor_windows reports it) or its short id.', { page: str('window name or id') }, ['page'], (a) => post('/api/agent/mcp/claim', a)),

    /* ---- blender -------------------------------------------------------------------------------
     * Rigging, and looking at what you rigged. Two shapes and the difference matters to an agent:
     *
     *   `blender_load` / `blender_render` / `blender_export` / `blender_exec` drive a LIVE headless
     *   Blender, and the scene PERSISTS between calls. That is what lets you load an asset, render
     *   it, look at the picture, and act on what you saw. Seconds each.
     *
     *   `blender_rig_*` spawn their own Blender and take MINUTES. They read a file and write a
     *   file and touch nothing in the live session.
     *
     * Everything either produces goes in one place, which `blender_outputs` lists and the editor's
     * Blender tab shows — so you and whoever is watching are looking at the same files.
     */
    T('blender_status', 'Is there a live Blender to drive, and what is in its scene. Call this first: the bridge is a separate process and the answer when it is not running tells you the command to start it.', {}, [], () => get('/api/blender/status')),
    T('blender_load', 'Open a .glb in the live Blender, replacing whatever was there. Give it an absolute path — a catalog mesh, or a file a rigger just produced.', { file: str('absolute path to a .glb') }, ['file'], (a) => post('/api/blender/load', a)),
    T('blender_render', 'Render the live scene and save a PNG you can then look at with blender_outputs. Angles are spherical around whatever is in the scene, so they work without knowing where anything is: az 0 is the side, 90 the front, el is height above the horizon. THE ONLY WAY TO SEE YOUR OWN WORK — a rig that reports four wheels at the right radii can still have every one of them hanging outside its arch.', { name: str('what to call the file'), az: num('degrees around, default 45'), el: num('degrees above, default 20'), dist: num('multiples of the subject size, default 2.2'), width: num(''), height: num('') }, [], (a) => post('/api/blender/render', a)),
    T('blender_export', 'Write the live scene out. glb keeps materials and the rig; stl is triangles ONLY — no materials, no armature — and obj keeps materials but not the rig. Exporting a rigged character to stl and wondering where the bones went is the usual surprise.', { format: str('glb | stl | obj | ply'), name: str('what to call the file'), selectedOnly: bool('only what is selected in the scene') }, [], (a) => post('/api/blender/export', a)),
    T('blender_outputs', 'Every render and export, newest first, with its kind and size. The editor’s Blender tab shows the same list.', {}, [], () => get('/api/blender/outputs')),
    T('blender_exec', 'Run Python inside the live Blender. Assign to `result`, which must be a dict. The addon refuses destructive operators and names the replacement — `read_factory_settings` is rejected in favour of `read_homefile`, because the first resets the user’s preferences. Prefer the other tools; this is for what they do not cover.', { code: str('python; assign a dict to `result`') }, ['code'], (a) => post('/api/blender/exec', a)),
    T('blender_rig_vehicle', 'Cut a car’s wheels off its body and give each one a bone, in FL FR RL RR order. MINUTES, its own Blender. A reconstruction’s wheels are FUSED to the body — one connected component holds about 97% of the vertices — so this finds them by shape and REFUSES rather than half-rigging: an unrigged car drives perfectly well, and a wrongly rigged one steers with its back wheels with nothing downstream able to tell.', { src: str('absolute path to the car .glb'), out: str('what to call the result'), length: num('metres nose to tail, default 4.5 — the file’s own scale means nothing'), outboard: num('how far out sideways a tyre is, 0..1, default 0.8') }, ['src'], (a) => post('/api/blender/rig/vehicle', a)),
    T('blender_rig_character', 'Rigify a character: a watertight cage carries the bone-heat weights and the real mesh keeps its topology. MINUTES, its own Blender. The face bones are weighted from the real mesh afterwards, because a cage has no lip seam and leaves every lip bone at zero.', { src: str('absolute path to the character .glb'), out: str('what to call the result'), height: num('metres, head to floor, default 1.7'), noFace: bool('skip the face-weight pass') }, ['src'], (a) => post('/api/blender/rig/character', a)),

    /* ---- the editor itself --------------------------------------------------------------------- */
    T('editor_config', 'How this editor is configured: which services it can reach, which cluster, what is enabled. The first thing to call when something is refused and you want to know whether it is even turned on.', {}, [], () => get('/api/config')),
    T('editor_ready', 'Whether the editor’s dependencies are answering right now.', {}, [], () => get('/api/ready')),
  ]
}
