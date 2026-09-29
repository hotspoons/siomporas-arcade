// Blender, as something the editor can drive.
//
// Two halves, and they are different animals:
//
//   THE BRIDGE is a long-lived headless Blender with the blender-mcp addon listening on a socket.
//   Code goes in, a result comes back, and the SCENE PERSISTS between calls — which is the whole
//   point: an agent can load an asset, look at it, decide, and act on what it saw. Starting a
//   fresh `blender --background script.py` per step throws the scene away every time.
//
//   THE RIGGERS are batch: `tools/rigging/rig_vehicle.py` and the character rigger each take a
//   file and produce a file. They run in their own Blender because they are deterministic and
//   because a rig that half-finished inside the shared session would poison everything after it.
//
// WHY THE BRIDGE NEEDS `--command blender_mcp`. In `--background` mode `bpy.app.timers` never
// fire, so the addon's interactive poll loop does nothing at all; there is a separate blocking
// loop reached only through that CLI command. Start Blender in the background with the addon
// enabled and expect a bridge and you get a running process with nothing listening — no error
// anywhere. See `tools/rigging/bridge.py`, which speaks the same protocol.

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HOST = process.env.BLENDER_MCP_HOST ?? '127.0.0.1'
const PORT = Number(process.env.BLENDER_MCP_PORT ?? 9876)
const BLENDER = process.env.BLENDER_BIN ?? 'blender'

/** Where renders and exports land, so the editor can list and serve them. */
export const outDir = (root) => path.join(root, 'blender')

/**
 * Run Python inside the live Blender.
 *
 * The protocol is one JSON object, NUL-terminated, in each direction. `strict_json` is the addon's
 * own flag; whatever the code assigns to `result` comes back — and the addon insists that be a
 * dict, which is worth knowing because the error for a bare string is easy to misread as a
 * connection problem.
 */
export function exec(code, { timeoutMs = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: HOST, port: PORT })
    let buf = ''
    const fail = (e) => { sock.destroy(); reject(e) }
    sock.setTimeout(timeoutMs, () => fail(new Error(`blender did not answer in ${Math.round(timeoutMs / 1000)}s`)))
    sock.on('error', (e) => reject(new Error(
      e.code === 'ECONNREFUSED'
        ? `no Blender bridge on ${HOST}:${PORT} — start it with: blender --background --online-mode --command blender_mcp`
        : e.message,
    )))
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'execute', code, strict_json: false })}\0`))
    sock.on('data', (d) => {
      buf += d
      if (!buf.endsWith('\0')) return
      sock.end()
      let out
      try {
        out = JSON.parse(buf.slice(0, -1))
      } catch {
        return reject(new Error(`blender sent something that is not JSON: ${buf.slice(0, 200)}`))
      }
      if (out.status !== 'ok') return reject(new Error(out.message ?? 'blender refused the code'))
      resolve(out.result)
    })
  })
}

/** Is there a Blender to talk to, and what is in it? */
export async function status() {
  try {
    const r = await exec(`
import bpy
result = {"version": bpy.app.version_string, "background": bpy.app.background,
          "objects": [{"name": o.name, "type": o.type} for o in bpy.data.objects]}
