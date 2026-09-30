// The editor's documents as MCP tools, so an agent can reach them without a filesystem.
//
// THE SECOND WAY IN, and it exists because the first one does not always apply. The browser shell
// gives an agent `fs/*` and `terminal/*` over the projected documents — which is the right surface
// when the agent is attached to a page. An agent working on its own, or one whose harness prefers
// tools to files, has no page to ask; MCP is the surface it does have.
//
// THE SAME DOCUMENTS AND THE SAME RULES. The paths are the projection's paths
// (apps/corridor/src/agent/projection.ts), so `worlds/crofton-triangle.json` means the same thing
// at a prompt, in the shell and here — and a write through any of them is the same live edit. Two
// vocabularies for one set of documents is how an agent ends up told two different things about
// what exists.
//
// STREAMABLE HTTP, one POST per request, no session state. MCP's stdio transport needs a process
// on the agent's side; this needs a URL it can reach, which in a cluster it has.
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { serverTools } from './mcptools.mjs'

export const PROTOCOL_VERSION = '2025-06-18'

/** The authored documents beside a bake — the same list the projection and gitrepo.mjs use. */
// zones (traffic areas), courses (races) and stunts (fixtures) are authored beside the others and
// are what a game is made of; an agent that could read tuning but not write a race was half a tool
export const SITE_DOCS = ['tuning.json', 'presets.json', 'placements.json', 'adjustments.json', 'structures.json', 'dead_ends.json', 'zones.json', 'courses.json', 'stunts.json', 'fixtures.json', 'surfaces.json', 'points.json']

/*
 * THE SERVICE'S OWN RULES, and they are not all the same one.
 *
 * `levels.mjs` and `store.putProgram` both require at least two characters; a world's slug comes
 * from `slugify`, which has no minimum. Using one regex here would either make a one-character
 * world unreachable through MCP or accept a level id the store will refuse — and the second is
 * worse, because it fails at the write with a message about a slug the agent did not choose.
 */
const WORLD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const ID_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/
/** Matches `PROGRAM_EXT` in store.mjs — what may live under `programs/`. */
const PROGRAM_EXT = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.glsl', '.frag', '.vert', '.css', '.yaml', '.yml']

/**
 * Where a document path lives on the volume, or null.
 *
 * THE SECURITY BOUNDARY, and it is a whitelist rather than a traversal check: `..` is only the
 * obvious way to leave, and a check that looks for it has to be right about every encoding. This
 * builds the path from a matched slug instead, so there is nothing to escape from.
 */
export function resolveDoc(root, docPath) {
  const parts = String(docPath ?? '').split('/')
  if (parts.length === 2 && parts[0] === 'worlds' && parts[1].endsWith('.json') && WORLD_SLUG.test(parts[1].slice(0, -5))) {
    return { file: path.join(root, 'worlds', parts[1]), kind: 'world' }
  }
  if (parts.length === 2 && parts[0] === 'levels' && parts[1].endsWith('.json') && ID_SLUG.test(parts[1].slice(0, -5))) {
    return { file: path.join(root, 'levels', parts[1]), kind: 'level' }
  }
  /*
   * A PROGRAM IS A PATH NOW, with folders in it and an extension that is not always `.ts` — so
   * this one cannot be a single matched slug. It is still built segment by segment from matched
   * names rather than checked for `..`: every segment must be a slug, and the extension must be
   * one of the few this editor keeps beside code. An agent that could not reach
   * `programs/levels/rooftop.ts` would be an agent that cannot see half the volume.
   */
  if (parts.length >= 2 && parts[0] === 'programs') {
    const rest = parts.slice(1)
    const name = rest[rest.length - 1]
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    const ok = rest.length >= 1
      && PROGRAM_EXT.includes(ext)
      && rest.slice(0, -1).every((p) => ID_SLUG.test(p))
      && ID_SLUG.test(name.slice(0, dot))
    if (ok) return { file: path.join(root, 'programs', ...rest), kind: 'program' }
  }
  if (parts.length === 3 && parts[0] === 'sites' && WORLD_SLUG.test(parts[1]) && SITE_DOCS.includes(parts[2])) {
    return { file: path.join(root, 'sites', parts[1], parts[2]), kind: 'site-doc' }
  }
  return null
}

