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
export function serverTools({ apiFetch, root, siteDoc }) {
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
    T('world_delete', 'Delete a world: its definition and its bake. A bake that is still running is refused.', { slug: str('') }, ['slug'], (a) => del(`/api/worlds/${a.slug}`)),
    T(
      'world_export',
      'A bundle of world definitions and the levels set in them. A few hundred bytes: where the world is, and what you do there. Not the rasters — that is site_export. No slugs means every world. levels false leaves the stages out.',
      {
        slugs: { type: 'array', items: { type: 'string' }, description: 'which worlds; empty is all of them' },
        levels: bool('include each world\'s stages. default true'),
      },
      [],
      (a) => {
        const q = new URLSearchParams()
        for (const s of a.slugs ?? []) q.append('slug', s)
        if (a.levels === false) q.set('levels', '0')
        const query = q.toString()
        return get(`/api/worlds/export${query ? `?${query}` : ''}`)
      },
    ),
    T(
      'world_import',
      'Install a world_export bundle: the definitions and their levels. A world or level already here is skipped unless replace is set. This does not bring the bake.',
      { bundle: obj('a world, an array of worlds, or { worlds, levels } from world_export'), replace: bool('overwrite a world or level that is already here') },
      ['bundle'],
      (a) => post(`/api/worlds/import${a.replace ? '?replace=1' : ''}`, a.bundle),
    ),
    T(
      'site_export',
      'A baked world as a zip. source false (the default) is the viewer half only — web/, most of the value and a fraction of the bytes. source true includes the rasters a rebake needs. The answer is the url, the file count and the size. Fetch the zip from the url; it does not fit in a tool result. overLimit means the zip would be refused and you should export without source, or publish to the bucket.',
      { slug: str(''), source: bool('include the source rasters. default false') },
      ['slug'],
      (a) => get(`/api/sites/${encodeURIComponent(a.slug)}/archive?describe=1${a.source ? '' : '&web=1'}`),
    ),
    T(
      'site_import',
      'Install a baked world from an https zip — the url site_export returned, or any such zip of one site. replace overwrites a bake already here. The definition is not in the zip; world_import does that.',
      { url: str('https url of the zip'), replace: bool('overwrite an existing bake') },
      ['url'],
      (a) => post(`/api/sites/import${a.replace ? '?replace=1' : ''}`, { url: a.url }),
    ),

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
    T('level_save', 'Create or replace a level. Validated first; an invalid level is refused with its problems rather than written. A level names its world, an optional player { vehicle: <vehicle build or catalog id>, profile }, an optional program (a path under programs/), simulations such as [{ kind: "traffic", set, density?, max?, seed?, blind? }] (blind drivers brake for nobody: a pile-up game), start (a point id from the world\'s points.json — where the level begins; absent: the world\'s home), recoverRepairs (does R straighten the hero car\'s dents; default true), defaults { time, weather, season }, placements and splats.', { id: str(''), level: obj('') }, ['id', 'level'], async (a) => {
      // PUT replaces an existing level and 404s on a new one; a new one is a POST. One tool, either way.
      try {
        return await put(`/api/levels/${a.id}`, a.level)
      } catch (e) {
        if (e?.status !== 404) throw e
        return post('/api/levels', { ...a.level, id: a.id })
      }
    }),
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
      'asset_view',
      'LOOK at a generated asset: one of its drawn views, as an image — the chosen one unless `view` names another (a file name from asset_get). The only way to judge a drawing before meshing it, or to see which way a car’s nose came out. About a megabyte for a 1024² view.',
      { id: str(''), view: str('a view file name, e.g. 0796343864.png; default: the chosen one, else the newest') },
      ['id'],
      async (a) => {
        const item = await get(`/assetsvc/catalog/${encodeURIComponent(a.id)}`)
        const view = a.view ?? item.chosen ?? item.views?.[item.views.length - 1]
        if (!view) throw new Error(`${a.id} has no drawn views yet — asset_draw makes one`)
        const r = await apiFetch('GET', `/assetsvc/catalog/${encodeURIComponent(a.id)}/file/views/${encodeURIComponent(view)}`, undefined, { raw: true })
        if (!r?.buffer) throw new Error('this service cannot fetch bytes for a tool')
        return {
          __mcp: 'content',
          content: [
            { type: 'image', data: r.buffer.toString('base64'), mimeType: r.contentType?.split(';')[0] || 'image/png' },
            { type: 'text', text: `${a.id}: views/${view}${view === item.chosen ? ' (chosen)' : ''} · ${r.buffer.length} bytes` },
          ],
        }
      },
    ),
    T(
      'asset_describe',
      'Create or edit an asset’s SPEC — what it is, the prompt, what to avoid. Describing does not generate; asset_draw does.',
      {
        id: str('lower-case, hyphens'), subject: str('the noun'), prompt: str('the full description'), negative: str('what must not appear'),
        tags: { type: 'array', items: { type: 'string' } },
        kind: str('what sort of thing: prop (the default), hero-car, traffic, van, truck, bus, emergency, pedestrian, animal, furniture, building, signage, weapon — a vehicle build wants hero-car or traffic'),
        type: str('prop | vehicle | actor | weapon | fixture; derived from kind when absent'),
        size_m: obj('{ w, d, h } metres. A reconstruction has no scale of its own: without this a prop stands 2 m tall and a vehicle 1.5'),
        notes: str(''),
      },
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
    T('run_bake', 'Bake a world: OSM, terrain, imagery, lidar, and a tile pyramid. LOD is the bake — there is no monolithic one. HOURS, and it occupies the runner. Check run_list before starting another. A world more than 10 km across is baked SHARDED (plan → ≤ 10 km blocks in parallel → finalize) by default; `sharded` forces it on or off for this bake.', { slug: str(''), sharded: bool('true forces a sharded bake, false a single Job; omit for the default (sharded above 10 km across)') }, ['slug'], (a) => post('/api/runs/bake', a.sharded === undefined ? { slug: a.slug } : { slug: a.slug, sharded: !!a.sharded })),
    T('run_publish', 'Publish a baked world to the bucket the viewer reads.', { slug: str('') }, ['slug'], (a) => post('/api/runs/publish', { slug: a.slug })),
    T('run_cancel', 'Stop a running bake or publish.', { id: str('') }, ['id'], (a) => post(`/api/runs/${a.id}/cancel`, {})),

    /* ---- publishing a world to Cloudflare ------------------------------------------------------
     * The token is set in the editor and never comes back out. These tools ask whether one is
     * there, what a deploy would upload, and then start it. The progress is a run.
     */
    T('deploy_status', 'Whether a Cloudflare token is configured — never the token itself — which worlds are baked, and the default worker name. Call this before deploy_start.', {}, [], () => get('/api/deploy/status')),
    T('deploy_cloudflare', 'The Cloudflare accounts, zones and buckets this token can see. Leave account empty to use the first one.', { account: str('account id; empty is the first') }, [], (a) => get(`/api/deploy/cloudflare${a.account ? `?account=${encodeURIComponent(a.account)}` : ''}`)),
    T(
      'deploy_plan',
      'What a deploy would upload, without uploading it. objects true includes every key; leave it off unless you need the list.',
      { worlds: { type: 'array', items: { type: 'string' }, description: 'world slugs' }, objects: bool('include every object key'), sources: bool('also ship the bake sources the game never reads (raw OSM, branches, spine…); default false') },
      ['worlds'],
      (a) => post('/api/deploy/plan', { worlds: a.worlds, objects: !!a.objects, sources: !!a.sources }),
    ),
    T(
      'deploy_start',
      'Publish baked worlds to Cloudflare: R2 for the data, a Worker for the app. A token must already be configured (deploy_status). Returns a run; follow it with run_get and run_log. dryRun uploads nothing.',
      {
        worlds: { type: 'array', items: { type: 'string' }, description: 'world slugs' },
        account: str('Cloudflare account id'),
        bucket: str('R2 bucket name'),
        prefix: str('object prefix; empty is derived from the worlds'),
        worker: obj('{ name, workersDev, hostname, zoneId }'),
        prune: bool('delete objects in the prefix that this deploy does not write'),
        dryRun: bool('count the upload and write nothing'),
        createBucket: bool('create the bucket if it is missing. default true'),
        replacePrefix: str('an old prefix to delete after a successful deploy'),
        sources: bool('also upload the bake sources the game never reads (raw OSM, branches, spine…). default false: a game deploy'),
      },
      ['worlds', 'account', 'bucket'],
      (a) => post('/api/deploy/start', a),
    ),
    T('deploy_history', 'Every deploy this editor has started: what was asked, and the URL it got.', {}, [], () => get('/api/deploy/history')),
    T('deploy_delete', 'Delete one past deployment (an id from deploy_history): every object under its prefix in R2 and its line in the bucket ledger, then the record. The Worker is left as it is. Returns a run; follow it with run_log. Irreversible.', { id: str('the deployment id from deploy_history') }, ['id'], (a) => del(`/api/deploy/history/${encodeURIComponent(a.id)}`)),

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
    T('blender_bridge', 'Start or stop the live headless Blender this editor supervises. Start it when blender_status says it is not up; it restarts itself if it dies (usually the memory limit), and blender_status says why it last did.', { action: str('start | stop') }, ['action'], (a) => post(`/api/blender/bridge/${a.action === 'stop' ? 'stop' : 'start'}`, {})),
    T('blender_load', 'Open a .glb in the live Blender, replacing whatever was there. Give it an absolute path — a catalog mesh, or a file a rigger just produced.', { file: str('absolute path to a .glb') }, ['file'], (a) => post('/api/blender/load', a)),
    T('blender_render', 'Render the live scene and save a PNG you can then look at with blender_outputs. Angles are spherical around whatever is in the scene, so they work without knowing where anything is: az 0 is the side, 90 the front, el is height above the horizon. THE ONLY WAY TO SEE YOUR OWN WORK — a rig that reports four wheels at the right radii can still have every one of them hanging outside its arch.', { name: str('what to call the file'), az: num('degrees around, default 45'), el: num('degrees above, default 20'), dist: num('multiples of the subject size, default 2.2'), width: num(''), height: num('') }, [], (a) => post('/api/blender/render', a)),
    T('blender_export', 'Write the live scene out. glb keeps materials and the rig; stl is triangles ONLY — no materials, no armature — and obj keeps materials but not the rig. Exporting a rigged character to stl and wondering where the bones went is the usual surprise.', { format: str('glb | stl | obj | ply'), name: str('what to call the file'), selectedOnly: bool('only what is selected in the scene') }, [], (a) => post('/api/blender/export', a)),
    T('blender_outputs', 'Every render and export, newest first, with its kind and size. The editor’s Blender tab shows the same list.', {}, [], () => get('/api/blender/outputs')),
    T('blender_exec', 'Run Python inside the live Blender. Assign to `result`, which must be a dict. The addon refuses destructive operators and names the replacement — `read_factory_settings` is rejected in favour of `read_homefile`, because the first resets the user’s preferences. Prefer the other tools; this is for what they do not cover.', { code: str('python; assign a dict to `result`') }, ['code'], (a) => post('/api/blender/exec', a)),
    T('blender_rig_vehicle', 'Cut a car’s wheels off its body and give each one a bone, in FL FR RL RR order. MINUTES, its own Blender. A reconstruction’s wheels are FUSED to the body — one connected component holds about 97% of the vertices — so this finds them by shape and REFUSES rather than half-rigging: an unrigged car drives perfectly well, and a wrongly rigged one steers with its back wheels with nothing downstream able to tell.', { src: str('absolute path to the car .glb'), out: str('what to call the result'), length: num('metres nose to tail, default 4.5 — the file’s own scale means nothing'), outboard: num('how far out sideways a tyre is, 0..1, default 0.8') }, ['src'], (a) => post('/api/blender/rig/vehicle', a)),
    T('blender_rig_character', 'Rigify a character: a watertight cage carries the bone-heat weights and the real mesh keeps its topology. MINUTES, its own Blender. The face bones are weighted from the real mesh afterwards, because a cage has no lip seam and leaves every lip bone at zero.', { src: str('absolute path to the character .glb'), out: str('what to call the result'), height: num('metres, head to floor, default 1.7'), noFace: bool('skip the face-weight pass') }, ['src'], (a) => post('/api/blender/rig/character', a)),

    /* ---- vehicles and traffic sets: the builds ------------------------------------------------
     * Rich, 2026-09-29: *"select a car or two as hero cars, define their performance, select say
     * 10 cars to be a traffic library, configure them"*. A BUILD is a catalog model plus its
     * dynamics (`vehicle_*`); a traffic SET is which builds a jam is made of and how common each
     * is (`traffic_set_*`). Both live in the asset service beside the catalog, and both are what
     * a level names: `player.vehicle` is a vehicle build id (or a bare catalog id, which drives
     * the default chassis), `simulations[].set` is a traffic set id.
     */
    T('vehicle_list', 'Every vehicle build: id, name, the catalog model it wears, and its dynamics document. A build is a car you can drive or put in traffic; a catalog item alone is only a picture.', {}, [], () => get('/assetsvc/vehicles')),
    T('vehicle_get', 'One vehicle build in full.', { id: str('build id') }, ['id'], async (a) => {
      const r = await get('/assetsvc/vehicles')
      const b = (r.vehicles ?? []).find((v) => v.id === a.id)
      if (!b) throw new Error(`no vehicle build "${a.id}" — vehicle_list has them`)
      return b
    }),
    T(
      'vehicle_template',
      'A starting dynamics document, by kind — hero-car, traffic, van, truck, bus. Copy it, change the numbers, and hand it to vehicle_save as `doc`. `profile.base` is the handling model (stunts | taxi | street | rush | sim) and `profile.overrides` tunes it; `engine` is power, redline, gears, final drive and brakes; `spec` is mass, wheelbase, track, centre of gravity and size.',
      { kind: str('hero-car | traffic | van | truck | bus') },
      ['kind'],
      async (a) => {
        const t = JSON.parse(await readFile(new URL('./vehicle-templates.json', import.meta.url), 'utf8'))
        const doc = t[a.kind]
        if (!doc) throw new Error(`no template "${a.kind}" — one of ${Object.keys(t).filter((k) => !k.startsWith('_')).join(', ')}`)
        return { kind: a.kind, doc }
      },
    ),
    T(
      'vehicle_save',
      'Create or update a vehicle build. MERGED: fields you leave out keep their value, so saving `{ doc }` later keeps the name and the model. `asset` is a catalog id from asset_list (kind hero-car or traffic); `doc` is a dynamics document shaped like vehicle_template; `preset` is a handling preset id, for the record. The id is what a level and a traffic set name.',
      { id: str('lowercase, digits, dashes'), name: str(''), asset: str('catalog id of the model'), preset: str('optional preset id'), notes: str(''), doc: obj('the dynamics document') },
      ['id'],
      (a) => { const { id, ...patch } = a; return put(`/assetsvc/vehicles/${encodeURIComponent(id)}`, patch) },
    ),
    T('vehicle_delete', 'Delete a vehicle build. The catalog model stays; a level or set naming this id will fall back to the default car and say so.', { id: str('') }, ['id'], (a) => del(`/assetsvc/vehicles/${encodeURIComponent(a.id)}`)),

    T('traffic_set_list', 'Every traffic set: which vehicle builds a jam is made of and how common each one is.', {}, [], () => get('/assetsvc/traffic')),
    T('traffic_set_get', 'One traffic set in full.', { id: str('') }, ['id'], async (a) => {
      const r = await get('/assetsvc/traffic')
      const b = (r.traffic ?? []).find((v) => v.id === a.id)
      if (!b) throw new Error(`no traffic set "${a.id}" — traffic_set_list has them`)
      return b
    }),
    T(
      'traffic_set_save',
      'Create or update a traffic set. `doc.mix` is [{ vehicle: <vehicle build id>, weight: <relative share>, obeyRate? }]; `doc.obeyRate` (0…1, share of drivers who stop for a red) and `doc.speedFactor` (multiplier on the limit, 0.6 is a crawl) apply to the whole set. A level names the set in simulations[].set.',
      { id: str(''), name: str(''), notes: str(''), doc: obj('{ mix: [{ vehicle, weight, obeyRate? }], obeyRate?, speedFactor? }') },
      ['id', 'doc'],
      async (a) => {
        const mix = a.doc?.mix
        if (!Array.isArray(mix) || !mix.length) throw new Error('doc.mix must list at least one { vehicle, weight }')
        const have = new Set(((await get('/assetsvc/vehicles')).vehicles ?? []).map((v) => v.id))
        const missing = mix.map((m) => m.vehicle).filter((v) => !have.has(v))
        if (missing.length) throw new Error(`these are not vehicle builds: ${missing.join(', ')} — make them with vehicle_save first`)
        const { id, ...patch } = a
        return put(`/assetsvc/traffic/${encodeURIComponent(id)}`, patch)
      },
    ),
    T('traffic_set_delete', 'Delete a traffic set.', { id: str('') }, ['id'], (a) => del(`/assetsvc/traffic/${encodeURIComponent(a.id)}`)),

    /* ---- roads, zones and races: the world as a game board ------------------------------------
     * Zones, courses and stunts are site documents (`sites/<slug>/zones.json` and so on, through
     * read_document / write_document), and these are the helpers that make writing them possible
     * without seeing the map: which roads there are, a polygon along one, a gate across one.
     * Everything is in SITE METRES — x east, y north — which is the frame every site document uses.
     */
    /* ---- what an agent needs to know before it writes anything ------------------------------ */
    T(
      'program_api',
      'The program API’s declarations — the TypeScript a level program is written against: `@apex/program` (GameApi: objectives, models — spawn any library asset or build by id, and remove it — player, points — api.point(id) is a named place in site metres — zones — a world traffic-zone or point id works in on(\'enters\', id) undeclared — timers, physics, traffic, races, stunts, audio, the interface). program_refs lists the ids one world offers, with snippets. Read it before writing a program; program_check and the editor’s code_check check against exactly this text. `module` picks one of the other importable modules (actors, actorworld, ecsconfig, traffic, races, zones, stunts, objectives, vehicles, trafficsets).',
      { module: str('default: program') },
      [],
      async (a) => ({ ...(await declarations(a.module ?? 'program')), modules: await modules() }),
    ),
    T(
      'editor_version',
      'Which build of the editor is answering: the git sha its image was built from, the hash of the program API it checks programs against, when it started. The first thing to check when a program that typechecks here fails in the viewer, or the other way round — the two can be different builds.',
      {},
      [],
      async () => {
        const h = await get('/api/health')
        return { build: h.build ?? null, programApi: h.programApi ?? (await apiHash().catch(() => null)), node: h.node ?? null, started: h.started ?? null, data: h.data ?? null }
      },
    ),
    T(
      'level_vocab',
      'The words a level and a program may use: weather and season names, drive profiles and modes, the point kinds, what a program may hide, the transports, the HUD parts and the setting ids it may switch off, and every engine-sound setup a vehicle build may name in audio.setup. The engine’s own lists, not a guess.',
      {},
      [],
      () => vocab(),
    ),
    T(
      'site_project',
      'WGS84 → site metres (x east, y north) for a baked world, through the frame its manifest holds — the projector the viewer and the minimap use. One point (`lat`, `lon`) or several (`points`: [[lat, lon], …]). place_search answers in lat/lon; a level, a zone and a point all speak in these metres.',
      { slug: str(''), lat: num(''), lon: num(''), points: { type: 'array', description: '[[lat, lon], …]', items: { type: 'array', items: { type: 'number' } } } },
      ['slug'],
      async (a) => {
        const frame = await frameOf(root, a.slug)
        const proj = siteProjector(frame)
        const pts = a.points ?? (a.lat !== undefined && a.lon !== undefined ? [[a.lat, a.lon]] : null)
        if (!pts) throw new Error('give lat and lon, or points [[lat, lon], …]')
        return {
          frame: frame.kind === 'enu' ? `enu about ${frame.anchor.lat}, ${frame.anchor.lon}` : `utm epsg:${frame.epsg}`,
          points: pts.map(([lat, lon]) => { const [x, y] = proj(lon, lat); return { lat, lon, x: round(x), y: round(y) } }),
        }
      },
    ),
    T(
      'address_search',
      'Find an address, a named place or a road in a baked world, in site metres — the world’s own OSM extract, the file the viewer’s search box reads. `q` matches a house number and street ("2299 Johns Hopkins"), a name ("Mister Pizza") or a road. Up to `limit` hits (default 12), nearest to `near` [x, y] first when given, best match first otherwise. An address’s x, y is the BUILDING, not the street: for a drop-off on the kerb, snap to a road (site_roads).',
      { slug: str(''), q: str(''), limit: num('default 12'), near: { type: 'array', description: '[x, y] site metres', items: { type: 'number' } } },
      ['slug', 'q'],
      async (a) => {
        const index = await addressIndex(root, a.slug)
        const q = String(a.q ?? '').toLowerCase().trim()
        const words = q.split(/\s+/).filter(Boolean)
        if (!words.length) throw new Error('q is empty')
        const limit = Math.max(1, Math.min(50, Number(a.limit) || 12))
        const near = Array.isArray(a.near) && a.near.length === 2 ? a.near : null
        const hits = []
        for (const e of index.entries) {
          if (!words.every((w) => e.hay.includes(w))) continue
          // the whole phrase, then the start of the label, then anywhere
          const score = e.hay.startsWith(q) ? 3 : e.label.toLowerCase().includes(q) ? 2 : 1
          const dist = near ? Math.hypot(e.x - near[0], e.y - near[1]) : null
          hits.push({ kind: e.kind, label: e.label, detail: e.detail, x: e.x, y: e.y, ...(dist === null ? {} : { distance_m: round(dist) }), score })
        }
        hits.sort((p, r) => (near ? p.distance_m - r.distance_m : r.score - p.score || p.label.localeCompare(r.label)))
        return { hits: hits.slice(0, limit).map(({ score, ...h }) => h), of: hits.length, indexed: index.counts }
      },
    ),
    T(
      'point_add',
      'Add (or replace, by id) a named point in a world’s points.json: where a level starts or finishes, where the world opens. Give `at` [x, y] in site metres, or `lat`/`lon`, or a `road` (from site_roads) and `at_m` along it — the road gives the heading too, and `offset_m` moves the point to the right of the centreline (the shoulder of a two-lane road is about 5). `kind` is home | start | finish | checkpoint | spot; `mode` drive | walk | fly; `home: true` makes it the point the world opens at. A level names one in `start`.',
      {
        slug: str(''), id: str('lowercase, digits, dashes'), name: str(''), kind: str('home | start | finish | checkpoint | spot'), mode: str('drive | walk | fly'),
        at: { type: 'array', description: '[x, y] site metres', items: { type: 'number' } }, lat: num(''), lon: num(''),
        road: str('a road id from site_roads'), at_m: num('metres along the road'), offset_m: num('metres to the right of the centreline'),
        yaw_deg: num('degrees anticlockwise from east; a road supplies it'), lift_m: num('metres above the ground, for a flying start'), note: str('shown on arrival'), home: bool('make it the world’s home point'),
      },
      ['slug', 'id', 'kind'],
      async (a) => {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(a.id))) throw new Error(`id ${JSON.stringify(a.id)} is lowercase letters, digits, dashes`)
        if (!POINT_KINDS.includes(a.kind)) throw new Error(`kind is one of ${POINT_KINDS.join(', ')}`)
        if (a.mode !== undefined && !POINT_MODES.includes(a.mode)) throw new Error(`mode is one of ${POINT_MODES.join(', ')}`)
        let at
        let yaw = a.yaw_deg
        if (a.road) {
          const r = await findRoad(root, a.slug, a.road)
          const { p, d } = alongRoad(r.coords, a.at_m ?? 0)
          const off = Number(a.offset_m) || 0
          at = [p.x + d.y * off, p.y - d.x * off]
          yaw ??= (Math.atan2(d.y, d.x) * 180) / Math.PI
        } else if (Array.isArray(a.at) && a.at.length >= 2) {
          at = [Number(a.at[0]), Number(a.at[1])]
        } else if (a.lat !== undefined && a.lon !== undefined) {
          at = siteProjector(await frameOf(root, a.slug))(Number(a.lon), Number(a.lat))
        } else throw new Error('say where: at [x, y], lat/lon, or a road and at_m')
        if (!at.every(Number.isFinite)) throw new Error('that position is not a number')
        const doc = (await siteDoc.read(a.slug, 'points.json')) ?? { version: 1, points: [] }
        doc.version = 1
        doc.points ??= []
        const point = { id: a.id, name: a.name ?? a.id, kind: a.kind, at: [round(at[0]), round(at[1])], yaw_deg: round(Number(yaw) || 0) }
        if (a.mode) point.mode = a.mode
        if (a.lift_m !== undefined) point.lift_m = Number(a.lift_m)
        if (a.note) point.note = String(a.note)
        const i = doc.points.findIndex((p) => p.id === a.id)
        if (i >= 0) doc.points[i] = point
        else doc.points.push(point)
        if (a.home) doc.home = a.id
        const wrote = await siteDoc.write(a.slug, 'points.json', doc)
        return { point, replaced: i >= 0, points: doc.points.length, home: doc.home ?? null, wrote }
      },
    ),
    T(
      'site_roads',
      'The drivable roads of a baked world: id, name, ref (e.g. "MD 3"), class, lanes, length in metres, and where each starts and ends in site metres. Optional `q` filters by name or ref. The road ids are what site_road_polygon and site_road_gate take.',
      { slug: str('the world slug'), q: str('a name or ref to match, case-insensitive') },
      ['slug'],
      async (a) => {
        const roads = await roadsOf(root, a.slug)
        const q = (a.q ?? '').toLowerCase()
        const hit = roads.filter((r) => !q || `${r.name ?? ''} ${r.ref ?? ''}`.toLowerCase().includes(q))
        return { roads: hit.map(({ coords, ...r }) => ({ ...r, start: coords[0].slice(0, 2), end: coords[coords.length - 1].slice(0, 2) })), of: roads.length }
      },
    ),
    T(
      'site_road_polygon',
      'A polygon hugging a stretch of road, for a traffic zone: from `from_m` to `to_m` along it (whole road by default), `width_m` wide (default: the lanes plus a verge). Hand the result to traffic_zone_add, or put it in zones.json yourself.',
      { slug: str(''), road: str('a road id from site_roads'), from_m: num('start, metres along the road'), to_m: num('end, metres along the road'), width_m: num('total width, metres') },
      ['slug', 'road'],
      async (a) => {
        const r = await findRoad(root, a.slug, a.road)
        const width = a.width_m ?? r.lanes * 3.66 + 6
        return { road: r.id, name: r.name, polygon: buffer(slice(r.coords, a.from_m ?? 0, a.to_m ?? Infinity), width / 2), length_m: r.length_m }
      },
    ),
    T(
      'site_road_gate',
      'A race gate laid square across a road at `at_m` metres along it, the way one click in the editor lays it. Returns { a, b } endpoints in site metres, facing the road’s direction of travel; set `reverse` to face the other way. Put it in a course’s gates with a role (start | finish | startfinish | checkpoint | split).',
      { slug: str(''), road: str('a road id from site_roads'), at_m: num('metres along the road'), reverse: bool('face against the road’s direction'), margin_m: num('extra width each side, default 6') },
      ['slug', 'road', 'at_m'],
      async (a) => {
        const r = await findRoad(root, a.slug, a.road)
        const { p, d } = alongRoad(r.coords, a.at_m)
        const half = (r.lanes * 3.66) / 2 + (a.margin_m ?? 6)
        const sgn = a.reverse ? -1 : 1
        // a→b is the road's LEFT normal for forward travel: the crossing counts when you go a→b's right-hand way
        const lx = -d.y * sgn
        const ly = d.x * sgn
        return { a: [round(p.x + lx * half), round(p.y + ly * half)], b: [round(p.x - lx * half), round(p.y - ly * half)], at: [round(p.x), round(p.y)], heading_deg: round((Math.atan2(d.y * sgn, d.x * sgn) * 180) / Math.PI) }
      },
    ),
    T(
      'traffic_zone_add',
      'Add a traffic zone to a world’s zones.json (merged in; other zones are kept). Give a polygon, or a road and a stretch of it and the polygon is made for you. `density` 0…1 is how jammed: 0.3 flows, 0.6 is heavy, 0.9 crawls, 1 is stopped. `density_max` makes it swing between the two on each load. The zone takes effect when a level with a traffic simulation opens on this world.',
      { slug: str(''), name: str(''), polygon: { type: 'array', description: '[[x, y], …] site metres', items: { type: 'array', items: { type: 'number' } } }, road: str('a road id, instead of a polygon'), from_m: num(''), to_m: num(''), width_m: num(''), density: num('0…1'), density_max: num('0…1, optional swing'), obey_rate: num('0…1'), speed_factor: num('multiplier on the limit') },
      ['slug', 'density'],
      async (a) => {
        let polygon = a.polygon
        if (!polygon) {
          if (!a.road) throw new Error('give a polygon, or a road (from site_roads) and optionally from_m/to_m')
          const r = await findRoad(root, a.slug, a.road)
          polygon = buffer(slice(r.coords, a.from_m ?? 0, a.to_m ?? Infinity), (a.width_m ?? r.lanes * 3.66 + 6) / 2)
        }
        if (!Array.isArray(polygon) || polygon.length < 3) throw new Error('a zone needs at least three points')
        const doc = (await siteDoc.read(a.slug, 'zones.json')) ?? { version: 1, zones: [] }
        doc.zones ??= []
        const id = nextId('z', doc.zones.map((z) => z.id))
        const traffic = { density: clamp01(a.density) }
        if (a.density_max !== undefined) traffic.densityMax = clamp01(a.density_max)
        if (a.obey_rate !== undefined) traffic.obeyRate = clamp01(a.obey_rate)
        if (a.speed_factor !== undefined) traffic.speedFactor = a.speed_factor
        doc.zones.push({ id, name: a.name ?? id, kind: 'traffic', polygon: polygon.map(([x, y]) => [round(x), round(y)]), traffic })
        const wrote = await siteDoc.write(a.slug, 'zones.json', doc)
        return { id, zones: doc.zones.length, wrote }
      },
    ),
    T(
      'course_save',
      'Add or replace a race course in a world’s courses.json (merged by id). A course is `kind` circuit (lapped; the start gate is the finish) or stage (start, checkpoints in order, finish; a missed checkpoint costs penalty_s), an `entry` ring {x, y, r} you drive into to commit, and `gates` [{ id?, name?, role, a: [x, y], b: [x, y], order?, optional? }] — site_road_gate makes a gate. Validated: a circuit needs one startfinish, a stage a start and a finish, every gate a and b.',
      { slug: str(''), course: obj('{ id, name, kind, entry?, laps?, penalty_s?, gates, intro?, outro? }') },
      ['slug', 'course'],
      async (a) => {
        const c = a.course
        const errors = validateCourse(c)
        if (errors.length) throw new Error(`the course does not validate:\n${errors.join('\n')}`)
        const doc = (await siteDoc.read(a.slug, 'courses.json')) ?? { version: 1, courses: [] }
        doc.courses ??= []
        c.gates = c.gates.map((g, i) => ({ ...g, id: g.id ?? `g-${String(i + 1).padStart(2, '0')}`, name: g.name ?? `${g.role} ${i + 1}` }))
        const at = doc.courses.findIndex((x) => x.id === c.id)
        if (at >= 0) doc.courses[at] = c
        else doc.courses.push(c)
        const wrote = await siteDoc.write(a.slug, 'courses.json', doc)
        return { id: c.id, courses: doc.courses.length, gates: c.gates.length, wrote }
      },
    ),

    /* ---- programs: built and checked without a browser ---------------------------------------- */
    T('program_check', 'Typecheck a program against the level API’s declarations — the same check the editor’s Program pane runs, with no tab open. Returns every problem with its line. A program that passes here loads in the viewer.', { path: str('e.g. crofton/jam.ts') }, ['path'], (a) => get(`/api/programs/${a.path}?check=1`)),
    T(
      'program_refs',
      'Everything a level program can name in one world, grouped, with the code that uses each — the editor Program pane\'s "In this world" list. Groups: traffic (painted zones: a trigger and a density), point (named places: api.point(id) is where, in site metres), placement (api.placed(id), api.placedWith(tag)), stunt, race, build (the vehicle/actor/weapon builds this world\'s levels name, with their sound overrides), sound (every bank slot with what it is for: api.audio.play(slot)), library (every id api.models.spawn(id, pose) can put down: the kit, library assets with a model, builds). Each row has id, desc, detail and `snippet` — code that typechecks inside setup(api) as it stands, using this world\'s real ids (e.g. a library row: when the player enters the first zone, spawn the asset at the first point, remove it after a minute). Read this before writing a program for a world; program_check it after. `kinds` narrows the groups, `q` searches ids and descriptions, `limit` caps rows per group (default 100).',
      { slug: str('the world slug'), kinds: { type: 'array', items: { type: 'string' }, description: 'traffic | point | placement | stunt | race | build | sound | library; default all' }, q: str('words that must all appear in a row (id, tags, description)'), limit: num('rows per group, default 100') },
      ['slug'],
      (a) => programRefs({ get, siteDoc }, a),
    ),
    T('program_build', 'Transpile a program to the JavaScript the viewer runs. Mostly for seeing that it builds; the viewer asks for this itself when a level names the program.', { path: str('') }, ['path'], async (a) => { const r = await get(`/api/programs/${a.path}?js=1`); return { id: r.id, bytes: r.js.length, errors: r.errors } }),

    /* ---- the editor itself --------------------------------------------------------------------- */
    T('editor_config', 'How this editor is configured: which services it can reach, which cluster, what is enabled. The first thing to call when something is refused and you want to know whether it is even turned on.', {}, [], () => get('/api/config')),
    T('editor_ready', 'Whether the editor’s dependencies are answering right now.', {}, [], () => get('/api/ready')),
  ]
}