`, { timeoutMs: 15_000 })
    return { up: true, ...r }
  } catch (e) {
    return { up: false, why: e.message }
  }
}

/* ---- what the editor can look at ------------------------------------------------------------
 * Every render and every export lands in one directory under the volume, so the UI has one place
 * to list and one route to serve. The name carries the moment it was made: an agent that renders
 * four angles wants four files, not one that keeps being overwritten.
 */

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KIND = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.glb': 'model', '.gltf': 'model', '.stl': 'model', '.obj': 'model', '.ply': 'model', '.fbx': 'model',
  '.mp4': 'video', '.webm': 'video',
}

/** A name nothing can escape from, with the extension kept. */
function stamped(name, ext) {
  const base = String(name || 'out').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'out'
  const when = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  return `${base}-${when}${ext}`
}

export async function listOutputs(root, { limit = 200 } = {}) {
  const dir = outDir(root)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return { dir, files: [] }
  }
  const files = []
  for (const n of names) {
    if (!SAFE.test(n)) continue
    const ext = path.extname(n).toLowerCase()
    const kind = KIND[ext]
    if (!kind) continue
    const s = await stat(path.join(dir, n)).catch(() => null)
    if (!s?.isFile()) continue
    files.push({ name: n, kind, ext: ext.slice(1), bytes: s.size, at: s.mtime.toISOString() })
  }
  files.sort((a, b) => (a.at < b.at ? 1 : -1))
  return { dir, files: files.slice(0, limit) }
}

/** One output file's bytes, for the route that serves it. Refuses anything that is not a name. */
export async function readOutput(root, name) {
  if (!SAFE.test(name) || name.includes('..')) throw Object.assign(new Error('not a file name'), { status: 400 })
  const ext = path.extname(name).toLowerCase()
  if (!KIND[ext]) throw Object.assign(new Error(`${ext || 'that'} is not something this serves`), { status: 400 })
  const file = path.join(outDir(root), name)
  // and the resolved path must still be inside the directory, whatever the name did
  if (path.dirname(path.resolve(file)) !== path.resolve(outDir(root))) {
    throw Object.assign(new Error('outside the output directory'), { status: 400 })
  }
  return { bytes: await readFile(file), ext: ext.slice(1) }
}

/* ---- the operations ------------------------------------------------------------------------ */

/** Open a .glb in the live Blender, replacing what was there. */
export async function load(file) {
  // `read_factory_settings` is refused by the addon's sandbox — rightly, it resets the user's
  // preferences — and it names `read_homefile` as the replacement.
  return exec(`
import bpy
bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(file)})
result = {"objects": [o.name for o in bpy.data.objects], "file": ${JSON.stringify(file)}}
`)
}

// Blender's glTF IMPORTER fabricates this; it is never in the file, and rendering it puts a sphere
// in the shot. Measured: an exported rig has one mesh node, and importing it yields two objects.
const IMPORT_ARTEFACTS = ['Icosphere']

/**
 * Render what is in the scene, from an angle around its own contents, into the output directory.
 *
 * WORKBENCH, not EEVEE. There is no GPU and no display on the service's box; Workbench is a
 * software rasteriser, which is why blrig's own golden-render tier uses it too. Asking for EEVEE
 * here fails inside Blender with a GPU error that reads like a driver problem.
 */
export async function render(root, { name = 'render', az = 45, el = 20, dist = 2.2, width = 800, height = 600 } = {}) {
  const dir = outDir(root)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, stamped(name, '.png'))
  const r = await exec(`
import bpy, math
from mathutils import Vector
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = ${width | 0}, ${height | 0}
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "TEXTURE"
subject = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ${JSON.stringify(IMPORT_ARTEFACTS)}]
if not subject:
    raise RuntimeError("there is no mesh in the scene to render")
lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
for o in subject:
    for c in o.bound_box:
        p = o.matrix_world @ Vector(c)
        lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
        hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
mid = (lo + hi) / 2
size = max((hi - lo).x, (hi - lo).y, (hi - lo).z) or 1.0
cd = bpy.data.cameras.new("shot"); cam = bpy.data.objects.new("shot", cd)
bpy.context.collection.objects.link(cam); scene.camera = cam
az, el = math.radians(${az}), math.radians(${el})
cam.location = mid + Vector((math.cos(el)*math.cos(az), math.cos(el)*math.sin(az), math.sin(el))) * size * ${dist}
cam.rotation_euler = (mid - cam.location).to_track_quat("-Z", "Y").to_euler()
cd.lens = 55
scene.render.filepath = ${JSON.stringify(file)}
scene.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
bpy.data.objects.remove(cam, do_unlink=True)
result = {"subject": [o.name for o in subject], "size_m": round(size, 3)}
`)
  const s = await stat(file).catch(() => null)
  return { ...r, file: path.basename(file), bytes: s?.size ?? 0 }
}

/** Formats Blender will write from a scene, and what each is good for. */
export const EXPORTS = {
  glb: 'glTF binary — the game loads this',
  stl: 'triangles only, no materials or rig — for printing or a solid-body check',
  obj: 'triangles and materials, no rig',
  ply: 'points and triangles, for a scanner pipeline',
}

/** Write the scene out. STL and OBJ carry no rig, which is the thing people are surprised by. */
export async function exportScene(root, { format = 'glb', name = 'export', selectedOnly = false } = {}) {
  const fmt = String(format).toLowerCase()
  if (!EXPORTS[fmt]) throw Object.assign(new Error(`${format} is not one of ${Object.keys(EXPORTS).join(', ')}`), { status: 400 })
  const dir = outDir(root)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, stamped(name, `.${fmt}`))
  const op = {
    glb: `bpy.ops.export_scene.gltf(filepath=F, export_format="GLB", use_selection=SEL, export_def_bones=True)`,
    stl: `bpy.ops.wm.stl_export(filepath=F, export_selected_objects=SEL)`,
    obj: `bpy.ops.wm.obj_export(filepath=F, export_selected_objects=SEL)`,
    ply: `bpy.ops.wm.ply_export(filepath=F, export_selected_objects=SEL)`,
  }[fmt]
  const r = await exec(`
