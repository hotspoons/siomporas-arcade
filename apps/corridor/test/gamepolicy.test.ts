// The policy is what a program's `api.ui.*` calls land on and what both settings renderers ask.
// No DOM in it, so the whole contract — which view, what is hidden, what a typo does — is played
// here rather than discovered in a browser.
import { describe, expect, it } from 'vitest'
import { GamePolicy, HUD_PARTS, SETTING_CONTROLS, SETTING_IDS, SETTING_TABS, resolveUiMode } from '../src/game/session/gamepolicy'

describe('resolveUiMode', () => {
  it('lets the URL win over everything', () => {
    expect(resolveUiMode({ param: 'dev', stored: 'game', prod: true })).toBe('dev')
    expect(resolveUiMode({ param: 'game', stored: 'dev', prod: false })).toBe('game')
  })
  it('then the player’s remembered choice', () => {
    expect(resolveUiMode({ param: null, stored: 'dev', prod: true })).toBe('dev')
    expect(resolveUiMode({ param: null, stored: 'game', prod: false })).toBe('game')
  })
  it('and otherwise a production build is a game and the dev server is a workbench', () => {
    expect(resolveUiMode({ param: null, stored: null, prod: true })).toBe('game')
    expect(resolveUiMode({ param: null, stored: null, prod: false })).toBe('dev')
    // junk in the URL is not a mode
    expect(resolveUiMode({ param: 'banana', stored: null, prod: true })).toBe('game')
  })
})

describe('GamePolicy', () => {
  it('starts with everything allowed (Rich: "default these to on")', () => {
    const p = new GamePolicy()
    expect(p.developer).toBe(true)
    expect(p.teleport).toBe(true)
    expect(p.transport).toBe(true)
    for (const id of SETTING_IDS) expect(p.allows(id)).toBe(true)
    for (const part of Object.keys(HUD_PARTS)) expect(p.hud[part as keyof typeof HUD_PARTS]).toBe(true)
  })

  it('hides a control by id, and a whole tab takes its controls with it', () => {
    const p = new GamePolicy()
    p.hide('display.theme')
    expect(p.allows('display.theme')).toBe(false)
    expect(p.allows('display.season')).toBe(true)
    expect(p.allows('display')).toBe(true)
    p.hide('audio')
    expect(p.allows('audio')).toBe(false)
    expect(p.allows('audio.master')).toBe(false)
    expect(p.allows('audio.mute')).toBe(false)
    p.show('audio')
    expect(p.allows('audio.master')).toBe(true)
    expect(p.hiddenIds()).toEqual(['display.theme'])
  })

  it('refuses an id that is not on the closed list and says so, rather than hiding nothing quietly', () => {
    const p = new GamePolicy()
    p.hide('display.thme', 'nonsense')
    expect(p.unknown).toEqual(['display.thme', 'nonsense'])
    expect(p.hiddenIds()).toEqual([])
    // every control id names a tab that exists
    for (const id of Object.keys(SETTING_CONTROLS)) expect(Object.keys(SETTING_TABS)).toContain(id.split('.')[0])
  })

  it('takes the freedoms away one at a time and gives them all back on reset', () => {
    const p = new GamePolicy()
    let changes = 0
    p.onChange = () => changes++
    p.allow('developer', false)
    p.allow('teleport', false)
    p.setHud('gear', false)
    p.hide('game.tuning')
    expect(p.developer).toBe(false)
    expect(p.teleport).toBe(false)
    expect(p.transport).toBe(true)
    expect(p.hud.gear).toBe(false)
    expect(p.allows('game.tuning')).toBe(false)
    expect(changes).toBe(4)
    p.reset()
    expect(p.developer).toBe(true)
    expect(p.teleport).toBe(true)
    expect(p.hud.gear).toBe(true)
    expect(p.allows('game.tuning')).toBe(true)
    expect(p.hiddenIds()).toEqual([])
  })
})