/* ---- road geometry, from the baked world's own manifest ------------------------------------------ */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { siteProjector } from './geo.mjs'
import { apiHash, declarations, modules } from './programs.mjs'
import { programRefs } from './programrefs.mjs'
import { POINT_KINDS, POINT_MODES, vocab } from './vocab.mjs'

const round = (v) => Math.round(v * 10) / 10
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

function nextId(prefix, taken) {
  const have = new Set(taken)
  for (let i = 1; i < 10000; i++) {
    const id = `${prefix}-${String(i).padStart(2, '0')}`
    if (!have.has(id)) return id
  }
  return `${prefix}-${Date.now()}`
}

/**
 * The roads of a world, with their centrelines in site metres.
 *
 * From `web/manifest.json`, which is what the viewer itself loads: the spine (index 0, named by
 * its first segment) and every branch. Lanes are the smallest of the tags a chain carries, which
 * is how the viewer draws it too.
 */
async function roadsOf(root, slug) {
  if (!root) throw new Error('site_roads needs the data root')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug))) throw new Error(`bad slug ${JSON.stringify(slug)}`)
  const file = path.join(root, 'sites', slug, 'web', 'manifest.json')
  const text = await readFile(file, 'utf8').catch(() => null)
  if (!text) throw new Error(`${slug} has no baked manifest (sites/${slug}/web/manifest.json) — bake it first`)
  const m = JSON.parse(text)
  const lanesOf = (v) => {
    if (typeof v === 'number') return v > 0 ? v : 2
    if (typeof v === 'string') return Number(v) > 0 ? Number(v) : 2
    if (Array.isArray(v)) { const ns = v.map(Number).filter((n) => n > 0); return ns.length ? Math.min(...ns) : 2 }
    return 2
  }
  const out = []
  const sp = m.spine ?? {}
  if (Array.isArray(sp.coords) && sp.coords.length >= 2) {
    const tg = sp.segments?.[0]?.tags ?? {}
    out.push({ id: 'spine', chain: 0, name: tg.name ?? 'spine', ref: tg.ref ?? null, highway: tg.highway ?? null, lanes: lanesOf(tg.lanes), oneway: tg.oneway ?? null, length_m: round(sp.length_m ?? lengthOf(sp.coords)), coords: sp.coords })
  }
  for (const br of m.branches ?? []) {
    if (!Array.isArray(br.coords) || br.coords.length < 2) continue
    out.push({ id: br.id, name: br.name ?? null, ref: br.ref ?? null, highway: br.highway ?? null, lanes: lanesOf(br.lanes), oneway: br.oneway ?? null, length_m: round(br.length_m ?? lengthOf(br.coords)), coords: br.coords })
  }
  return out
}

