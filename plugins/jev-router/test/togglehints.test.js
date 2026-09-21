// Sidebar toggle hotkey hints: which shipped buttons get a hint, and which action each maps to.
// Only the label -> action mapping is DOM free, so that is covered here; the attribute writes need
// a browser and are checked live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { waitFor } from './wait-for.js'

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

const { toggleActionOf, coalesce } = loadPlugin().__test

test('toggle hints: every shipped sidebar label maps, both words for a shut sidebar included', () => {
  assert.equal(toggleActionOf('Collapse sidebar'), 'left-sidebar')
  assert.equal(toggleActionOf('Open sidebar'), 'left-sidebar')
  assert.equal(toggleActionOf('Expand sidebar'), 'left-sidebar')
  assert.equal(toggleActionOf('collapse sidebar'), 'left-sidebar')
  assert.equal(toggleActionOf('Collapse right sidebar'), 'right-sidebar')
  assert.equal(toggleActionOf('Open right sidebar'), 'right-sidebar')
  assert.equal(toggleActionOf('Expand right sidebar'), 'right-sidebar')
})

test('toggle hints: every other button, including KzH\'s own, is left alone', () => {
  for (const label of ['Hide right sidebar', 'Show right sidebar', 'Collapse right sidebar now', 'More', 'New session', 'Settings', 'Collapse', '', null, undefined]) {
    assert.equal(toggleActionOf(label), null, JSON.stringify(label))
  }
})

// The hints are written by a pass driven by document mutations, and the shipped toggles are rendered
// long after the plugin loads. The pass is coalesced on a timer, never on an animation frame: a
// hidden or minimised window runs no frames at all, so a frame-gated pass would never land on the
// toggles and the combos would stay invisible with the app in the background.
test('toggle hints: a burst of DOM changes becomes exactly one pass, and it can be cancelled', async () => {
  const saved = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0 // a frame scheduler that never calls back
  try {
    let runs = 0
    const pass = coalesce(() => { runs++ })
    pass.schedule(); pass.schedule(); pass.schedule()
    assert.equal(runs, 0, 'nothing runs synchronously')
    await waitFor('the coalesced pass ran', () => runs, (n) => n >= 1)
    assert.equal(runs, 1, 'the whole burst is one pass, with no frame available')
    pass.schedule()
    pass.cancel()
    // Waiting for absence cannot be a poll: there is no signal when a cancelled pass does not run,
    // so a real delay is the only way to show the cancelled timer never fires.
    await new Promise((done) => setTimeout(done, 5))
    assert.equal(runs, 1, 'a cancelled pass never runs')
  } finally {
    if (saved === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = saved
  }
})
