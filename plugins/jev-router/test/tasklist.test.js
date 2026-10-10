// The task list row: what a task record turns into on screen. The DOM half (the <details> row,
// the Clear/Stop buttons) needs a browser, so the decisions the row makes are extracted into a
// pure function and pinned here - including the contract that the list and the chat never
// disagree about what a state is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TASK_LABELS } from '../adapter.js'
import { TASK_STATES, TERMINAL_STATES } from '../tasks.js'

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

const { taskRowModel, taskLabels, resultIdOf, awaitingDelivery, resultAnnouncement } = loadPlugin().__test

/** One canonical task record as tasks.js view(t) hands it to the list. */
const task = (over = {}) => ({
  jobId: 'job-1', sessionId: 's1', workspace: 'C:\\Harness', task: 'Fix the parser',
  taskName: 'Fix the parser', taskText: 'Fix the parser', capability: 'code', executor: null,
  state: 'running', status: 'running', phase: 'running', position: 0, queuePosition: 0,
  mode: 'auto', agent: 'claude', model: null, effort: null,
  queuedAt: 0, startedAt: 1000, finishedAt: null, terminalReason: null, finalStatus: null,
  progressText: 'Running claude (primary)…', lastLine: 'Running claude (primary)…',
  reportAvailable: false, runId: 'run-1', deliveryState: 'pending', deliveredAt: null,
  seq: 2, durationMs: null,
  ...over,
})

test('task list: the client state labels are the server labels, word for word', () => {
  // The list and the chat must never disagree about what a state is called, so the client's own
  // copy of the map is the contract: change it here and the row drifts from the delivered message.
  assert.deepEqual({ ...taskLabels }, { ...TASK_LABELS })
  assert.deepEqual(Object.keys(taskLabels).sort(), Object.keys(TASK_LABELS).sort())
  // Every state the server can emit has a label; a state with no label would print its own id.
  for (const state of TASK_STATES) assert.equal(typeof taskLabels[state], 'string', state)
})

test('task list: Clear and Stop follow the server states, not the old done/failed/stopped trio', () => {
  for (const state of TASK_STATES) {
    const done = TERMINAL_STATES.includes(state)
    const m = taskRowModel(task({ state, finishedAt: done ? 5000 : null, durationMs: done ? 4000 : null }), 6000)
    assert.equal(m.canClear, done, `Clear for ${state}`)
    assert.equal(m.canStop, !done, `Stop for ${state}`)
  }
  // The regression this fixes: a completed task was never 'done', so it offered no Clear at all.
  for (const state of ['completed', 'failed', 'stopped', 'needs_human', 'paused_limit']) {
    assert.equal(taskRowModel(task({ state }), 6000).canClear, true, state)
  }
  for (const state of ['queued', 'routing', 'running', 'verifying', 'reviewing']) {
    assert.equal(taskRowModel(task({ state }), 6000).canStop, true, state)
  }
})

test('task list: every state has an icon and a visible word for it', () => {
  const icon = {}
  for (const state of TASK_STATES) {
    const m = taskRowModel(task({ state }), 6000)
    assert.equal(m.label, TASK_LABELS[state], state)
    assert.equal(typeof m.icon, 'string', state)
    icon[state] = m.icon
  }
  // A spinner is drawn in CSS for the working states; the rest carry a glyph of their own.
  for (const state of ['queued', 'completed', 'failed', 'stopped', 'needs_human', 'paused_limit']) {
    assert.ok(icon[state].length, `${state} needs a glyph the stylesheet does not draw`)
  }
  assert.equal(icon.completed, '✓')
  assert.equal(icon.failed, '✕')
  assert.equal(icon.stopped, '■')
  assert.equal(icon.needs_human, '!')
  assert.equal(icon.paused_limit, '‖')
})

test('task list: finished, delivered and unread are told apart', () => {
  // Completed reads as done at a glance: a check mark and the title struck through.
  const done = taskRowModel(task({ state: 'completed', deliveryState: 'delivered' }), 0)
  assert.equal(done.struck, true)
  assert.equal(done.unread, false)
  // Still not shown in the chat: the row says so. That covers "being rendered right now" too.
  assert.equal(taskRowModel(task({ state: 'completed', deliveryState: 'pending' }), 0).unread, true)
  assert.equal(taskRowModel(task({ state: 'completed', deliveryState: 'delivering' }), 0).unread, true)
  // Nothing is unread before there is a result, and nothing but completion strikes the title out.
  assert.equal(taskRowModel(task({ state: 'running', deliveryState: 'pending' }), 0).unread, false)
  for (const state of ['queued', 'routing', 'running', 'verifying', 'reviewing', 'failed', 'stopped', 'needs_human', 'paused_limit']) {
    assert.equal(taskRowModel(task({ state }), 0).struck, false, state)
  }
})

