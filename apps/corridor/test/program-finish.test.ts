// A run ends with a result, and the finish screen draws it.
//
// Rich, 2026-10-10: "when the mission is complete we should have a finish screen that defaults to
// showing the hero car or main character depending on game mode, along with a representation of
// winnings (cash for our simple game), and an option to restart or exit to menu. This should all
// have API hooks." These hold the hooks: the score as winnings (a currency, a breakdown), the
// ending with its headline, stats and turntable, who hears it and in what order, when the app's
// screen is asked for and when it is not — and that a dry run with no host answers harmlessly.
import { describe, expect, it } from 'vitest'
import { ActorWorld } from '../src/game/actors/actorworld'
import { GameRun, defineGame, type FinishResult, type GameDef, type Outcome, type ProgramHost } from '../src/game/session/program'

function host() {
  const finished: { outcome: Outcome; result?: FinishResult }[] = []
  const said: string[] = []
  const h: ProgramHost = {
    actors: new ActorWorld(),
    hide: () => {},
    transport: () => {},
    preset: () => {},
    say: (t) => { said.push(t) },
    playerAt: () => ({ x: 0, y: 0, z: 0 }),
    playerSpeed: () => 0,
    onFinish: (outcome, result) => { finished.push({ outcome, result }) },
  }
  return { h, finished, said }
}

async function play(def: GameDef, h: ProgramHost, seconds = 0.1): Promise<GameRun> {
  const run = new GameRun(h, def)
  await run.start()
  for (let t = 0; t < seconds; t += 1 / 60) run.tick(1 / 60)
  return run
}

describe('the score is the winnings', () => {
  it('pays into labelled lines, counts them, and keeps the total', async () => {
    const { h } = host()
    let lines: unknown = null
    const run = await play(defineGame({
      setup: (api) => {
        api.score.currency('$')
        for (let i = 0; i < 12; i++) api.score.add(20, 'Hits')
        api.score.add(100, 'Hits')
        api.score.add(500, 'Time bonus')
        api.award(7)
        lines = api.score.lines()
      },
    }), h)
    expect(run.score).toBe(12 * 20 + 100 + 500 + 7)
    expect(run.facts().score).toBe(847)
    expect(run.currency).toBe('$')
    expect(lines).toEqual([{ label: 'Hits', amount: 340, count: 13 }, { label: 'Time bonus', amount: 500, count: 1 }])
  })

  it('set makes a line exactly so, and with no label makes the total exactly so', async () => {
    const { h } = host()
    const seen: number[] = []
    await play(defineGame({
      setup: (api) => {
        api.score.add(50, 'Tips')
        seen.push(api.score.set(80, 'Tips'))
        seen.push(api.score.set(200))
        seen.push(api.score.get())
        seen.push(api.score.lines()[0].amount)
      },
    }), h)
    expect(seen).toEqual([80, 200, 200, 80])
  })

  it('a number that is not a number pays nothing', async () => {
    const { h } = host()
    const run = await play(defineGame({ setup: (api) => { api.score.add(10); api.score.add(NaN, 'x'); api.award(Infinity); api.score.set(NaN) } }), h)
    expect(run.score).toBe(10)
    expect(run.facts().score).toBe(10)
  })
})

