// One-shot things that happened during a tick, for VFX/audio/haptics. A fixed
// ring the app drains once per frame; overflow drops the oldest, which is fine
// for feedback and wrong for gameplay — so gameplay never reads this.

import { Vec3 } from '@apex/engine/math/Vec3'

export type SimEventType =
  | 'kill'
  | 'hit'
  | 'collision'
  | 'scrape'
  | 'gate'
  | 'boost_enter'
  | 'boost_exit'
  | 'shockwave'
  | 'overheat'
  | 'pickup'
  | 'ring'
  | 'launch'
  | 'land'
  | 'crash'
  | 'fall'
  | 'shot_fired'
  | 'enemy_shot'
  | 'finish'
  | 'timeout'
  | 'combo'
  | 'charge_earned'
  | 'boss_spawn'
  | 'boss_dead'
  | 'train'
  | 'spinout'

export interface SimEvent {
  type: SimEventType
  pos: Vec3
  /** Free-form scalar payload (kill kind code, damage, combo level…). */
  a: number
  b: number
}

const CAPACITY = 64

export class EventQueue {
  private readonly items: SimEvent[] = []
  private head = 0
  private count = 0

  constructor() {
    for (let i = 0; i < CAPACITY; i++) this.items.push({ type: 'hit', pos: new Vec3(), a: 0, b: 0 })
  }

  push(type: SimEventType, pos: Vec3 | null, a = 0, b = 0): void {
    const idx = (this.head + this.count) % CAPACITY
    const e = this.items[idx]
    e.type = type
    if (pos) e.pos.copy(pos)
    else e.pos.set(0, 0, 0)
    e.a = a
    e.b = b
    if (this.count < CAPACITY) this.count++
    else this.head = (this.head + 1) % CAPACITY
  }

  /** Visit and clear. */
  drain(fn: (e: SimEvent) => void): void {
    for (let i = 0; i < this.count; i++) fn(this.items[(this.head + i) % CAPACITY])
    this.count = 0
    this.head = 0
  }

  clear(): void {
    this.count = 0
    this.head = 0
  }

  get length(): number {
    return this.count
  }
}
