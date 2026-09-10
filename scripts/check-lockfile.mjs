// Does package-lock.json still describe every machine this repo is built on?
//
// Several dependencies ship their real work as a native binary, one package per platform, pulled in
// as optional dependencies: oxlint, esbuild, rolldown, sharp, workerd. The lockfile is supposed to
// list all of them, and npm picks the right one at install time.
//
// `npm install` writes a lockfile describing what it *installed*, which is only ever this machine's
// platform. Run it on an arm64 dev container after deleting the lockfile and the x64 entries are
// gone — install cleanly on an x64 CI runner and the linter has no binary to run, from a lockfile
// that works perfectly where it was written. That happened, and it takes a while to see, because
// everything passes locally and in a fresh clone of the same tree.
//
// `npm install --package-lock-only` resolves the whole graph without installing any of it and keeps
// every platform. So: never regenerate the lockfile without it, and let this catch it when someone
// does. Run by `just check` and by CI.

import { readFileSync } from 'node:fs'

/** Where this repo is developed and built. A lockfile that cannot serve these is broken. */
const REQUIRED = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'arm64'],
]

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

/**
 * Group the platform-locked packages into families: a scope like `@oxlint`, or a name with its
 * platform suffix taken off, like lightningcss-linux-x64-gnu → lightningcss. A family with one
 * member is something that only exists on one platform at all (fsevents, on macOS) rather than a set
 * of builds of the same thing, and there is nothing to be missing from it.
 */
const families = new Map()
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
  if (!pkg.os && !pkg.cpu) continue
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const family = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : name.replace(/-(linux|darwin|win32|android|freebsd|openharmony|wasm|wasi)(-.+)?$/, '')
  const covers = families.get(family) ?? []
  covers.push({ path, os: pkg.os ?? [], cpu: pkg.cpu ?? [] })
  families.set(family, covers)
}

const missing = []
for (const [scope, covers] of families) {
  if (covers.length < 2) continue
  for (const [os, cpu] of REQUIRED) {
    const has = covers.some((c) => (c.os.length === 0 || c.os.includes(os)) && (c.cpu.length === 0 || c.cpu.includes(cpu)))
    if (!has) missing.push(`${scope} has nothing for ${os}/${cpu}`)
  }
}

if (families.size === 0) {
  console.error('lockfile check: no native-binary packages found at all, which cannot be right — has the lockfile been truncated?')
  process.exit(1)
}
if (missing.length) {
  console.error(`lockfile check: package-lock.json only covers the machine it was written on.\n`)
  for (const m of missing) console.error(`  ${m}`)
  console.error(`\nRegenerate it with the whole graph rather than just this platform:\n\n  rm package-lock.json && npm install --package-lock-only && npm install\n`)
  process.exit(1)
}

console.log(`lockfile check: ${families.size} native-binary families, all covering ${REQUIRED.map(([o, c]) => `${o}/${c}`).join(', ')}`)