describe('finishing', () => {
  it('finish() carries the headline, the winnings, the stats and the turntable to the host and to on(finish)', async () => {
    const { h, finished } = host()
    const order: string[] = []
    let heard: FinishResult | null = null
    const run = await play(defineGame({
      setup: (api) => {
        api.score.currency('$')
        api.score.add(1340, 'Hits')
        api.on('ends', (o) => order.push(`ends:${o}`))
        api.on('finish', (r) => { order.push(`finish:${r.outcome}`); heard = r })
        api.after(0.05, () => api.finish({ outcome: 'win', title: 'Beltway cleared', text: 'made it', stats: [{ label: 'Legs', value: '5/5' }, { label: 'bad', value: NaN }], show: 'car' }))
      },
    }), h, 0.2)
    expect(order).toEqual(['ends:win', 'finish:win'])
    expect(run.outcome).toBe('win')
    expect(finished).toHaveLength(1)
    const r = finished[0].result!
    expect(r.title).toBe('Beltway cleared')
    expect(r.text).toBe('made it')
    expect(r.winnings).toEqual({ currency: '$', total: 1340, lines: [{ label: 'Hits', amount: 1340, count: 1 }] })
    expect(r.stats).toEqual([{ label: 'Legs', value: '5/5' }])
    expect(r.show).toBe('car')
    expect(r.screen).toBe(true)
    expect(r.time).toBeGreaterThan(0.04)
    expect(heard).toEqual(r)
  })

  it('win and lose are finishes with the default headlines, and the first ending is the only one', async () => {
    const a = host()
    const won = await play(defineGame({ setup: (api) => { api.win('done'); api.lose('too late') } }), a.h)
    expect(won.outcome).toBe('win')
    expect(a.finished).toHaveLength(1)
    expect(a.finished[0].result).toMatchObject({ outcome: 'win', title: 'Mission complete', text: 'done', screen: true, show: null, winnings: null })
    const b = host()
    await play(defineGame({ setup: (api) => api.lose() }), b.h)
    expect(b.finished[0].result).toMatchObject({ outcome: 'lose', title: 'Mission failed', screen: true })
  })

  it('an abandoned run gets the screen only when the program asked for it', async () => {
    const quit = host()
    const run = await play(defineGame({ setup: () => {} }), quit.h)
    run.stop()
    expect(quit.finished[0]).toMatchObject({ outcome: 'abandoned', result: { screen: false } })
    const asked = host()
    await play(defineGame({ setup: (api) => api.finish({ outcome: 'abandoned', title: 'Called off' }) }), asked.h)
    expect(asked.finished[0].result).toMatchObject({ outcome: 'abandoned', title: 'Called off', screen: true })
  })

  it('finishScreen: false, or screen: false, leaves the drawing to the program', async () => {
    const a = host()
    let heard = false
    await play(defineGame({ finishScreen: false, setup: (api) => { api.on('finish', () => { heard = true }); api.win() } }), a.h)
    expect(a.finished[0].result?.screen).toBe(false)
    expect(heard).toBe(true)
    const b = host()
    await play(defineGame({ setup: (api) => api.finish({ screen: false }) }), b.h)
    expect(b.finished[0].result).toMatchObject({ outcome: 'win', screen: false })
  })

  it('winnings: the program’s own win field by field, null means none, and a run that scored nothing has none', async () => {
    const own = host()
    await play(defineGame({
      setup: (api) => {
        api.score.currency('$')
        api.score.add(99, 'ignored for lines')
        api.finish({ winnings: { lines: [{ label: 'Deliveries', amount: 42.5, count: 5 }, { label: 'Tips', amount: 7 }] } })
      },
    }), own.h)
    expect(own.finished[0].result?.winnings).toEqual({ currency: '$', total: 49.5, lines: [{ label: 'Deliveries', amount: 42.5, count: 5 }, { label: 'Tips', amount: 7 }] })

    const total = host()
    await play(defineGame({ setup: (api) => { api.award(30); api.finish({ winnings: { total: 1000, currency: '€' } }) } }), total.h)
    expect(total.finished[0].result?.winnings).toEqual({ currency: '€', total: 1000, lines: [] })

    const none = host()
    await play(defineGame({ setup: (api) => { api.award(30); api.finish({ winnings: null }) } }), none.h)
    expect(none.finished[0].result?.winnings).toBeNull()

    const points = host()
    await play(defineGame({ setup: (api) => { api.award(30); api.win() } }), points.h)
    expect(points.finished[0].result?.winnings).toEqual({ currency: '', total: 30, lines: [] })
  })

  it('an unknown turntable is the app’s choice, and a model id is passed through', async () => {
    const { h, finished } = host()
    await play(defineGame({ setup: (api) => api.finish({ show: 'boat' as never, model: 'mister-pizza-chef' }) }), h)
    expect(finished[0].result).toMatchObject({ show: null, model: 'mister-pizza-chef' })
  })

  it('a listener that throws stops the program, and the host still hears the ending', async () => {
    const { h, finished } = host()
    const run = await play(defineGame({ setup: (api) => { api.on('finish', () => { throw new Error('boom') }); api.win() } }), h)
    expect(run.error).toBe('boom')
    expect(finished).toHaveLength(1)
  })

  it('with no host behind it — a dry run — nothing throws', async () => {
    const h: ProgramHost = {
      actors: new ActorWorld(), hide: () => {}, transport: () => {}, preset: () => {}, say: () => {},
      playerAt: () => null, playerSpeed: () => 0,
    }
    const run = await play(defineGame({
      setup: (api) => {
        api.score.currency('$')
        api.score.add(5, 'a')
        api.finish({ winnings: { lines: 'nope' as never }, stats: 'nope' as never })
      },
    }), h)
    expect(run.error).toBeNull()
    expect(run.result).toMatchObject({ outcome: 'win', winnings: { currency: '$', total: 0, lines: [] }, stats: [] })
  })

  it('a restart is a new run: the setup again, the clock from zero, the score from nothing', async () => {
    const { h } = host()
    let setups = 0
    const def = defineGame({ setup: (api) => { setups++; api.score.add(10, 'x'); api.after(0.05, () => api.win()) } })
    const first = await play(def, h, 0.2)
    first.stop()
    const second = await play(def, h, 0.01)
    expect(setups).toBe(2)
    expect(second.facts().time).toBeLessThan(0.05)
    expect(second.score).toBe(10)
    expect(second.outcome).toBeNull()
  })
})
