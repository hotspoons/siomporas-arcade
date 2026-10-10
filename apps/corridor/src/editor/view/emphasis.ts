// Every mode's things, drawn in every mode: the active one at full strength, the rest quieter.
//
// Rich, 2026-10-10: *"An ask I had early on was for all of the tabs assets to be visible from all
// other tabs in the place editor, so traffic zones will show up when you are in the structures tab,
// this never happened. The active tab's items should appear bolder than other tabs items and be
// first on selection when clicking, but we need all the items visible from this editor all the
// time."*
//
// It never happened because each overlay's visibility was a mode test (`traffic.group.visible =
// mode === 'traffic'`, the same for points and the race gates), written when the worry was a
// kilometre of zone paint hiding the ground you were editing. The answer to that worry is weight,
// not absence: a PASSIVE layer is drawn at about half its opacity, with thinner outlines and no
// handles, so it is plainly there and plainly not the thing you are working on.
//
// ONE PASS OVER A GROUP, AFTER THE MODE HAS DRAWN IT. The modes keep choosing their own colours and
// opacities (a zone's fill IS its traffic level; a selected area is brighter), and this scales what
// they chose. It remembers, per material, the value the mode set and the value it applied itself;
// a material whose opacity is no longer the applied one has been rewritten by its mode since, and
// that rewrite is the new base. So a mode never has to know it is passive, and an edit made while
// it is — a zone added from a drop, a document reloaded off disk because MCP wrote it — comes out
// quiet on the next pass instead of shouting until the mode is next entered.
//
// ONLY MARKS FADE. Unlit materials (MeshBasic, LineBasic, the fat-line LineMaterial) are authoring
// marks; a lit material is the world — a placed diner, a stunt loop, a bridge — and it is drawn as
// the game draws it in every mode. A subtree flagged `userData.emphasisKeep` is skipped outright,
// which is how a bridge's stand-in slab (unlit, but a real structure) stays solid.

import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

export type Emphasis = 'active' | 'passive'

/** A passive layer's opacity, as a fraction of what its mode drew it at. */
export const PASSIVE_OPACITY = 0.55
/** …and its outlines' width, likewise. */
export const PASSIVE_WIDTH = 0.6
/** The name `handleMesh` gives a grab handle: hidden while its mode is passive, so it cannot be mistaken for one that works. */
export const HANDLE = 'editor-handle'
/** Overlay labels (view/labels.ts) are drawn only for the active mode. */
export const LABEL = 'editor-label'

interface Kept { op: number; tr: boolean; lw: number; aop: number; atr: boolean; alw: number }

const isMark = (m: THREE.Material) => m instanceof THREE.MeshBasicMaterial || m instanceof THREE.LineBasicMaterial || m instanceof LineMaterial

/** Scale one material to an emphasis, remembering what its mode asked for. */
export function emphasise(m: THREE.Material, e: Emphasis): void {
  if (!isMark(m)) return
  const lm = m instanceof LineMaterial ? m : null
  const k = m.userData.emphasis as Kept | undefined
  // first sight, or the mode has rewritten it since the last pass: what is there now is the base
  const op = !k || m.opacity !== k.aop ? m.opacity : k.op
  const tr = !k || m.transparent !== k.atr ? m.transparent : k.tr
  const lw = lm ? (!k || lm.linewidth !== k.alw ? lm.linewidth : k.lw) : 0
  const passive = e === 'passive'
  const aop = passive ? op * PASSIVE_OPACITY : op
  const atr = passive ? true : tr
  const alw = lm ? (passive ? Math.max(1, lw * PASSIVE_WIDTH) : lw) : 0
  if (m.transparent !== atr) {
    m.transparent = atr
    m.needsUpdate = true
  }
  m.opacity = aop
  if (lm) lm.linewidth = alw
  m.userData.emphasis = { op, tr, lw, aop, atr, alw } satisfies Kept
}

/** One pass over a mode's group. Cheap: overlays are tens to hundreds of objects, not the world. */
export function applyEmphasis(root: THREE.Object3D, e: Emphasis): void {
  const walk = (o: THREE.Object3D) => {
    if (o.userData.emphasisKeep) return
    if (o.name === HANDLE || o.name === LABEL) o.visible = e === 'active'
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) for (const m of mat) emphasise(m, e)
    else if (mat) emphasise(mat, e)
    for (const c of o.children) walk(c)
  }
  walk(root)
}

/** What an emphasis does to a number a mode computes itself (a label's alpha, say). */
export const emphasisOf = (e: Emphasis) => (e === 'active' ? 1 : PASSIVE_OPACITY)