test('task list: a task that did not complete shows why, in the row itself', () => {
  assert.equal(taskRowModel(task({ state: 'failed', terminalReason: 'tests failed: 3 failing' }), 0).reason, 'tests failed: 3 failing')
  assert.equal(taskRowModel(task({ state: 'stopped', terminalReason: 'stopped by the user' }), 0).reason, 'stopped by the user')
  assert.equal(taskRowModel(task({ state: 'needs_human', terminalReason: 'Approve the migration before it runs?' }), 0).reason, 'Approve the migration before it runs?')
  assert.equal(taskRowModel(task({ state: 'paused_limit', terminalReason: 'all agents at their limits; resets 14:05' }), 0).reason, 'all agents at their limits; resets 14:05')
  // A completed task has nothing to explain, and a live one has not ended yet.
  assert.equal(taskRowModel(task({ state: 'completed', terminalReason: 'whatever' }), 0).reason, '')
  assert.equal(taskRowModel(task({ state: 'running', terminalReason: null }), 0).reason, '')
  // An older record with no reason recorded still says the last thing that happened.
  assert.equal(taskRowModel(task({ state: 'stopped', terminalReason: null, progressText: 'Stopped: the app was closed while this task was running' }), 0).reason,
    'Stopped: the app was closed while this task was running')
})

test('task list: the row names the task and its stable job id', () => {
  const m = taskRowModel(task({ jobId: 'job-ab12', taskName: 'Fix the parser' }), 0)
  assert.equal(m.title, 'Fix the parser')
  assert.equal(m.jobId, 'job-ab12')
  // A record that only ever had the raw text still names itself.
  assert.equal(taskRowModel(task({ taskName: '', taskText: '', task: 'Old task' }), 0).title, 'Old task')
})

test('task list: agent, model, phase and the wait are all in the meta line', () => {
  const q = taskRowModel(task({ state: 'queued', phase: 'queued', position: 3, startedAt: null, durationMs: null, model: null }), 6000)
  assert.match(q.meta, /3rd in line/)
  assert.match(q.meta, /claude/)
  assert.match(q.meta, /Harness/) // the workspace folder, not the whole path

  // The phase is shown when it says something the state label does not.
  const reviewing = taskRowModel(task({ state: 'running', phase: 'reviewing', agent: 'deepseek', model: 'deepseek-chat' }), 6000)
  assert.match(reviewing.meta, /Reviewing/)
  assert.match(reviewing.meta, /deepseek-chat/)
  // ... and not repeated when it is the same word twice.
  const running = taskRowModel(task({ state: 'running', phase: 'running', agent: 'claude' }), 6000)
  assert.equal(running.meta.match(/Running/g), null)
})

test('task list: elapsed while it runs, the recorded duration once it is done', () => {
  // Running: the clock is `now`, so the row ticks.
  assert.match(taskRowModel(task({ state: 'running', startedAt: 1000 }), 51000).meta, /50\.0 s/)
  // Done: the record's own duration wins over wall-clock time.
  const done = taskRowModel(task({ state: 'completed', startedAt: 1000, finishedAt: 5000, durationMs: 4000 }), 600000)
  assert.match(done.meta, /4\.0 s/)
  assert.doesNotMatch(done.meta, /599/)
  // An older record with no duration falls back to finished minus started.
  assert.match(taskRowModel(task({ state: 'failed', startedAt: 1000, finishedAt: 4000, durationMs: null }), 600000).meta, /3\.0 s/)
  // Queued work has not started, so it has no elapsed time to show.
  assert.doesNotMatch(taskRowModel(task({ state: 'queued', startedAt: null, durationMs: null }), 600000).meta, /\d (?:ms|s)\b/)
})

test('task list: the body is the latest progress line, kept word for word', () => {
  assert.equal(taskRowModel(task({ progressText: 'Running claude (primary)…' }), 0).detail, 'Running claude (primary)…')
  // lastLine alone still works (a record written by an older version).
  assert.equal(taskRowModel(task({ progressText: null, lastLine: 'Routed to codex (jev)' }), 0).detail, 'Routed to codex (jev)')
  // Nothing recorded yet: the row still has something to show, never "undefined".
  assert.equal(taskRowModel(task({ progressText: '', lastLine: null }), 0).detail, '…')
})

test('task list: a thin record still renders words, and an unknown state names itself', () => {
  // A record that has only just been created (or one written by an older version) must not put
  // "undefined" in front of anyone, and must not throw inside the render.
  const thin = taskRowModel({ jobId: 'job-1', state: 'running' }, 1000)
  for (const field of [thin.title, thin.label, thin.icon, thin.meta, thin.detail, thin.reason]) assert.equal(typeof field, 'string')
  assert.doesNotMatch([thin.title, thin.label, thin.meta, thin.detail, thin.reason].join(' '), /undefined|NaN/)
  // A state this client does not know is shown by name and treated as still-live, never dropped.
  const unknown = taskRowModel({ jobId: 'job-2', state: 'quarantined' }, 0)
  assert.equal(unknown.label, 'quarantined')
  assert.equal(unknown.icon, '·')
  assert.equal(unknown.canStop, true)
  assert.equal(unknown.canClear, false)
})