async function findRoad(root, slug, id) {
  const roads = await roadsOf(root, slug)
  const r = roads.find((x) => x.id === id) ?? roads.find((x) => (x.name ?? '').toLowerCase() === String(id).toLowerCase())
  if (!r) throw new Error(`no road "${id}" in ${slug} — site_roads lists them by id`)
  return r
}

function lengthOf(coords) {
  let l = 0
  for (let i = 1; i < coords.length; i++) l += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1])
  return l
}

/** The part of a polyline between two distances along it, resampled so both ends land exactly. */
function slice(coords, from, to) {
  const out = []
  let run = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]
    const b = coords[i]
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    const s0 = run
    const s1 = run + seg
    if (s1 >= from && s0 <= to) {
      const t0 = Math.max(0, (from - s0) / seg)
      const t1 = Math.min(1, (to - s0) / seg)
      if (!out.length) out.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0])
      out.push([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1])
    }
    run = s1
  }
  if (out.length < 2) throw new Error(`that stretch (${from}…${to} m) is not on the road, which is ${round(run)} m long`)
  return out
}

/** A ribbon `half` metres either side of a polyline, as one closed polygon: left side out, right side back. */
function buffer(line, half) {
  const left = []
  const right = []
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]
    const b = line[Math.min(line.length - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const nx = -dy / l
    const ny = dx / l
    left.push([round(line[i][0] + nx * half), round(line[i][1] + ny * half)])
    right.push([round(line[i][0] - nx * half), round(line[i][1] - ny * half)])
  }
  return [...left, ...right.reverse()]
}

