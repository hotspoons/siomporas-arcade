// What a stopped run says about why it stopped.
//
// Rich's t-section bake ran for twelve minutes and reported `exited null`, which is what the
// runner says when a process was KILLED: Node hands `close(code, signal)` a null code and the
// signal, and the signal was being discarded. It had been SIGKILLed — this box's cgroup had
// recorded 46 OOM kills, and one 213 MiB LAZ tile peaks at 2.44 GB against the 3 GB that were
// free. Twelve minutes of log and not one word about memory.
//
// So the wording is the thing under test. It runs the real reason-builder over the cases Node can
// actually produce.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The runner's own reason-builder, lifted out of `runs.mjs` by reading it.
 *
 * READ FROM THE SOURCE rather than copied here, because a copy of a message is a message that
 * drifts: the test would keep passing about wording the service no longer uses.
 */
const source = readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8')
const body = source.slice(source.indexOf("const why = signal === 'SIGKILL'"))
const expr = body.slice(0, body.indexOf('\n      void this.#finish'))
const reason = new Function('code', 'signal', `${expr}\n return why`)

test('a clean failure reports its exit code', () => {
  assert.equal(reason(1, null), 'exited 1')
  assert.equal(reason(2, null), 'exited 2')
})

test('a SIGKILL says what it was, in a few words', () => {
  // nothing sends SIGKILL to a bake except the kernel running out of memory; a cancel sends
  // SIGTERM. The reasoning belongs in the comment, not in the line somebody reads.
  const why = reason(null, 'SIGKILL')
  assert.equal(why, 'killed — out of memory')
})

test('a cancel is not reported as a crash', () => {
  const why = reason(null, 'SIGTERM')
  assert.equal(why, 'stopped')
  assert.ok(!/out of memory/.test(why), why)
})

test('no reason is longer than a glance', () => {
  // a failure line is read at a glance in a list of runs; an explanation of why the guess is a
  // fair one belongs in the source
  for (const [code, signal] of [[null, 'SIGKILL'], [null, 'SIGTERM'], [null, 'SIGSEGV'], [1, null]]) {
    assert.ok(reason(code, signal).length <= 32, `${reason(code, signal)} is ${reason(code, signal).length} characters`)
  }
})

test('any other signal is named rather than swallowed', () => {
  assert.equal(reason(null, 'SIGSEGV'), 'killed by SIGSEGV')
  assert.equal(reason(null, 'SIGBUS'), 'killed by SIGBUS')
})

test('nothing ever reports the word null again', () => {
  // the whole bug, as one assertion: `exited null` is a report with no information in it
  for (const [code, signal] of [[null, 'SIGKILL'], [null, 'SIGTERM'], [null, 'SIGSEGV'], [1, null], [137, null]]) {
    assert.ok(!reason(code, signal).includes('null'), `${code}/${signal} → ${reason(code, signal)}`)
  }
})
