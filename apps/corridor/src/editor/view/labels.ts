// Names on the map, for the mode you are in.
//
// Part of "the active tab's items should appear bolder" (Rich, 2026-10-10): the active mode's
// things carry their names, the passive ones do not. A label is a sprite with a constant on-screen
// size, so a zone's name reads the same from 20 km up as from 200 m, and it is drawn over
// everything — it is an annotation, not an object in the world.
//
// Only the active mode is labelled because the passive layers are there to be SEEN, not read: five
// modes' names at once over a metro area is a page of text with a map behind it.

import * as THREE from 'three'
import { LABEL } from './emphasis'

export interface LabelItem { key: string; text: string; at: [number, number]; colour?: string }

/** At most this many labels at once; past it they are noise, and each one is a texture. */
const MAX = 160
/** The label's height as a fraction of the viewport's — about 20 px on a 900 px canvas. */
const HEIGHT = 0.022

/**
 * A point inside a polygon to hang its name on. The centroid, when that is inside — and for a
 * strip of road it often is not: a zone hugging a curving Beltway has its centroid out in the
 * field. A strip is drawn down one side and back up the other, so the midpoint of vertex i and
 * vertex n-1-i lies on its centreline; try those, then give up and use the first vertex.
 */
export function labelAt(poly: [number, number][]): [number, number] {
  const n = poly.length
  if (!n) return [0, 0]
  let cx = 0, cy = 0
  for (const [x, y] of poly) { cx += x; cy += y }
  cx /= n; cy /= n
  if (pointIn(poly, cx, cy)) return [cx, cy]
  for (const f of [0.5, 0.25, 0.75, 0.125, 0.375]) {
    const i = Math.floor((n / 2) * f)
    const a = poly[i], b = poly[n - 1 - i]
    const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if (pointIn(poly, m[0], m[1])) return m
  }
  return poly[0]
}

function pointIn(poly: [number, number][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function textSprite(text: string, colour: string): THREE.Sprite {
  const font = 600
  const px = 30
  const c = document.createElement('canvas')
  const g = c.getContext('2d')!
  g.font = `${font} ${px}px system-ui, sans-serif`
  const w = Math.ceil(g.measureText(text).width) + 20
  c.width = w
  c.height = px + 16
  g.font = `${font} ${px}px system-ui, sans-serif`
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.lineWidth = 6
  g.strokeStyle = 'rgba(10,14,20,0.85)'
  g.strokeText(text, 10, c.height / 2)
  g.fillStyle = colour
  g.fillText(text, 10, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }))
  s.scale.set((HEIGHT * c.width) / c.height, HEIGHT, 1)
  s.renderOrder = 30
  s.name = LABEL
  return s
}

/** The label layer: one group, rebuilt by diff so a refresh that changed nothing creates nothing. */
export class Labels {
  readonly group = new THREE.Group()
  private have = new Map<string, { sig: string; sprite: THREE.Sprite }>()

  constructor() {
    this.group.name = 'editor-labels'
  }

  set(items: LabelItem[], h: (x: number, y: number) => number) {
    const want = new Map<string, LabelItem>()
    for (const it of items.slice(0, MAX)) if (it.text) want.set(it.key, it)
    for (const [k, v] of this.have) {
      const it = want.get(k)
      if (it && v.sig === `${it.text}|${it.colour ?? ''}`) {
        v.sprite.position.set(it.at[0], h(it.at[0], it.at[1]) + 6, -it.at[1])
        continue
      }
      this.drop(k)
    }
    for (const [k, it] of want) {
      if (this.have.has(k)) continue
      const sprite = textSprite(it.text, it.colour ?? '#f4f6f8')
      sprite.position.set(it.at[0], h(it.at[0], it.at[1]) + 6, -it.at[1])
      this.group.add(sprite)
      this.have.set(k, { sig: `${it.text}|${it.colour ?? ''}`, sprite })
    }
  }

  private drop(k: string) {
    const v = this.have.get(k)
    if (!v) return
    this.group.remove(v.sprite)
    v.sprite.material.map?.dispose()
    v.sprite.material.dispose()
    this.have.delete(k)
  }

  clear() {
    for (const k of [...this.have.keys()]) this.drop(k)
  }

  /** for probes: the names on screen */
  texts(): string[] {
    return [...this.have.values()].map((v) => v.sig.split('|')[0])
  }
}
