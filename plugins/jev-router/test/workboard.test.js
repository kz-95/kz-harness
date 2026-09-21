// The work board header: the live indicator that opens the Overview tab. The button and the
// panel helpers need a browser, so the decisions the header makes are extracted into pure
// functions and pinned here - including the contract that a live count counts live tasks only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

const { liveTasks, liveSummary, workBoardHeader } = loadPlugin().__test

/** One canonical task record as tasks.js view(t) hands it to the list. */
const task = (over = {}) => ({
  jobId: 'job-1', sessionId: 's1', state: 'running',
  taskName: 'Fix the parser', taskText: 'Fix the parser', task: 'Fix the parser',
  startedAt: 1000, finishedAt: null, durationMs: null, deliveryState: 'pending',
  ...over,
})

test('work board header: the live count counts live tasks, never a finished one', () => {
  const rows = [
    task({ jobId: 'a', state: 'running' }),
    task({ jobId: 'b', state: 'completed', deliveryState: 'delivered' }),
    task({ jobId: 'c', state: 'queued' }),
    task({ jobId: 'd', state: 'failed' }),
    task({ jobId: 'e', state: 'verifying' }),
  ]
  // The regression this fixes: a header that counted every task would say "completed" work is
  // still happening, and would name finished tasks as if they were live.
  assert.deepEqual(liveTasks(rows).map((t) => t.jobId), ['a', 'c', 'e'])
  assert.equal(liveTasks([]).length, 0)
  assert.equal(liveTasks(undefined).length, 0, 'a list that has not loaded yet is not live work')
})

test('work board header: the live line names each live state and the live tasks', () => {
  const live = [
    task({ jobId: 'a', state: 'running', taskName: 'checking jev auto' }),
    task({ jobId: 'b', state: 'running', taskName: 'rebuild cache.ts' }),
    task({ jobId: 'c', state: 'queued', taskName: 'write the docs' }),
  ]
  assert.equal(liveSummary(live, 0), '2 running, 1 queued - checking jev auto, rebuild cache.ts, write the docs')
  // Nothing live is nothing to say, so the header falls back to the completed summary.
  assert.equal(liveSummary([], 0), '')
})

test('work board header: active phases read before waiting ones', () => {
  const live = [task({ jobId: 'a', state: 'queued', taskName: 'q' }), task({ jobId: 'b', state: 'verifying', taskName: 'v' })]
  assert.equal(liveSummary(live, 0), '1 verifying, 1 queued - q, v')
})

test('work board header: a thin record still names itself, and a blank one is dropped', () => {
  assert.equal(liveSummary([task({ state: 'running', taskName: '', taskText: '', task: 'Old task' })], 0), '1 running - Old task')
  assert.equal(liveSummary([task({ state: 'running', taskName: '', taskText: '', task: '' })], 0), '1 running')
})

test('work board header: live work is named, and the button says what it opens', () => {
  const live = workBoardHeader('1/4 completed', [task({ state: 'running', taskName: 'Fix the parser' })], 0)
  assert.equal(live.text, '1 running - Fix the parser')
  assert.equal(live.label, 'Open the session overview. In progress: 1 running - Fix the parser')
})

test('work board header: a quiet board keeps the completed summary and stays the way in', () => {
  const idle = workBoardHeader('3/3 completed, 1 stopped', [], 0)
  assert.equal(idle.text, '3/3 completed, 1 stopped')
  assert.equal(idle.label, 'Open the session overview. 3/3 completed, 1 stopped')
})

test('work board header: neither the text nor the accessible name uses a dash', () => {
  const live = workBoardHeader('1/1 completed', [task({ state: 'running', taskName: 'Fix the parser' })], 0)
  for (const s of [live.text, live.label, workBoardHeader('1/1 completed', [], 0).text]) {
    assert.doesNotMatch(s, /[\u2013\u2014]/, s)
  }
})
