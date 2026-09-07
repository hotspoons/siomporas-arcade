// Minimal mutable 3-vector for the simulation layer. The sim must not import
// three.js (it has to run headless in tests and stay deterministic), so this
// is the one vector type everything under src/sim uses. Every method mutates
// `this` and returns it, and nothing here allocates after construction — hot
// loops pass scratch vectors in rather than creating them.

export class Vec3 {
  x: number
  y: number
  z: number

  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }

  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  copy(v: Vec3): this {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z)
  }

  add(v: Vec3): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }

  sub(v: Vec3): this {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }

  scale(k: number): this {
    this.x *= k
    this.y *= k
    this.z *= k
    return this
  }

  /** this += v * k */
  addScaled(v: Vec3, k: number): this {
    this.x += v.x * k
    this.y += v.y * k
    this.z += v.z * k
    return this
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z
  }

  /** this = a × b */
  cross(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y
    const y = a.z * b.x - a.x * b.z
    const z = a.x * b.y - a.y * b.x
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }

  normalize(): this {
    const l = this.length()
    if (l > 1e-12) this.scale(1 / l)
    return this
  }

  distanceTo(v: Vec3): number {
    const dx = this.x - v.x
    const dy = this.y - v.y
    const dz = this.z - v.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** this = a + (b - a) * t */
  lerpVectors(a: Vec3, b: Vec3, t: number): this {
    this.x = a.x + (b.x - a.x) * t
    this.y = a.y + (b.y - a.y) * t
    this.z = a.z + (b.z - a.z) * t
    return this
  }

  /** Rotate `this` about unit `axis` by `angle` radians (Rodrigues). */
  rotateAxis(axis: Vec3, angle: number): this {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const d = axis.dot(this) * (1 - c)
    const cx = axis.y * this.z - axis.z * this.y
    const cy = axis.z * this.x - axis.x * this.z
    const cz = axis.x * this.y - axis.y * this.x
    const x = this.x * c + cx * s + axis.x * d
    const y = this.y * c + cy * s + axis.y * d
    const z = this.z * c + cz * s + axis.z * d
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  /** Remove the component of `this` along unit `n`. */
  projectOntoPlane(n: Vec3): this {
    const d = this.dot(n)
    this.x -= n.x * d
    this.y -= n.y * d
    this.z -= n.z * d
    return this
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z)
  }
}