/** The point `at` metres along a polyline and the unit direction there. */
function alongRoad(coords, at) {
  let run = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]
    const b = coords[i]
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (run + seg >= at || i === coords.length - 1) {
      const t = seg > 0 ? Math.max(0, Math.min(1, (at - run) / seg)) : 0
      const l = seg || 1
      return { p: { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t }, d: { x: (b[0] - a[0]) / l, y: (b[1] - a[1]) / l } }
    }
    run += seg
  }
  throw new Error('an empty road')
}

const GATE_ROLES = ['start', 'finish', 'startfinish', 'checkpoint', 'split']
function validateCourse(c) {
  const errors = []
  if (!c || typeof c !== 'object') return ['course must be an object']
  if (!c.id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) errors.push('course.id is lowercase, digits and dashes')
  if (!c.name) errors.push('course.name is missing')
  if (!['circuit', 'stage'].includes(c.kind)) errors.push('course.kind is circuit or stage')
  if (!Array.isArray(c.gates) || c.gates.length < 2) errors.push('a course needs at least two gates')
  const roles = new Map()
  for (const [i, g] of (c.gates ?? []).entries()) {
    if (!GATE_ROLES.includes(g?.role)) errors.push(`gates[${i}].role is one of ${GATE_ROLES.join(', ')}`)
    for (const k of ['a', 'b']) if (!Array.isArray(g?.[k]) || g[k].length < 2 || !g[k].every(Number.isFinite)) errors.push(`gates[${i}].${k} is [x, y] in site metres`)
    if (g?.role) roles.set(g.role, (roles.get(g.role) ?? 0) + 1)
  }
  if (c.kind === 'circuit' && roles.get('startfinish') !== 1) errors.push('a circuit has exactly one startfinish gate')
  if (c.kind === 'stage' && (roles.get('start') !== 1 || roles.get('finish') !== 1)) errors.push('a stage has exactly one start and one finish gate')
  if (c.entry !== undefined && !(Number.isFinite(c.entry?.x) && Number.isFinite(c.entry?.y))) errors.push('course.entry is { x, y, r } in site metres')
  if (c.laps !== undefined && !(Number.isInteger(c.laps) && c.laps > 0)) errors.push('course.laps is a whole number')
  return errors
}