/** Every document that exists, as the projection would list it. */
export async function listDocs(root) {
  const out = []
  // listed only if `resolveDoc` would take it back: a path that lists and cannot be read is the
  // one shape of inconsistency an agent cannot work around
  const dir = async (name, ext) => {
    for (const f of await readdir(path.join(root, name)).catch(() => [])) {
      if (f.endsWith(ext) && resolveDoc(root, `${name}/${f}`)) out.push(`${name}/${f}`)
    }
  }
  await dir('worlds', '.json')
  await dir('levels', '.json')
  // programs recurse, because they have folders
  const walkPrograms = async (rel) => {
    for (const e of await readdir(path.join(root, 'programs', rel), { withFileTypes: true }).catch(() => [])) {
      const next = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { await walkPrograms(next); continue }
      if (resolveDoc(root, `programs/${next}`)) out.push(`programs/${next}`)
    }
  }
  await walkPrograms('')
  for (const slug of await readdir(path.join(root, 'sites')).catch(() => [])) {
    if (!WORLD_SLUG.test(slug)) continue
    for (const d of SITE_DOCS) if (existsSync(path.join(root, 'sites', slug, d))) out.push(`sites/${slug}/${d}`)
  }
  return out.sort()
}

/**
 * The tools, as MCP describes them.
 *
 * Every description says what the thing IS rather than what the call does — an agent choosing
 * between `read_document` and `write_document` does not need to be told that one reads; it needs
 * to be told that a write is a live edit with no undo, which is the only surprising thing here.
 */
export const TOOLS = [
  {
    name: 'list_documents',
    description: 'Every document in this editor: world definitions, levels, level programs, and the tuning and presets beside each baked world. Paths are what read_document and write_document take.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_document',
    description: 'One document, as text. Worlds and levels are JSON; a program is TypeScript.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. worlds/crofton-triangle.json, programs/rooftop.ts' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_document',
    description: 'Replace a document. THIS IS A LIVE EDIT: it takes effect immediately, for everybody with the editor open, and there is no undo. A level is validated before it is written and a bad one is refused.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_level',
    description: 'Check a level document without saving it. Returns every problem rather than the first, and the vocabulary of facts and actions a scenario may use.',
    inputSchema: {
      type: 'object',
      properties: { level: { type: 'object', description: 'the whole level document' } },
      required: ['level'],
      additionalProperties: false,
    },
  },
]

/*
 * What an attached page is expected to offer (apps/corridor/src/agent/bridge.ts). This list exists
 * ONLY to turn "no such tool" into "no editor is attached" — the page is still the authority on
 * what it actually provides, and a name here that no page offers is refused exactly the same way.
 */
export const BRIDGE_TOOL_NAMES = new Set(['shell_exec', 'shell_list', 'code_check', 'code_outline', 'code_hover', 'code_definition', 'editor_state'])

const ok = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Run one tool.
 *
 * `store` and `levels` are the service's own, so a write here goes through exactly the path the
 * editor's own PUT does — validation included. An MCP tool that wrote the file directly would be a
 * second way to make an invalid level, reachable only by an agent.
 */
export async function callTool(name, args, { root, store, levels }) {
  switch (name) {
    case 'list_documents': {
      const docs = await listDocs(root)
      return ok(docs.length ? docs.join('\n') : 'there are no documents yet')
    }
    case 'read_document': {
      const at = resolveDoc(root, args?.path)
      if (!at) return bad(`${JSON.stringify(args?.path ?? null)} is not a document path; call list_documents`)
      const text = await readFile(at.file, 'utf8').catch(() => null)
      return text === null ? bad(`no document at ${args.path}`) : ok(text)
    }
    case 'write_document': {
      const at = resolveDoc(root, args?.path)
      if (!at) return bad(`${JSON.stringify(args?.path ?? null)} is not a document path; call list_documents`)
      const content = String(args?.content ?? '')
      if (at.kind === 'program') {
        if (content.length > 512 * 1024) return bad('a program may be 512 kB')
        await store.putProgram(path.basename(at.file, '.ts'), content)
        return ok(`wrote ${args.path}`)
      }
      let doc
      try {
        doc = JSON.parse(content)
      } catch (e) {
        return bad(`that is not valid JSON: ${e.message}`)
      }
      if (at.kind === 'level') {
        const body = levels.withDefaults({ ...doc, id: path.basename(at.file, '.json') })
        const v = levels.validate(body)
        // REFUSED, not written and reported: an agent that gets "saved, with errors" has no reason
        // to fix them, and the next thing to open that level is a person wondering why it will not
        if (v.errors.length) return bad(`this level does not validate:\n${v.errors.join('\n')}`)
        await store.putLevel(body)
        return ok(`wrote ${args.path}${v.warnings.length ? `\nwarnings:\n${v.warnings.join('\n')}` : ''}`)
      }
      if (at.kind === 'world') {
        await store.putWorld({ ...doc, slug: path.basename(at.file, '.json') })
        return ok(`wrote ${args.path}`)
      }
      await store.putAuthored(`${args.path.slice('sites/'.length)}`, Buffer.from(content))
      return ok(`wrote ${args.path}`)
    }
    case 'validate_level': {
      const v = levels.validate(levels.withDefaults(args?.level ?? {}))
      return ok(JSON.stringify({ ...v, facts: Object.keys(levels.FACTS), actions: Object.keys(levels.ACTIONS) }, null, 1))
    }
    default:
      return bad(`no such tool: ${name}`)
  }
}

