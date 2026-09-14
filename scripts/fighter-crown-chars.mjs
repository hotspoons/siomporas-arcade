#!/usr/bin/env node
// Write the CONCRETE CROWN characters as copies of the Street Fighter II stat blocks.
//
//   node scripts/fighter-crown-chars.mjs
//
// WHAT THIS IS AND IS NOT. The numbers in src/data/chars/{ryu,zangief,blanka}.json were measured
// out of the arcade ROM by tools/sf2-probe — they are the real thing, and they are the reason the
// game feels like it does. The roster in apps/fighter/ROSTER.md is ours. This script marries the
// two: each of our fighters gets an archetype's measured frame data verbatim, renamed.
//
// So these are PLACEHOLDER MECHANICS, deliberately. Kestrel is not "our take on a shoto" — she is,
// for now, the shoto's exact numbers under her own name, so that she can be played, animated and
// looked at while the art is made. Tuning her away from them is a later job and wants a tuning
// panel, not a text editor. The `$from` field on every file records what it was copied from so that
// job can tell measured numbers from invented ones.
//
// The mapping, and why each one:
//
//   KESTREL  <- ryu       all-rounder: a projectile, a rising invincible reversal, a travelling
//                         spin kick. ROSTER gives her the first two by name.
//   BOLLARD  <- zangief   grappler: a 360 command throw that is the most damaging move in the game,
//                         and a spinning multi-hit strike, no projectile.
//   CANDELA  <- blanka    mixup: a charged horizontal roll, a mashed rapid-fire string, a rising
//                         roll. Her ROSTER specials are a rolling kick arc and a stomp string, so
//                         this is the closest fit on the board.
//
// Where ROSTER names only two specials and the archetype has three, the third is named here rather
// than left as the original — a move called `tatsumaki` inside Kestrel's file is how a placeholder
// quietly becomes permanent.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHARS = path.join(ROOT, 'apps/fighter/src/data/chars')

/**
 * `specials` and `throw` rename the moves; `colors` are the costume's two strongest notes out of
 * ROSTER.md, which is what the renderer tints the fallback boxes with.
 */
const CROWN = [
  {
    id: 'kestrel',
    name: 'KESTREL',
    from: 'ryu',
    who: 'Wren Adisa — dambe boxing crossed with kickboxing. The tutorial character.',
    colors: { body: '#1f4f4a', trim: '#b4531f' },
    throw: 'Hook Throw',
    specials: {
      hadouken: { id: 'kite-line', name: 'Kite Line' },
      shoryuken: { id: 'updraft', name: 'Updraft' },
      tatsumaki: { id: 'crosswind', name: 'Crosswind' },
    },
  },
  {
    id: 'bollard',
    name: 'BOLLARD',
    from: 'zangief',
    who: 'Duncan Mear — Scottish backhold wrestling and forty years on a door.',
    colors: { body: '#a8b23f', trim: '#8f2b2b' },
    throw: "Doorman's Welcome",
    specials: {
      spd: { id: 'bear-yoke', name: 'Bear Yoke' },
      lariat: { id: 'bollard-drop', name: 'Bollard Drop' },
    },
  },
  {
    id: 'candela',
    name: 'CANDELA',
    from: 'blanka',
    who: 'Rosalía Mbeki-Ferrán — capoeira with flamenco footwork bolted on.',
    colors: { body: '#e8b62c', trim: '#d2481b' },
    throw: 'Heel Drag',
    specials: {
      'rolling-attack': { id: 'ember-wheel', name: 'Ember Wheel' },
      'electric-thunder': { id: 'zapateado', name: 'Zapateado' },
      'vertical-roll': { id: 'rising-wheel', name: 'Rising Wheel' },
    },
  },
]

for (const c of CROWN) {
  const src = JSON.parse(readFileSync(path.join(CHARS, `${c.from}.json`), 'utf8'))

  const unmapped = src.specials.map((s) => s.id).filter((id) => !c.specials[id])
  if (unmapped.length) throw new Error(`${c.id}: no name given for ${c.from} specials ${unmapped.join(', ')}`)

  const out = {
    $comment:
      `${c.name} — ${c.who} PLACEHOLDER MECHANICS: every number in this file is ${c.from}'s, ` +
      'measured out of Street Fighter II: Champion Edition and copied verbatim by ' +
      'scripts/fighter-crown-chars.mjs. Only the names, the art directory and the colours are ours. ' +
      'See apps/fighter/ROSTER.md for who she or he actually is, and rebalance from here.',
    $from: c.from,
    id: c.id,
    name: c.name,
    // Her own art directory, which does not exist yet: Sprites.ts returns null for a missing atlas
    // and the renderer falls back to tinted boxes, so the character is playable before she is drawn.
    art: c.id,
    colors: c.colors,
    ...Object.fromEntries(Object.entries(src).filter(([k]) => !['$comment', 'id', 'name', 'art', 'colors', 'specials', 'throw'].includes(k))),
    throw: { ...src.throw, name: c.throw },
    specials: src.specials.map((s) => {
      const renamed = c.specials[s.id]
      // `anim` follows the id: it is a directory name in the atlas, and leaving it as the original
      // would have Kestrel's art filed under `hadouken`.
      return { ...s, id: renamed.id, name: renamed.name, anim: renamed.id }
    }),
  }

  const file = path.join(CHARS, `${c.id}.json`)
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`${path.relative(ROOT, file)}  <- ${c.from}  ${out.specials.map((s) => s.id).join(', ')}`)
}
