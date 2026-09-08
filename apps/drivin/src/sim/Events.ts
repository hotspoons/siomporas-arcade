// One-shot happenings for VFX/audio/HUD. Fixed ring, drained once per frame.

import { Vec3 } from '@apex/engine/math/Vec3'

export type SimEventType = 'crash' | 'land' | 'launch' | 'lap' | 'respawn' | 'curb' | 'offroad' | 'onroad' | 'penalty' | 'gear' | 'replay_start' | 'replay_end' | 'bump'

export interface SimEvent {
  type: SimEventType
  pos: Vec3
  a: number
}

const CAPACITY = 32

export class EventQueue {
  private readonly items: SimEvent[] = []
  private head = 0
  private count = 0

  constructor() {
    for (let i = 0; i < CAPACITY; i++) this.items.push({ type: 'lap', pos: new Vec3(), a: 0 })
  }

  push(type: SimEventType, pos: Vec3 | null, a = 0): void {
    const e = this.items[(this.head + this.count) % CAPACITY]
    e.type = type
    if (pos) e.pos.copy(pos)
    else e.pos.set(0, 0, 0)
    e.a = a
    if (this.count < CAPACITY) this.count++
    else this.head = (this.head + 1) % CAPACITY
  }

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
