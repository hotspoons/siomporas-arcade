// The asset service's own rules, where they are worth checking without a GPU.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawPrompt, promptFor } from './specs.mjs'

/*
 * THE EDITED PROMPT IS THE ONE THAT RUNS, AND THE ONE THAT IS RECORDED.
 *
 * Rich, 2026-09-28: "how am I supposed to see or edit the prompt? Or any of the fields." The
 * editor sends one now. Two things have to be true and neither is visible from outside: the model
 * is given the edited prompt, and the catalog entry says the edited prompt — an entry claiming the
 * recipe's prompt for an image drawn from another is a reproduction that makes a different car.
 */
const RECIPE = { prompt: 'the recipe wrote this', negative: 'the recipe negative' }

test('with nothing sent, the recipe is used and nothing is marked edited', () => {
  assert.deepEqual(promptFor(RECIPE, {}), { prompt: RECIPE.prompt, negative: RECIPE.negative, edited: false })
})

test('a hand-written prompt wins, and is marked as one', () => {
  assert.deepEqual(promptFor(RECIPE, { prompt: 'a person wrote this' }), {
    prompt: 'a person wrote this', negative: RECIPE.negative, edited: true,
  })
})

test('an empty prompt is a mistake, not an edit', () => {
  // asking flux for '' draws something arbitrary and charges for it
  for (const p of ['', '   ', '\n']) assert.equal(promptFor(RECIPE, { prompt: p }).prompt, RECIPE.prompt)
})

test('an empty NEGATIVE is a real choice', () => {
  // "draw whatever you like" is a thing to want, and it is not the same as saying nothing
  assert.deepEqual(promptFor(RECIPE, { negative: '' }), { prompt: RECIPE.prompt, negative: '', edited: true })
})

test('a non-string is ignored rather than coerced', () => {
  // it arrives from a browser over JSON; `String(null)` would prompt flux with "null"
  for (const p of [null, 42, {}, []]) assert.equal(promptFor(RECIPE, { prompt: p }).prompt, RECIPE.prompt)
  for (const n of [null, 42, {}]) assert.equal(promptFor(RECIPE, { negative: n }).negative, RECIPE.negative)
})

/*
 * A DRAW USES THE DRAFT, and never sends flux nothing. Rich, 2026-09-30: "Make this work on draft
 * prompts, no need to require a save before generate." The editor sends what is in the box; the
 * saved prompt is the fallback; and with neither there is no prompt, which the route refuses.
 */
const SAVED = { prompt: 'saved prompt', negative: 'saved negative' }

test('a draw sends the draft over the saved prompt', () => {
  assert.deepEqual(drawPrompt(SAVED, { prompt: 'the draft', negative: 'draft negative' }), { prompt: 'the draft', negative: 'draft negative' })
})

test('a draw with nothing sent uses what was saved', () => {
  assert.deepEqual(drawPrompt(SAVED, {}), SAVED)
})

test('a new item with a blank prompt and no draft has nothing to draw', () => {
  // exactly the pizza car: created with prompt '', drawn with only a seed
  for (const p of ['', '  ', undefined, null]) assert.equal(drawPrompt({ prompt: '', negative: '' }, { prompt: p, seed: 3 }).prompt, null)
})

test('an empty negative sent with a draw is a choice', () => {
  assert.equal(drawPrompt(SAVED, { prompt: 'x', negative: '' }).negative, '')
})
