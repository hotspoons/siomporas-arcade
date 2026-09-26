// Does the car sit ON the slope, or lean into it?
//
// Rich, 2026-09-26: "the car pitches in the opposite vector as the terrain and lean should be
// happening ... leans correctly over hills and grades, not into them."
//
// The car's model has its nose at local +X, up +Y, right +Z (car.ts buildMesh), and the sim
// measures `pitch` = (front ground - back ground)/3 (positive climbing) and `roll` = (right
// ground - left ground)/width (positive when the ground is higher on the right). So on a slope
// the body's own up vector must match the GROUND NORMAL for that pitch and roll. This checks the
// composed transform against that normal directly — no browser, no GPU, just the rotation code
// from updateMesh.
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
// THE LINES UNDER TEST ARE THE SOURCE'S OWN. A copy of them here would pass for ever after
// someone edited car.ts; these are lifted out of updateMesh and evaluated.
const src = readFileSync(new URL('../apps/corridor/src/car.ts', import.meta.url), 'utf8')
const lines = [...src.matchAll(/this\.mesh\.rotate([XZ])\(([^\n]+?)\)\n/g)].map((m) => `mesh.rotate${m[1]}(${m[2].replace(/this\./g, 'self.')})`)
if (lines.length !== 2) { console.log(`FAIL could not find the two rotate lines in car.ts (found ${lines.length})`); process.exit(1) }
console.log('car.ts:', lines.join('  '))
const apply = new Function('mesh', 'self', 'Math', lines.join('\n'))
const mesh = new THREE.Object3D()
const pose = (yaw, pitch, roll) => {
  mesh.rotation.set(0, -yaw, 0)
  apply(mesh, { pitch, roll }, Math)
  mesh.updateMatrixWorld(true)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion)
  const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion)
  const right = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion)
  return { up, nose, right }
}
let fails = 0
const near = (what, got, want, tol = 0.02) => {
  const ok = Math.abs(got - want) <= tol
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got.toFixed(3)} (want ${want.toFixed(3)})`)
  if (!ok) fails++
}
for (const yaw of [0, Math.PI / 2, 2.4]) {
  const f = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw))
  const r = new THREE.Vector3(-f.z, 0, f.x)
  console.log(`--- yaw ${(yaw * 180 / Math.PI).toFixed(0)}°  forward (${f.x.toFixed(2)}, ${f.z.toFixed(2)})`)
  // climbing a 20% grade: the ground rises ahead, so the nose must rise with it
  {
    const pitch = 0.2
    const { nose, up } = pose(yaw, pitch, 0)
    // the ground normal for this slope, in world: up tilted BACKWARD along the nose
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(f, -pitch).normalize()
    near('nose rises climbing (nose.y)', nose.y, Math.sin(Math.atan(pitch)))
    near('body up matches the slope normal', up.dot(n), 1)
  }
  // a road cambered up to the right: the body must lean with it, right side high
  {
    const roll = 0.15
    const { right, up } = pose(yaw, 0, roll)
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(r, -roll).normalize()
    near('right side rises on a right-high camber (right.y)', right.y, Math.sin(Math.atan(roll)))
    near('body up matches the camber normal', up.dot(n), 1)
  }
}
console.log(fails ? `FAIL ${fails}` : 'PASS')
process.exit(fails ? 1 : 0)
