// "All transcripts": the DOM-free decisions behind the one top-bar button that opens or shuts every
// reasoning and tool transcript. The DOM half (clicking React-owned disclosure rows) needs a browser,
// so only the decision logic is covered here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { waitFor } from './wait-for.js'

// client.js is a classic browser script - window.__ModuleLoader__.load({ id, factory }) - not an ES
// module, so node cannot import it. Run the real file body as a function of `window` (which is the
// only global its top level touches), then hand its factory a fake `react` and read the pure logic
// the plugin exposes for tests as `__test`. Same realm, so plain objects and arrays compare normally.
function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { transcriptButton, transcriptClicks, actions, startTranscripts, startResultAcks } = loadPlugin().__test

test('transcripts: the label says what the next click does, and nothing to do means disabled', () => {
  // An empty conversation has no transcript rows: nothing to expand, so the button is disabled.
  assert.deepEqual(transcriptButton(0, 0), { expanded: false, disabled: true, label: 'Expand all transcripts' })
  // Any row still shut -> "expand"; every row open -> "collapse".
  assert.deepEqual(transcriptButton(2, 2), { expanded: false, disabled: false, label: 'Expand all transcripts' })
  assert.deepEqual(transcriptButton(1, 2), { expanded: false, disabled: false, label: 'Expand all transcripts' })
  assert.deepEqual(transcriptButton(0, 2), { expanded: true, disabled: false, label: 'Collapse all transcripts' })
})

test('transcripts: a click on the button clicks every row that disagrees with it', () => {
  const rows = [{ expanded: false, seen: false }, { expanded: true, seen: false }, { expanded: false, seen: true }]
  // Opening: both shut rows, including the one the person shut by hand (they asked for it).
  assert.deepEqual(transcriptClicks(rows, true).map((r) => r.expanded), [false, false])
  // Shutting: the one open row only.
  assert.deepEqual(transcriptClicks(rows, false).map((r) => r.expanded), [true])
  assert.deepEqual(transcriptClicks([], true), [])
})

test('transcripts: streamed-in rows follow an expanded preference and never fight the person', () => {
  const rows = [
    { expanded: false, seen: false }, // arrived just now, still shut -> open it
    { expanded: true, seen: false }, // already open -> nothing to do
    { expanded: false, seen: true }, // shut by hand after a pass -> leave it alone
  ]
  assert.deepEqual(transcriptClicks(rows, true, true).map((r) => r.expanded), [false])
  // A following pass never shuts anything, even with the preference off.
  assert.deepEqual(transcriptClicks(rows, false, true), [])
})

test('transcripts: one rebindable action with no default key', () => {
  const mine = actions.filter((a) => a.id === 'transcripts')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].keys, '')
  assert.equal(typeof mine[0].run, 'function')
  assert.equal(typeof mine[0].label, 'string')
  // ACT and DEFAULTS are keyed by id, so an id may only appear once.
  assert.equal(new Set(actions.map((a) => a.id)).size, actions.length)
})

// Both follow-up passes are coalesced on a timer, never on an animation frame: a hidden or minimised
// window runs no frames at all, so a frame-gated pass would silently never land while the app sits in
// the background. The stub below is a frame scheduler that never calls back; the pass must still run.
// The toggle hints have their own version of this test for the shared helper; these two prove the
// transcripts pass and the result acknowledger are actually wired to it.
function stub(name, value) {
  const saved = globalThis[name]
  globalThis[name] = value
  return () => { if (saved === undefined) delete globalThis[name]; else globalThis[name] = saved }
}

const noFrames = () => [stub('requestAnimationFrame', () => 0), stub('cancelAnimationFrame', () => {})]
const noObserver = () => stub('MutationObserver', class { observe() {} disconnect() {} })

test('transcripts: the follow-up pass lands on a timer while no frame is ever delivered', async () => {
  const scans = []
  const root = { querySelectorAll: (sel) => { scans.push(sel); return [] } }
  const restores = [...noFrames(), noObserver(), stub('document', { body: {}, querySelector: () => root, querySelectorAll: () => [], activeElement: null })]
  try {
    const stop = startTranscripts()
    assert.equal(scans.length, 0, 'nothing runs synchronously')
    await waitFor('the transcripts pass ran', () => scans.length, (n) => n > 0)
    assert.ok(scans.length > 0, 'the pass ran with no frame available')
    stop()
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test('result acks: the acknowledge pass lands on a timer while no frame is ever delivered', async () => {
  const scans = []
  const restores = [...noFrames(), noObserver(), stub('document', { body: {}, querySelectorAll: (sel) => { scans.push(sel); return [] } })]
  try {
    const stop = startResultAcks()
    assert.equal(scans.length, 0, 'nothing runs synchronously')
    await waitFor('the result-acknowledge pass ran', () => scans.length, (n) => n > 0)
    assert.ok(scans.length > 0, 'the pass ran with no frame available')
    stop()
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})