/* ---- a bake's frame and its address book ------------------------------------------------------ */

/** The frame a bake's manifest holds — where its metres are measured from. */
async function frameOf(root, slug) {
  if (!root) throw new Error('this tool needs the data root')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug))) throw new Error(`bad slug ${JSON.stringify(slug)}`)
  for (const rel of ['web/manifest.json', 'manifest.json']) {
    const text = await readFile(path.join(root, 'sites', slug, rel), 'utf8').catch(() => null)
    if (!text) continue
    const m = JSON.parse(text)
    if (m.frame) return m.frame
  }
  throw new Error(`${slug} has no baked manifest with a frame — bake it first`)
}

/** the centroid of whatever geometry a feature has, lon/lat */
function centroidOf(coords) {
  const pts = []
  const walk = (c) => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number') { pts.push(c); return }
    for (const q of c) walk(q)
  }
  walk(coords)
  if (!pts.length) return null
  let sx = 0, sy = 0
  for (const p of pts) { sx += p[0]; sy += p[1] }
  return [sx / pts.length, sy / pts.length]
}

/** one index per world, kept while the service runs; a rebake writes a new osm.geojson and a new mtime */
const addressIndexes = new Map()

/**
 * The address book of a bake: every `addr:housenumber` + `addr:street`, every named thing that is
 * not a road, and every road once — the same three kinds the viewer's search box offers, projected
 * into site metres with the same projector.
 */
