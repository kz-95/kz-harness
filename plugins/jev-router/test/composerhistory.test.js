// Composer input history: the arrows walk the session's own user messages. The DOM half (reading the
// caret and writing the draft through the composer's setDraft action) needs a browser, so only the
// decision logic is covered here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// client.js is a classic browser script - window.__ModuleLoader__.load({ id, factory }) - not an ES
// module, so node cannot import it. Run the real file body as a function of `window`, then hand its
// factory a fake `react` and read the pure logic the plugin exposes for tests as `__test`.
function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { userInputs, historyStep, arrowIntent } = loadPlugin().__test

test('history: only user message text is kept, in order, and empty messages are dropped', () => {
  const nodes = [
    { kind: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { kind: 'user', content: [{ type: 'text', text: 'first' }] },
    { kind: 'context', content: [{ type: 'text', text: 'system' }] },
    { kind: 'user', content: [{ type: 'text', text: 'line a' }, { type: 'image' }, { type: 'text', text: 'line b' }] },
    { kind: 'user', content: [{ type: 'image' }] },
    { kind: 'user', content: [{ type: 'text', text: '   ' }] },
  ]
  assert.deepEqual(userInputs(nodes), ['first', 'line a\nline b'])
})

test('history: the newest 50 inputs are kept when the session is longer', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ kind: 'user', content: [{ type: 'text', text: `m${i}` }] }))
  const kept = userInputs(nodes)
  assert.equal(kept.length, 50)
  assert.equal(kept[0], 'm10', 'the oldest beyond the cap are dropped')
  assert.equal(kept.at(-1), 'm59')
})

test('history: ArrowUp recalls the newest input, then walks older, and never wraps', () => {
  const entries = ['old', 'mid', 'new']
  // From the person's own draft: capture it and show the newest entry.
  const first = historyStep(entries, null, 'draft in progress', 'up')
  assert.deepEqual(first, { index: 2, draft: 'draft in progress', text: 'new' })
  // Older, keeping the captured draft.
  assert.deepEqual(historyStep(entries, 2, 'draft in progress', 'up'), { index: 1, draft: 'draft in progress', text: 'mid' })
  assert.deepEqual(historyStep(entries, 1, 'draft in progress', 'up'), { index: 0, draft: 'draft in progress', text: 'old' })
  // At the oldest there is nowhere older: the key is left to the editor.
  assert.equal(historyStep(entries, 0, 'draft in progress', 'up'), null)
})

test('history: ArrowDown walks forward and past the newest restores the draft in progress', () => {
  const entries = ['old', 'mid', 'new']
  assert.deepEqual(historyStep(entries, 0, 'draft in progress', 'down'), { index: 1, draft: 'draft in progress', text: 'mid' })
  assert.deepEqual(historyStep(entries, 1, 'draft in progress', 'down'), { index: 2, draft: 'draft in progress', text: 'new' })
  // Past the newest: back to the draft that was being typed, even when it was empty.
  assert.deepEqual(historyStep(entries, 2, 'draft in progress', 'down'), { index: null, draft: null, text: 'draft in progress' })
  assert.deepEqual(historyStep(entries, 2, '', 'down'), { index: null, draft: null, text: '' })
  // Already on the draft: nothing to step forward to.
  assert.equal(historyStep(entries, null, 'whatever', 'down'), null)
})

test('history: no past inputs means the arrows do nothing', () => {
  assert.equal(historyStep([], null, 'draft', 'up'), null)
  assert.equal(historyStep([], null, 'draft', 'down'), null)
})

test('history: an arrow takes the walk only with a collapsed caret on the first/last line', () => {
  // ArrowUp: caret on the first line, so no newline before it.
  assert.equal(arrowIntent('ArrowUp', 'first line', 'second\nline', false), 'up')
  // ArrowUp with the caret mid-text on a later line is ordinary editing.
  assert.equal(arrowIntent('ArrowUp', 'first\nsec', 'ond', false), null)
  // ArrowDown: caret on the last line, so no newline after it.
  assert.equal(arrowIntent('ArrowDown', 'first\nsec', 'ond', false), 'down')
  assert.equal(arrowIntent('ArrowDown', 'first', '\nsecond', false), null)
  // A selection, or any other key, is never hijacked.
  assert.equal(arrowIntent('ArrowUp', '', '', true), null)
  assert.equal(arrowIntent('ArrowDown', '', '', true), null)
  assert.equal(arrowIntent('ArrowLeft', '', '', false), null)
  assert.equal(arrowIntent('Enter', '', '', false), null)
})