import bpy, os
F = ${JSON.stringify(file)}
SEL = ${selectedOnly ? 'True' : 'False'}
${op}
result = {"format": ${JSON.stringify(fmt)}, "bytes": os.path.getsize(F) if os.path.exists(F) else 0}
`)
  return { ...r, file: path.basename(file) }
}

/* ---- the riggers, which are batch ------------------------------------------------------------
 * These run their OWN Blender rather than the shared session: they are deterministic, they take
 * minutes, and a rig that half-finished inside the live scene would poison every call after it.
 * The live session is for looking and deciding; these are for producing a file.
 */

const REPO = process.env.WORLDEDITOR_REPO ?? path.resolve(process.cwd())

function run(args, { timeoutMs = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BLENDER, args, { cwd: REPO })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('the rigger did not finish in time')) }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`${BLENDER}: ${e.message}`)) })
    p.on('close', (code) => {
      clearTimeout(timer)
      // The riggers report as `@@ <tag> <json>` lines and say nothing else worth keeping; Blender's
      // own chatter is thousands of lines and drowns the report if it is passed through.
      const steps = []
      for (const line of out.split('\n')) {
        const m = /^@@ (\w+) (.*)$/.exec(line.trim())
        if (!m) continue
        try {
          steps.push({ step: m[1], ...JSON.parse(m[2]) })
        } catch {
          steps.push({ step: m[1], raw: m[2] })
        }
      }
      const refused = steps.find((s) => s.step === 'refused')
      if (code !== 0 || refused) {
        return reject(Object.assign(
          new Error(refused ? `the rigger refused: ${refused.why}` : `the rigger exited ${code}`),
          { status: 422, steps, stderr: err.slice(-1500) },
        ))
      }
      resolve({ steps, exported: steps.find((s) => s.step === 'exported') ?? null })
    })
  })
}

const BLRIG = path.join(REPO, 'ext/blender-agent/mcp_ext/blmcp_ext/rigging')

/**
 * Cut a car's wheels off its body and give each one a bone.
 *
 * The wheels of a reconstruction are FUSED to the body — measured, one connected component holds
 * 97% of the vertices — so this is geometry, not connectivity, and it refuses rather than
 * half-rigging. An unrigged car is a working vehicle; a wrongly rigged one is a car that steers
 * with its back wheels and nothing downstream can tell.
 */
export async function rigVehicle(root, { src, out, length, outboard } = {}) {
  if (!src) throw Object.assign(new Error('rigVehicle needs a source .glb'), { status: 400 })
  const dir = outDir(root)
  await mkdir(dir, { recursive: true })
  const dst = out ? path.join(dir, stamped(out, '.glb')) : path.join(dir, stamped(path.basename(src, '.glb') + '-rigged', '.glb'))
  const args = ['--background', '--factory-startup', '--python', path.join(REPO, 'tools/rigging/rig_vehicle.py'),
    '--', '--in', src, '--out', dst]
  if (length) args.push('--length', String(length))
  if (outboard) args.push('--outboard', String(outboard))
  const r = await run(args)
  return { ...r, file: path.basename(dst) }
}

/** Rigify a character: a watertight cage carries the weights, the real mesh keeps its topology. */
export async function rigCharacter(root, { src, out, height, noFace } = {}) {
  if (!src) throw Object.assign(new Error('rigCharacter needs a source .glb'), { status: 400 })
  const dir = outDir(root)
  await mkdir(dir, { recursive: true })
  const dst = out ? path.join(dir, stamped(out, '.glb')) : path.join(dir, stamped(path.basename(src, '.glb') + '-rigged', '.glb'))
  const args = ['--background', '--factory-startup', '--python', path.join(REPO, 'tools/sf2-probe/rigging/rig_character.py'),
    '--', '--in', src, '--out', dst, '--blrig', BLRIG]
  if (height) args.push('--height', String(height))
  if (noFace) args.push('--no-face')
  const r = await run(args)
  return { ...r, file: path.basename(dst) }
}
