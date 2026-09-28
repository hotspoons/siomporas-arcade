#!/usr/bin/env node
// Bring corridor's world surfaces into the one texture library.
//
// Rich, 2026-09-28: "we need to make sure the full world texture library for roads, sidewalks,
// ground cover, etc. is also in our texture asset library, externalized, and configurable per
// world with defaults."
//
// They were in `apps/corridor/public/surfaces/` — inside the app, gitignored, in a manifest shape
// of their own, and reachable only by being on that server's disk. So there were two texture
// libraries: the buildings one the editor can browse, and the road one nothing could see.
//
// TWO SHAPES, ONE LIBRARY. A building material is flat — one id, three maps, a tile size. A world
// surface has VARIANTS: three drawings of the same asphalt, picked per tile so a road does not
// visibly repeat. Rather than flatten them into three materials, the variant list comes across as
// a field, because "these three are the same surface" is real information and a road that picks
// between unrelated textures looks wrong in a way that is hard to name.
//
//   node tools/assetsvc/import-surfaces.mjs --from apps/corridor/public/surfaces --to <data>/surfaces

import { mkdir, readdir, readFile, writeFile, symlink, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1] }
const has = (k) => process.argv.includes(`--${k}`)

const FROM = path.resolve(arg('from', 'apps/corridor/public/surfaces'))
const TO = path.resolve(arg('to', path.join(process.env.ASSETSVC_DATA ?? 'ext/assetsvc', 'surfaces')))
const COPY = has('copy')
const DRY = has('dry-run')

/**
 * What each surface is FOR.
 *
 * The editor groups the library by category, and "8 things called surfaces" is not a browsable
 * library. These are the roles corridor actually draws them in — derived from the name rather
 * than declared, because the manifest has no such field and inventing one in eight places by hand
 * is how the names and the roles drift apart.
 */
const CATEGORY = [
  [/asphalt|chipseal/, 'road'],
  [/concrete/, 'paving'],
  [/grass/, 'ground_cover'],
  [/gravel|shoulder/, 'shoulder'],
  [/sidewalk|pavement/, 'sidewalk'],
]
const categoryOf = (name) => CATEGORY.find(([re]) => re.test(name))?.[1] ?? 'world'

const manifestPath = path.join(FROM, 'surfaces.json')
if (!existsSync(manifestPath)) {
  console.error(`no surfaces.json at ${manifestPath}`)
  process.exit(1)
}
const doc = JSON.parse(await readFile(manifestPath, 'utf8'))
const sets = doc.sets ?? []

const place = async (src, dst) => {
  if (!existsSync(src)) return false
  if (DRY) return true
  await rm(dst, { force: true })
  if (COPY) await copyFile(src, dst)
  else await symlink(path.resolve(src), dst)
  return true
}

/** `surfaces/asphalt_new/albedo.jpg` -> `albedo.jpg`: the library addresses files by name. */
const base = (p) => (p ? path.basename(p) : undefined)

if (!DRY) await mkdir(TO, { recursive: true })

const out = []
let files = 0
const problems = []

for (const s of sets) {
  const src = path.join(FROM, s.name)
  if (!existsSync(src)) { problems.push(`${s.name}: no directory`); continue }
  if (!DRY) await mkdir(path.join(TO, s.name), { recursive: true })
  for (const f of await readdir(src)) {
    if (await place(path.join(src, f), path.join(TO, s.name, f))) files += 1
  }
  const variants = (s.variants ?? []).map((v) => ({
    albedo: base(v.albedo), normal: base(v.normal), roughness: base(v.roughness),
  }))
  out.push({
    id: s.name,
    category: categoryOf(s.name),
    name: s.name.replace(/_/g, ' '),
    // `metres` in corridor's manifest, `metres_per_tile` in the library's. One name from here on.
    metres_per_tile: s.metres_per_tile ?? s.metres ?? 1,
    albedo: base(s.albedo),
    normal: base(s.normal),
    roughness: base(s.roughness),
    ...(variants.length > 1 ? { variants } : {}),
    origin: { library: 'corridor-world', manifest: 'surfaces.json' },
  })
}

// MERGE, never replace. The buildings materials are already here and this is the same library.
const existingPath = path.join(TO, 'materials.json')
const existing = existsSync(existingPath)
  ? JSON.parse(await readFile(existingPath, 'utf8')).materials ?? []
  : []
const byId = new Map(existing.map((m) => [m.id, m]))
for (const m of out) byId.set(m.id, m)
const merged = [...byId.values()].sort((a, b) => (a.category + a.id < b.category + b.id ? -1 : 1))

if (!DRY) await writeFile(existingPath, JSON.stringify({ materials: merged }, null, 1))

console.log(`${DRY ? '[dry run] ' : ''}${out.length} world surfaces into ${TO}`)
console.log(`  ${files} files ${COPY ? 'copied' : 'symlinked'}, ${merged.length} materials in the library now`)
const cats = merged.reduce((m, x) => ({ ...m, [x.category]: (m[x.category] ?? 0) + 1 }), {})
console.log(`  categories: ${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(', ')}`)
for (const p of problems) console.log(`  - ${p}`)
