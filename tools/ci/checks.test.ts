// The services' own suites (node:test) and the linter, run by vitest so they fail on the laptop
// before they fail in CI. Each node:test FILE is its own vitest test: a red run names the file and
// carries its failing TAP block, not three thousand lines of everyone else's output.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper with no types; it is what CI's summary step uses
import { failures } from '../../scripts/ci-failures.mjs'

const root = new URL('../..', import.meta.url).pathname
const suites = ['tools/worldeditor', 'tools/assetsvc', 'scripts'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${dir}/${f}`),
)

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

const report = (out: string) => {
  const blocks = (failures(out) as string[][]).map((b) => b.join('\n'))
  return blocks.length ? blocks.join('\n\n') : out.split('\n').slice(-60).join('\n')
}

describe.concurrent('service tests (node --test)', () => {
  it('found the suites', () => {
    expect(suites.length).toBeGreaterThan(10)
  })
  for (const file of suites) {
    it(file, async () => {
      const r = await run(process.execPath, ['--test', '--test-reporter=tap', file])
      expect(r.code, report(r.out)).toBe(0)
    })
  }
})

describe('lint', () => {
  it('oxlint reports no errors', async () => {
    const r = await run(process.execPath, [join(root, 'node_modules/oxlint/bin/oxlint')])
    expect(r.code, r.out.split('\n').filter((l) => !/warning/.test(l)).slice(-60).join('\n')).toBe(0)
  })
})
