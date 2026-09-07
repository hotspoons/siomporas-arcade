#!/usr/bin/env node
// Operator side of the dev JS shell: POSTs code to the dev server, which
// relays it to the live page and hands back the result. DEV ONLY — the
// endpoint only exists while `vite` runs with APEX_BRIDGE set.
//
//   just bridge 'apex.game.v'
//   just bridge 'apex.three.gl.info.render'
//   node scripts/bridge.mjs --clients
//   node scripts/bridge.mjs --file probe.js
//
// Bare expressions work; multi-line code needs its own `return`. `await` is
// supported either way. The evaluated code gets `apex` — the handles
// registered in src/game/Game.tsx (game, world, input, three, actions,
// constants) — and everything on `window`.

import { readFileSync } from 'node:fs'

const token = process.env.APEX_BRIDGE
if (!token) {
  console.error('APEX_BRIDGE is not set — start the dev server with `just bridge-dev` first.')
  process.exit(2)
}

const origin = process.env.APEX_ORIGIN ?? 'http://localhost:5180'
const argv = process.argv.slice(2)

const flag = (name) => {
  const i = argv.indexOf(name)
  if (i === -1) return null
  return argv.splice(i, 2)[1]
}

const wantClients = argv.includes('--clients')
const file = flag('--file')
const target = flag('--target')
const timeoutMs = flag('--timeout')

async function main() {
  if (wantClients) {
    const res = await fetch(`${origin}/__bridge/clients`, { headers: { 'x-bridge-token': token } })
    console.log(JSON.stringify(await res.json(), null, 2))
    return
  }

  const code = file ? readFileSync(file, 'utf8') : argv.filter((a) => a !== '--clients').join(' ')
  if (!code.trim()) {
    console.error("usage: node scripts/bridge.mjs '<js>' | --file <path> | --clients")
    process.exit(2)
  }

  const res = await fetch(`${origin}/__bridge/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify({
      code,
      target: target ? Number(target) : undefined,
      timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
    }),
  })
  const body = await res.json()
  if (!res.ok || body.ok === false) {
    console.error(body.error ?? body)
    process.exit(1)
  }
  console.log(JSON.stringify(body.result, null, 2))
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})