// ---------- acknowledging a rendered result ----------
// The server leads a result's notice summary with the job id so the browser can tell it the row
// is on screen. This is the only thing that marks a result read, so the parse is a contract.

test('the job id is read out of a result notice summary', () => {
  assert.equal(resultIdOf('jev-3 · Fix sidebar width · Completed'), 'jev-3')
  assert.equal(resultIdOf('jev-12·Tidy up·Failed'), 'jev-12', 'separator spacing is not load-bearing')
  assert.equal(resultIdOf('  jev-4  ·  A task  ·  Needs input  '), 'jev-4')
  assert.equal(resultIdOf('jev-9 · Fix the · thing · Completed'), 'jev-9', 'a task name may contain the separator')
})

test('a row that is not ours is never acknowledged', () => {
  const foreign = [
    '', null, undefined, 'Context injection',
    'tool-jobs · background job',           // another plugin's notice: only two fields
    '3 · numbered · Completed',             // a number is not a job id
    'JEV-1 · upper case · Completed',       // ids are lower case
    '· · ·',                                // separators and nothing else
    'a '.repeat(60) + '· x · y',            // longer than any real job id
  ]
  for (const summary of foreign) assert.equal(resultIdOf(summary), null, `${JSON.stringify(summary)} is not one of our result rows`)
})

// ---------- "queued for display" (spec 92-94) ----------
// A task that settles while an answer is streaming has its result held until the answer ends.
// That state must be visible outside the active message, and the active message must not change.

test('finished results waiting to be posted are counted', () => {
  const rows = [
    { state: 'running', deliveryState: 'pending' },      // still working: not a result yet
    { state: 'completed', deliveryState: 'delivering' }, // posted, not yet acknowledged
    { state: 'completed', deliveryState: 'pending' },    // settled, waiting to be posted
    { state: 'failed', deliveryState: 'pending' },
    { state: 'stopped', deliveryState: 'delivered' },    // acknowledged: nothing to wait for
  ]
  assert.equal(awaitingDelivery(rows), 3)
})

test('a quiet session waits for nothing', () => {
  assert.equal(awaitingDelivery([]), 0)
  assert.equal(awaitingDelivery(undefined), 0, 'a list that has not loaded yet is not a queue')
  assert.equal(awaitingDelivery([{ state: 'completed', deliveryState: 'delivered' }]), 0)
})
test('the waiting-result notice reads the same wherever it is shown', () => {
  // The button's accessible name and the screen-reader status region share this text, so what is
  // announced and what is visible cannot say different things.
  assert.equal(resultAnnouncement(0), '', 'nothing to say when nothing is waiting')
  assert.equal(resultAnnouncement(1), '1 result waiting to be posted')
  assert.equal(resultAnnouncement(3), '3 results waiting to be posted')
})
// ---------------------------------------------------------------- read-only work

test('a read task says reads only in its meta, waiting and running; a task that writes does not', () => {
  const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
  const waiting = taskRowModel(task({
    state: 'queued', phase: 'queued', agent: null, startedAt: null, position: 1, access: 'read', readVerdict: verdict, workspace: 'C:\\work\\jev-router-test',
    waiting: { why: 'cap', place: 1, ahead: 0, slot: 1, placeText: 'next for a free slot', text: 'Waiting for a free slot: the resource budget caps how many tasks run at once.', since: 0 },
  }), 5000)
  assert.equal(waiting.meta, 'next for a free slot · Jev picks · reads only · jev-router-test')
  const running = taskRowModel(task({ state: 'running', agent: 'claude', model: 'opus', effort: 'medium', access: 'read', readVerdict: verdict, workspace: 'C:\\work\\jev-router-test', startedAt: 1000 }), 42_000)
  assert.equal(running.meta, 'claude · opus · medium · reads only · jev-router-test · 41.0 s')
  const writer = taskRowModel(task({ state: 'running', agent: 'claude', access: 'write', readVerdict: { ...verdict, p: 0.2, reads: false }, workspace: 'C:\\work\\jev-router-test', startedAt: 1000 }), 42_000)
  assert.doesNotMatch(writer.meta, /reads only/)
})

