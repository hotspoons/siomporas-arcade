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
     */
    T('catalog_list', 'Everything placeable: models, their categories and where they came from.', {}, [], () => get('/api/catalog')),
    T('catalog_add', 'Add or update a catalog entry.', { entry: obj('the catalog item') }, ['entry'], (a) => post('/api/catalog', a.entry)),
    T('catalog_delete', 'Remove a catalog entry. The underlying model file is left alone.', { id: str('') }, ['id'], (a) => del(`/api/catalog/${a.id}`)),
    T('model_list', 'Every model file on the volume, with its size and format.', {}, [], () => get('/api/models')),

    T('asset_list', 'The generation catalog: described props and how far along each is — described, drawn, meshed, ready.', {}, [], () => get('/api/assetsvc/catalog')),
    T('asset_get', 'One generated asset: its prompt, its views, its mesh, and the provenance of every step.', { id: str('') }, ['id'], (a) => get(`/api/assetsvc/catalog/${a.id}`)),
    T(
      'asset_describe',
      'Create or edit an asset’s SPEC — what it is, the prompt, what to avoid. Describing does not generate; asset_draw does.',
      { id: str('lower-case, hyphens'), subject: str('the noun'), prompt: str('the full description'), negative: str('what must not appear'), tags: { type: 'array', items: { type: 'string' } } },
      ['id'],
      (a) => post('/api/assetsvc/catalog', a),
    ),
    T(
      'asset_draw',
      'Generate a 2D view from the asset’s prompt. Returns a JOB — poll asset_job. About ten seconds. Costs GPU time on a shared cluster.',
      { id: str(''), seed: num(''), steps: num(''), size: str('e.g. 1024x1024') },
      ['id'],
      (a) => post(`/api/assetsvc/catalog/${a.id}/image`, { seed: a.seed, steps: a.steps, size: a.size }),
    ),
    T(
      'asset_mesh',
      'Reconstruct a 3D mesh from the chosen view, and finish it for the game. Returns a JOB — poll asset_job. Minutes, one at a time, and it is the expensive one.',
      { id: str(''), seed: num(''), finish: bool('run the simplify/unlit/Draco finisher; default true') },
      ['id'],
      (a) => post(`/api/assetsvc/catalog/${a.id}/mesh`, { seed: a.seed, finish: a.finish }),
    ),
    T('asset_job', 'How a generation job is going: queued, running with progress, done with numbers, or failed with why.', { job: str('') }, ['job'], (a) => get(`/api/assetsvc/jobs/${a.job}`)),
    T('asset_services', 'Which generation models this editor is configured for and which are actually answering right now. Read-only: the roster is a deployment decision.', {}, [], () => get('/api/assetsvc/models')),

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

    /* ---- the editor itself --------------------------------------------------------------------- */
    T('editor_config', 'How this editor is configured: which services it can reach, which cluster, what is enabled. The first thing to call when something is refused and you want to know whether it is even turned on.', {}, [], () => get('/api/config')),
    T('editor_ready', 'Whether the editor’s dependencies are answering right now.', {}, [], () => get('/api/ready')),
  ]
}
