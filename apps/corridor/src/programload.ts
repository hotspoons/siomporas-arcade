// Loading a level program's JavaScript as a module, in a page that already holds its imports.
//
// A program says `import { defineGame } from '@apex/program'`, and in the repo that is a file. In
// a running page it is not: the program is compiled elsewhere (the Program pane's TypeScript
// worker, or the world editor's `?js=1`) and arrives as text, and `@apex/program` has to resolve
// to the SAME module instances this page already runs — a second copy of the ECS would be a world
// the level cannot see. So every bare specifier the API allows is rewritten to a blob module that
// re-exports from the live module, held on `globalThis` for the shim to reach.
//
// This used to live inside the Program pane. It is here so the viewer can run a program a level
// names with exactly the loader the pane dry-runs it with.

import * as bitecsApi from 'bitecs'
import * as programApi from './program'
import * as actorsApi from './actors'
import * as actorworldApi from './actorworld'
import * as ecsconfigApi from './ecsconfig'
import * as trafficApi from './traffic'
import type { GameDef } from './program'

export const MODULES: Record<string, Record<string, unknown>> = {
  // BITECS TOO, because a program that touches the ECS imports it directly — `addComponent`,
  // `query`, `removeEntity`. Without it a dry run of anything real fails at module resolution
  // with "failed to fetch dynamically imported module", which says nothing about the cause.
  bitecs: bitecsApi as unknown as Record<string, unknown>,
  '@apex/program': programApi as unknown as Record<string, unknown>,
  '@apex/actors': actorsApi as unknown as Record<string, unknown>,
  '@apex/actorworld': actorworldApi as unknown as Record<string, unknown>,
  '@apex/ecsconfig': ecsconfigApi as unknown as Record<string, unknown>,
  '@apex/traffic': trafficApi as unknown as Record<string, unknown>,
}

const shims = new Map<string, string>()

export function shimFor(name: string): string | null {
  const mod = MODULES[name]
  if (!mod) return null
  const cached = shims.get(name)
  if (cached) return cached
  const g = globalThis as unknown as { __APEX_PROGRAM_MODULES?: typeof MODULES }
  g.__APEX_PROGRAM_MODULES ??= MODULES
  const keys = Object.keys(mod).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const src = [
    `const m = globalThis.__APEX_PROGRAM_MODULES[${JSON.stringify(name)}];`,
    ...keys.map((k) => `export const ${k} = m[${JSON.stringify(k)}];`),
  ].join('\n')
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  shims.set(name, url)
  return url
}

export function rewriteImports(js: string): string {
  return js.replace(/(['"])(@apex\/[a-z]+|bitecs)\1/g, (m, q, name) => {
    const url = shimFor(name)
    return url ? `${q}${url}${q}` : m
  })
}

/**
 * Compiled program text to its `GameDef`. Throws with a plain sentence when the module has no
 * default export, which is the mistake every first program makes.
 */
export async function loadGameModule(js: string): Promise<GameDef> {
  const blob = URL.createObjectURL(new Blob([rewriteImports(js)], { type: 'text/javascript' }))
  try {
    const mod = (await import(/* @vite-ignore */ blob)) as { default?: GameDef }
    const def = mod.default
    if (!def || typeof def !== 'object') throw new Error('the program has no default export — it should end with `export default defineGame({ ... })`')
    return def
  } finally {
    URL.revokeObjectURL(blob)
  }
}