async function addressIndex(root, slug) {
  const frame = await frameOf(root, slug)
  let file = null
  for (const rel of ['osm.geojson', 'web/osm.geojson']) {
    const f = path.join(root, 'sites', slug, rel)
    if (await readFile(f, { encoding: 'utf8', flag: 'r' }).then(() => true, () => false)) { file = f; break }
  }
  if (!file) throw new Error(`${slug} has no osm.geojson — bake it first`)
  const { stat } = await import('node:fs/promises')
  const mtime = (await stat(file)).mtimeMs
  const cached = addressIndexes.get(slug)
  if (cached && cached.mtime === mtime) return cached
  const proj = siteProjector(frame)
  const gj = JSON.parse(await readFile(file, 'utf8'))
  const entries = []
  const counts = { address: 0, place: 0, road: 0 }
  const roads = new Map()
  for (const f of gj.features ?? []) {
    const p = f.properties ?? {}
    const c = f.geometry ? centroidOf(f.geometry.coordinates) : null
    if (!c) continue
    const [x, y] = proj(c[0], c[1])
    const num = p['addr:housenumber'], street = p['addr:street'], name = p.name
    if (num && street) {
      const label = `${num} ${street}`
      const detail = [name, p['addr:city'], p['addr:postcode']].filter(Boolean).join(' · ')
      entries.push({ kind: 'address', label, detail, x: round(x), y: round(y), hay: `${label} ${name ?? ''} ${p['addr:city'] ?? ''}`.toLowerCase() })
      counts.address++
      continue
    }
    if (name && p.highway) {
      const r = roads.get(name)
      if (r) { r.x += x; r.y += y; r.n++ } else roads.set(name, { x, y, n: 1, cls: p.highway, ref: p.ref })
      continue
    }
    if (name) {
      const what = p.amenity ?? p.shop ?? p.leisure ?? p.tourism ?? p.building ?? p.landuse ?? 'place'
      entries.push({ kind: 'place', label: name, detail: String(what).replace(/_/g, ' '), x: round(x), y: round(y), hay: `${name} ${what}`.toLowerCase() })
      counts.place++
    }
  }
  for (const [name, r] of roads) {
    entries.push({ kind: 'road', label: name, detail: [r.ref, r.cls].filter(Boolean).join(' · '), x: round(r.x / r.n), y: round(r.y / r.n), hay: `${name} ${r.ref ?? ''}`.toLowerCase() })
    counts.road++
  }
  const index = { mtime, entries, counts }
  addressIndexes.set(slug, index)
  if (addressIndexes.size > 4) addressIndexes.delete(addressIndexes.keys().next().value)
  return index
}
