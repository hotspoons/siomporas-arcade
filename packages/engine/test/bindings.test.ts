import { describe, expect, it } from 'vitest'
import { mergeMissingKeys, type KeyBindings } from '../src/input/bindings'

const DEFAULTS: KeyBindings = {
  steerLeft: ['KeyA', 'ArrowLeft'],
  pause: ['Escape', 'KeyP'],
  camera: ['KeyC'],
}

describe('mergeMissingKeys', () => {
  it('adds an alias that was introduced after the player saved their bindings', () => {
    const keys: KeyBindings = { steerLeft: ['KeyA', 'ArrowLeft'], pause: ['Escape'] }
    expect(mergeMissingKeys(keys, DEFAULTS)).toBe(2)
    expect(keys.pause).toEqual(['Escape', 'KeyP'])
    expect(keys.camera).toEqual(['KeyC'])
  })

  it('keeps keys the player chose themselves', () => {
    const keys: KeyBindings = { steerLeft: ['KeyJ'], pause: ['Escape', 'KeyP'], camera: ['KeyC'] }
    mergeMissingKeys(keys, DEFAULTS)
    expect(keys.steerLeft).toEqual(['KeyJ', 'KeyA', 'ArrowLeft'])
  })

  it('does nothing once every default is present', () => {
    const keys: KeyBindings = { steerLeft: ['KeyA', 'ArrowLeft'], pause: ['Escape', 'KeyP'], camera: ['KeyC'] }
    expect(mergeMissingKeys(keys, DEFAULTS)).toBe(0)
  })
})