/**
 * Answer one MCP request.
 *
 * Three methods is the whole of what a tools-only server needs: say who you are, list what you
 * have, run one. Anything else gets a proper JSON-RPC "method not found" rather than a silence —
 * a client probing for prompts or resources should be told no, not left waiting.
 */
/**
 * Read and write one of a site's authored documents, for the tools that merge into one (a zone
 * into zones.json, a course into courses.json) rather than replacing it whole.
 */
function siteDocAccess(ctx) {
  return {
    async read(slug, name) {
      const at = resolveDoc(ctx.root, `sites/${slug}/${name}`)
      if (!at) throw new Error(`sites/${slug}/${name} is not a document path`)
      const text = await readFile(at.file, 'utf8').catch(() => null)
      return text === null ? null : JSON.parse(text)
    },
    async write(slug, name, doc) {
      const at = resolveDoc(ctx.root, `sites/${slug}/${name}`)
      if (!at) throw new Error(`sites/${slug}/${name} is not a document path`)
      await ctx.store.putAuthored(`${slug}/${name}`, Buffer.from(JSON.stringify(doc, null, 1)))
      return `sites/${slug}/${name}`
    },
  }
}

export async function handle(message, ctx) {
  const { id, method, params } = message ?? {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const error = (code, m) => ({ jsonrpc: '2.0', id, error: { code, message: m } })

  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'corridor-world-editor', version: '1' },
    })
  }
  if (method === 'notifications/initialized' || id === undefined) return null // a notification wants no reply

  /*
   * THREE SOURCES OF TOOLS, and an agent should not be able to tell them apart:
   *
   *   TOOLS          the four document tools below — the original surface
   *   serverTools    everything with an /api handler, run service-side so it works with no
   *                  browser open (mcptools.mjs)
   *   bridge         what an attached editor page brings — the wasm shell, the TypeScript
   *                  service, the live view. Absent from the list when no page is attached,
   *                  because advertising a tool that must fail is worse than not having it.
   */
  const extra = ctx.apiFetch ? serverTools({ apiFetch: ctx.apiFetch, root: ctx.root, siteDoc: siteDocAccess(ctx) }) : []
  const bridged = ctx.bridge?.tools() ?? []
  // only the three fields MCP defines — `run` is ours and must not go over the wire
  const all = [...TOOLS, ...extra.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), ...bridged]

  if (method === 'tools/list') return reply({ tools: all })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    try {
      if (TOOLS.some((t) => t.name === name)) return reply(await callTool(name, args, ctx))
      const own = extra.find((t) => t.name === name)
      if (own) {
        const r = await own.run(args)
        // a tool that made MCP content itself — an image — hands it over as it is
        return reply(r && r.__mcp === 'content' && Array.isArray(r.content) ? { content: r.content } : ok(JSON.stringify(r, null, 2)))
      }
      if (ctx.bridge?.has(name)) return reply(ok(JSON.stringify(await ctx.bridge.call(name, args), null, 2)))
      /*
       * A NAME THE BRIDGE WOULD OFFER IF A PAGE WERE OPEN is the single most likely miss here, and
       * "no such tool" would send an agent looking for a typo. Say which it is.
       */
      if (BRIDGE_TOOL_NAMES.has(name)) {
        return reply(bad(`"${name}" runs inside the editor page and no editor is attached. Open the world editor in a browser and call it again.`))
      }
      return error(-32602, `no such tool: ${name}`)
    } catch (e) {
      // a THROWN tool is still a tool result: MCP distinguishes a protocol error from a tool that
      // failed, and reporting the second as the first makes the agent think the server is broken
      return reply(bad(String(e.message ?? e)))
    }
  }
  return error(-32601, `method not found: ${method}`)
}
