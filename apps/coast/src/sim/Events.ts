export type SimEventType = 'crash' | 'wreck' | 'bump' | 'offroad' | 'onroad' | 'checkpoint' | 'fork' | 'pass' | 'turbo' | 'gear' | 'timeout' | 'finish' | 'stage' | 'wipers' | 'lights'

export interface SimEvent {
  type: SimEventType
  /** Payload (stage index, gear, passed-car kind…). */
  a: number
}

const CAPACITY = 32

export class EventQueue {
  private readonly items: SimEvent[] = []
  private head = 0
  private count = 0

  constructor() {
    for (let i = 0; i < CAPACITY; i++) this.items.push({ type: 'pass', a: 0 })
  }

  push(type: SimEventType, a = 0): void {
    const e = this.items[(this.head + this.count) % CAPACITY]
    e.type = type
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
