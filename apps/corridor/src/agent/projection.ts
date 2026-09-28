// The editor's documents, as a filesystem.
//
// Rich, 2026-09-28: "a lightweight shell that runs in the browser itself and has virtual access to
// the workspace projected into the phony busybox shell."
//
// THE POINT OF THE PROJECTION. An agent that can only call `PUT /api/levels/rooftop` has to know
// this codebase's API. An agent that can read and write files can be told "the worlds are in
// worlds/, the programs in programs/, go and look" — and so can a person, at a prompt, with `ls`
// and `grep` and `sed`. The same shell serves both, which is the whole reason it exists rather
// than a form per document type.
//
// PURE. A path in, an endpoint out; a list of documents in, a set of files out. No fetch, no
// worker, no DOM. What makes that worth insisting on: the failure mode here is a write that lands
// in the wrong place — a program saved as a level, one world's tuning saved over another's — and
// that is a thing to find in a test rather than on the volume.
//
// WHAT IS NOT PROJECTED: the bake. A site's rasters are gigabytes and re-derivable, and a shell
// that mirrors them into memory is a tab that runs out of it. `sites/<slug>/` holds the documents
// somebody authored and nothing the bake wrote — the same split gitrepo.mjs makes, for the same
// reason.

export const ROOT = '/workspace'

/** Where a projected file came from, and therefore where a write goes back to. */
export interface Endpoint {
  method: 'PUT'
  /** the URL, relative to the page */
  url: string
  /** how the body is built: a JSON document, a source string the service wraps, or bytes as they are */
  body: 'json' | 'source' | 'raw'
  /** what it is, for a message a person reads */
  what: string
}

/** What the service says exists — only the fields the projection needs. */
export interface DocSources {
  worlds?: { slug: string }[]
  levels?: { id: string }[]
  /** ids carry their folders and their extension: `levels/rooftop.ts` */
  programs?: { id: string }[]
  /** which sites have authored documents, and which of them */
  sites?: { slug: string; docs: string[] }[]
}

/** The authored documents beside a bake. The same list gitrepo.mjs commits, deliberately. */
export const SITE_DOCS = ['tuning.json', 'presets.json', 'placements.json', 'adjustments.json', 'structures.json', 'dead_ends.json']

/** Matches PROGRAM_EXT in tools/worldeditor/store.mjs, which is the authority. */
const PROGRAM_EXT = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.glsl', '.frag', '.vert', '.css', '.yaml', '.yml']

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Where a path under /workspace writes back to, or null when it writes nowhere.
 *
 * Null is not a failure: `/workspace/out/notes.md` and `/workspace/scratch.py` are the shell's own
 * files, and a shell you cannot keep a scratch file in is not a shell. They live in the machine and
 * go when the tab does, which the projected README says out loud.
 */
export function endpointFor(path: string): Endpoint | null {
  if (!path.startsWith(`${ROOT}/`)) return null
  const rel = path.slice(ROOT.length + 1)
  const parts = rel.split('/')

  if (parts.length === 2 && parts[0] === 'worlds' && parts[1].endsWith('.json')) {
    const slug = parts[1].slice(0, -5)
    if (!SLUG.test(slug)) return null
    return { method: 'PUT', url: `/api/worlds/${slug}`, body: 'json', what: `the world ${slug}` }
  }
  if (parts.length === 2 && parts[0] === 'levels' && parts[1].endsWith('.json')) {
    const id = parts[1].slice(0, -5)
    if (!SLUG.test(id)) return null
    return { method: 'PUT', url: `/api/levels/${id}`, body: 'json', what: `the level ${id}` }
  }
  /*
   * A PROGRAM PATH CARRIES ITS FOLDERS AND ITS EXTENSION, so this matches the rest of the path
   * rather than one slug: `programs/levels/rooftop.ts` is a program, and so is
   * `programs/lib/data.json`. Every segment still has to be a slug — the shell can write anywhere
   * it can name, so the names are the boundary.
   */
  if (parts.length >= 2 && parts[0] === 'programs') {
    const rest = parts.slice(1)
    const name = rest[rest.length - 1]
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || !PROGRAM_EXT.includes(name.slice(dot))) return null
    if (!rest.slice(0, -1).every((p) => SLUG.test(p)) || !SLUG.test(name.slice(0, dot))) return null
    const id = rest.join('/')
    // the service takes `{ source }`, not the bare text: a program is source and a document at once
    return { method: 'PUT', url: `/api/programs/${id}`, body: 'source', what: `the program ${id}` }
  }
  if (parts.length === 3 && parts[0] === 'sites' && SITE_DOCS.includes(parts[2])) {
    const slug = parts[1]
    if (!SLUG.test(slug)) return null
    return { method: 'PUT', url: `/sites/${slug}/${parts[2]}`, body: 'json', what: `${parts[2]} for ${slug}` }
  }
  return null
}

/** Every path the projection will create, from what the service says exists. */
export function pathsFor(docs: DocSources): string[] {
  const out: string[] = []
  for (const w of docs.worlds ?? []) if (SLUG.test(w.slug)) out.push(`${ROOT}/worlds/${w.slug}.json`)
  for (const l of docs.levels ?? []) if (SLUG.test(l.id)) out.push(`${ROOT}/levels/${l.id}.json`)
  for (const p of docs.programs ?? []) if (endpointFor(`${ROOT}/programs/${p.id}`)) out.push(`${ROOT}/programs/${p.id}`)
  for (const s of docs.sites ?? []) {
    if (!SLUG.test(s.slug)) continue
    for (const d of s.docs) if (SITE_DOCS.includes(d)) out.push(`${ROOT}/sites/${s.slug}/${d}`)
  }
  return out
}

/**
 * The note at the top of the projected workspace.
 *
 * A shell with someone else's files in it has to say whose they are and what saving does, in the
 * one place a person or an agent will certainly look. Especially the third paragraph: an agent
 * that does not know a write is a live edit to a world will find that out by making one.
 */
export function readme(docs: DocSources): string {
  const n = (a?: unknown[]) => a?.length ?? 0
  return `# The editor's workspace

This is a real shell — coreutils, python, js — over the world editor's own documents. It runs
entirely in this browser tab and has no network of its own.

    worlds/<slug>.json          ${n(docs.worlds)} world definitions: where, how big, which road is the spine
    levels/<id>.json            ${n(docs.levels)} levels: a world dressed and given something to do
    programs/<path>             ${n(docs.programs)} programs: the code half of a level
    sites/<slug>/tuning.json    per-world knob overrides, and presets.json beside it
    out/                        yours; nothing here is saved anywhere

SAVING IS IMMEDIATE. Writing one of the files above is an edit to the live document, the moment the
command finishes — there is no commit step and no undo. Work in out/ while you are working
something out.

The bake is NOT here. A site's rasters are gigabytes and reproducible from the world definition, so
only the documents somebody authored are projected.
`
}

/** How a save's body is built, per endpoint kind. */
export function bodyFor(e: Endpoint, text: string): string {
  if (e.body === 'source') return JSON.stringify({ source: text })
  return text
}

/**
 * Is this text a usable document for where it is going?
 *
 * Checked BEFORE the request, because the failure otherwise is a 400 from the service quoting a
 * JSON parse error at a byte offset, about a file somebody edited with `sed` and does not have on
 * screen.
 */
export function checkBody(e: Endpoint, text: string): string | null {
  if (e.body === 'source') return text.length > 512 * 1024 ? 'a program may be 512 kB' : null
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object') return `${e.what} has to be a JSON object`
    return null
  } catch (err) {
    return `${e.what} is not valid JSON: ${String((err as Error).message)}`
  }
}