test('a task waiting again after a read pass shows no running time in its meta', () => {
  const m = taskRowModel(task({
    state: 'queued', phase: 'queued', agent: null, model: null, access: 'write', accessWhy: 'claude said it needs to change files', position: 2,
    startedAt: 1000, requeuedAt: 40_000, workspace: 'C:\\work\\jev-router-test',
    waiting: { why: 'workspace', place: 2, ahead: 0, placeText: '2nd in line', text: 'Waiting: another task is running in this workspace.', since: 40_000 },
  }), 100_000)
  assert.equal(m.meta, '2nd in line · Jev picks · jev-router-test', 'no time that reads as running')
  assert.equal(m.waited, '1 min', 'its time in line counts from when it rejoined')
})

test('Remove on a task back in line after its read pass says it ran only a read pass, as its message will', () => {
  const { stopOneWords } = loadPlugin().__test
  const m = taskRowModel(task({ state: 'queued', phase: 'queued', agent: null, startedAt: 1000, requeuedAt: 40_000, taskName: 'How does the parser work', waiting: { why: 'workspace', place: 2, ahead: 0, placeText: '2nd in line', text: 'Waiting.', since: 40_000 } }), 50_000)
  assert.equal(m.stopWord, 'Remove')
  assert.equal(stopOneWords(m).body, '"How does the parser work" ran only a read pass, locked against writing, so nothing in the workspace has changed. It leaves the line, and its message in the chat says it was removed after its read pass.')
  const fresh = taskRowModel(task({ state: 'queued', phase: 'queued', agent: null, startedAt: null, taskName: 'Fix it', waiting: { why: 'workspace', place: 2, ahead: 0, placeText: '2nd in line', text: 'Waiting.', since: 0 } }), 50_000)
  assert.match(stopOneWords(fresh).body, /has not started, so nothing in the workspace has changed/)
})

test('a duration reads as a person reads one, and a minute is never shown as 60 seconds', () => {
  const m = (ms) => taskRowModel(task({ state: 'completed', startedAt: 1000, finishedAt: 1000 + ms, durationMs: ms }), 1000 + ms).meta.split(' · ').at(-1)
  assert.deepEqual([450, 41_000, 59_949, 59_960, 60_000, 150_000, 3_599_600, 3_900_000].map(m), ['450 ms', '41.0 s', '59.9 s', '1 min', '1 min', '2 min 30 s', '1 h', '1 h 5 min'])
})

test('Remove on a task whose read pass saw files change says so rather than that nothing changed', () => {
  const { stopOneWords } = loadPlugin().__test
  const m = taskRowModel(task({ state: 'queued', phase: 'queued', agent: null, startedAt: 1000, requeuedAt: 40_000, readBreach: { changed: ['src/a.ts'], agents: ['claude'] }, taskName: 'How does the parser work', waiting: { why: 'workspace', place: 2, ahead: 0, placeText: '2nd in line', text: 'Waiting.', since: 40_000 } }), 50_000)
  assert.equal(stopOneWords(m).body, '"How does the parser work" ran a read pass, and src/a.ts changed in this repository while it read, so its lock may not have held. It leaves the line, and nothing more of it runs.')
})

test('the Tasks tab offers Send now and Steer beside Run next and Remove on a waiting row, Steer beside Stop on a running one, and only Clear on a finished one', () => {
  const p = loadPlugin().__test
  assert.equal(typeof p.queueActions, 'function', 'the rows offer Send now and Steer')
  const controls = { sendNow: 'slot', holder: null, heldBy: null, ahead: ['jev-3'], chatAhead: 0, held: 1, max: 1, local: null, forcedLocal: false }
  const rows = [
    task({ jobId: 'jev-4', key: 'k4', state: 'queued', startedAt: null, position: 3, waiting: { why: 'line', ahead: 1, text: 'Waiting: an earlier task in this workspace is waiting for a free slot first.' }, controls }),
    task({ jobId: 'jev-2', key: 'k2', state: 'running' }),
    task({ jobId: 'jev-1', key: 'k1', state: 'completed', finishedAt: 5000, deliveryState: 'delivered' }),
  ]
  const items = p.taskItems({ sessionId: 's1', runs: [], jobs: [], entries: [], tasks: rows, open: new Set(), now: 6000 })
  const by = Object.fromEntries(items.map((it) => [it.kind, it]))
  const offered = (it) => [...it.queue.map((q) => p.queueLabel(q.action, q.task)), ...(it.runNext ? ['Run next'] : []), ...(it.stop ? [it.stop.word] : []), ...(it.clear ? ['Clear'] : [])]
  assert.deepEqual(offered(by['jev-4']), ['Send jev-4 now', 'Steer jev-4', 'Run next', 'Remove'])
  assert.deepEqual(offered(by['jev-2']), ['Steer jev-2', 'Stop'])
  assert.deepEqual(offered(by['jev-1']), ['Clear'])
  assert.equal(by['jev-4'].queue[0].task.key, 'k4', 'each opens its dialog about its own task')
})
