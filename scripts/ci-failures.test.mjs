// The CI failure summary picks the failing blocks out of each runner's real output shape.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failures, summary } from './ci-failures.mjs'

test('node --test TAP: the failing test and its YAML block, not the passing ones', () => {
  const tap = [
    'ok 1 - fine',
    'not ok 2 - removeWorld refuses a slug that would walk out of the volume',
    '  ---',
    "  duration_ms: 2.1",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    "    'a' !== 'b'",
    '  ...',
    'ok 3 - also fine',
  ].join('\n')
  const b = failures(tap)
  assert.equal(b.length, 1)
  assert.match(b[0][0], /^not ok 2 - removeWorld refuses/)
  assert.ok(b[0].some((l) => l.includes("'a' !== 'b'")))
  assert.ok(!b[0].some((l) => l.includes('ok 3')))
})

test('python unittest: the ERROR header through its traceback', () => {
  const log = [
    'test_ok (t.T.test_ok) ... ok',
    '======================================================================',
    'ERROR: test_naip_probe (unittest.loader._FailedTest.test_naip_probe)',
    '----------------------------------------------------------------------',
    'ImportError: Failed to import test module: test_naip_probe',
    "ModuleNotFoundError: No module named 'pytest'",
    '',
    '======================================================================',
  ].join('\n')
  const b = failures(log)
  assert.equal(b.length, 1)
  assert.ok(b[0].some((l) => l.includes("No module named 'pytest'")))
})

test('tsc and vitest shapes are recognised', () => {
  assert.equal(failures('src/a.ts(3,5): error TS2322: Type x is not assignable').length, 1)
  assert.equal(failures(' FAIL  |corridor| test/a.test.ts > it adds\nAssertionError: expected 1 to be 2').length, 1)
})

test('an unrecognised failure still reports the tail of the log', () => {
  const md = summary('build', ['line one\nnpm ERR! something odd happened'])
  assert.match(md, /No test failure recognised/)
  assert.match(md, /npm ERR! something odd happened/)
})
