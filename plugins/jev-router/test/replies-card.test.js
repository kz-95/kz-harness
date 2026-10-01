// Settings, Jev setup, Chat replies (docs/live-agent-view.md Feature 2): how long the start reply
// waits for the router's pick and what follows it in the chat. The choices the card offers are pure
// helpers, pinned here against what the settings route takes; the card itself is run with the Jev
// setup page in test/laya-card.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as index from '../index.js'

// client.js is a classic browser script, run here as a function of `window` (as test/workboard.test.js does).
function loadClient() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
}

test('the Chat replies rows offer a wait from none to 60 s, keep a saved wait that is not among them, and offer Milestones or Start and result only, each a value the settings route takes', () => {
  const t = loadClient()
  assert.equal(typeof t.replyWaitChoices, 'function', 'client.js offers the wait\'s choices')
  assert.deepEqual(t.replyWaitChoices(15_000), [
    ['0', 'Reply at once (no wait)'], ['5000', 'up to 5 s'], ['10000', 'up to 10 s'], ['15000', 'up to 15 s'], ['30000', 'up to 30 s'], ['60000', 'up to 60 s'],
  ])
  assert.deepEqual(t.replyWaitChoices(7500).map(([v]) => v), ['0', '5000', '7500', '10000', '15000', '30000', '60000'], 'a wait saved by hand is still shown as it is')
  assert.equal(t.replyWaitChoices(7500)[2][1], 'up to 7.5 s')
  assert.deepEqual(t.replyWaitChoices(-1).length, 6, 'nothing that is no wait')
  assert.deepEqual(t.progressChoices, [['milestones', 'Milestones'], ['off', 'Start and result only']])
  // Every choice is one the route accepts.
  assert.equal(typeof index.validChatReplies, 'function')
  for (const [v] of t.replyWaitChoices(15_000)) assert.equal(index.validChatReplies({ waitMs: Number(v) }).waitMs, Number(v))
  for (const [v] of t.progressChoices) assert.equal(index.validChatReplies({ progress: v }).progress, v)
})
