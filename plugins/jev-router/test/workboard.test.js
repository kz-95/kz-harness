// The work board header: the live indicator that opens the Overview tab. The button and the
// panel helpers need a browser, so the decisions the header makes are extracted into pure
// functions and pinned here - including the contract that a live count counts live tasks only,
// and the one that reads a finished task's result notice, by its last field, as the result.
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

const t = loadPlugin().__test
const { liveTasks, liveSummary, workBoardHeader, taskRowModel, stopOneWords, stopAllWords } = t

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

test('a waiting row says what it waits for and how long it may, from the server\'s words, and its time in line', () => {
  const line = 'Waiting: another task is running in this workspace. Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review.'
  const waiting = task({
    jobId: 'q', state: 'queued', startedAt: null, queuedAt: 1000, position: 2,
    waiting: { why: 'workspace', place: 2, ahead: 0, slotsAhead: 0, overCap: false, since: 1000, placeText: '2nd in line', reason: 'Waiting: another task is running in this workspace', estimate: { lowMs: 240_000, highMs: 480_000, n: 5, text: 'Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review.' }, text: line },
  })
  const m = taskRowModel(waiting, 66_000)
  assert.equal(m.wait, line, 'the server\'s line, word for word')
  assert.equal(m.detail, m.wait, 'the Background tab and the Overview say the same')
  assert.equal(m.waited, '1 min 5 s', 'in line since it was queued, not "starting"')
  assert.equal(m.stopWord, 'Remove')
  assert.match(m.meta, /^2nd in line · /)
  assert.equal(m.runNext, false, 'nothing is in front of it in its own line: the running task is not')
  assert.doesNotMatch(m.meta, /\d (?:ms|s)\b/, 'the meta line still carries no running time for it')
  // First for a slot is not "next up" when another workspace's task goes first.
  const slot = taskRowModel({ ...waiting, waiting: { ...waiting.waiting, why: 'cap', place: 1, slot: 2, placeText: '2nd for a free slot', estimate: null, text: 'Waiting for a free slot: the resource budget caps how many tasks run at once.' } }, 66_000)
  assert.match(slot.meta, /^2nd for a free slot · /)
  assert.equal(slot.wait, 'Waiting for a free slot: the resource budget caps how many tasks run at once.')
  // Behind another waiting task in its line: Run next moves it in front.
  assert.equal(taskRowModel({ ...waiting, waiting: { ...waiting.waiting, why: 'line', place: 2, ahead: 1 } }, 0).runNext, true)
  // A record from before the server said it keeps its own last line and its old place words.
  const old = taskRowModel({ ...waiting, waiting: undefined, progressText: 'Waiting' }, 0)
  assert.equal(old.detail, 'Waiting')
  assert.match(old.meta, /^2nd in line/)
  // A running row is stopped, and has no wait line.
  const running = taskRowModel(task({ state: 'running' }), 5000)
  assert.deepEqual([running.stopWord, running.wait, running.waited, running.runNext], ['Stop', '', '', false])
})

test('one task is stopped or removed in words that fit it, and Stop all counts running and waiting apart', () => {
  assert.equal(typeof stopOneWords, 'function', 'the one-task confirmation has its words')
  assert.equal(typeof stopAllWords, 'function', 'and Stop all its own')
  assert.deepEqual(stopOneWords({ title: 'write the docs', stopWord: 'Remove' }), {
    title: 'Remove this task from the line?',
    body: '"write the docs" has not started, so nothing in the workspace has changed. It leaves the line, and its message in the chat says it was removed before it started.',
    confirmLabel: 'Remove task',
  })
  assert.deepEqual(stopOneWords({ title: 'fix it', stopWord: 'Stop' }), { title: 'Stop this task?', body: 'Stop "fix it"? Work it already did stays in the workspace.', confirmLabel: 'Stop task' })
  const run = task({ jobId: 'a', state: 'running', taskName: 'sample' })
  const q1 = task({ jobId: 'b', state: 'queued', taskName: 'research', startedAt: null })
  const q2 = task({ jobId: 'c', state: 'queued', taskName: 'ok go', startedAt: null })
  assert.deepEqual(stopAllWords([run, q1, q2], 0), {
    label: 'Stop all 3 tasks in this session: 1 running, 2 waiting',
    title: 'Stop all 3 tasks?',
    body: '1 running task stops now and 2 waiting tasks leave the line: sample, research, ok go. Work already done stays in the workspace.',
    confirmLabel: 'Stop 3',
  })
  assert.equal(stopAllWords([run], 0).body, '1 running task in this session stops now: sample. Work already done stays in the workspace.')
  assert.equal(stopAllWords([q1], 0).body, '1 waiting task leaves the line: research. It has not started, so nothing in the workspace changes.')
  // A task back in the line after its read pass did start: it read, locked, and changed nothing.
  const back = { ...q2, startedAt: 1000, requeuedAt: 5000 }
  assert.equal(stopAllWords([back], 0).body, `1 waiting task leaves the line: ${taskRowModel(back, 0).title}. It ran only a read pass, locked against writing, so nothing in the workspace changes.`)
  assert.match(stopAllWords([q1, back], 0).body, /\. One of them ran only a read pass, locked against writing, and the rest have not started, so nothing in the workspace changes\.$/)
  assert.match(stopAllWords([{ ...back, readBreach: { changed: ['src/a.ts'], agents: ['claude'] } }, q1], 0).body, /\. Files changed in the repository of one of them while its read pass read, so its lock may not have held; nothing more of them runs\.$/)
  for (const w of [stopAllWords([run, q1, q2], 0), stopOneWords({ title: 't', stopWord: 'Remove' })]) assert.doesNotMatch(Object.values(w).join(' '), /[\u2013\u2014]|undefined/)
})

test('resultIdOf reads the last field: \'jev-3 · a · b · Completed\' is jev-3 and resultOf\'s name is \'a · b\'; \'jev-3 · Fix · Running\' and \'jev-3 started: Codex\' are null', () => {
  assert.equal(typeof t.resultOf, 'function', 'a result notice\'s summary is read for its task name too')
  const { resultIdOf, resultOf } = t
  assert.equal(resultIdOf('jev-3 · a · b · Completed'), 'jev-3')
  assert.deepEqual(resultOf('jev-3 · a · b · Completed'), { id: 'jev-3', name: 'a · b' }, 'a task name may hold the separator')
  assert.deepEqual(resultOf('jev-12·Tidy up·Failed'), { id: 'jev-12', name: 'Tidy up' })
  // Only a finished task's notice is a result: a live state, or a progress notice with no such last field, is not.
  for (const summary of ['jev-3 · Fix · Running', 'jev-3 started: Codex', 'jev-3 · Fix · Completed later', 'jev-3 · Completed']) {
    assert.equal(resultIdOf(summary), null, summary)
    assert.equal(resultOf(summary), null, summary)
  }
  // The label of every finished state ends a result, word for word as the server says it (adapter.js
  // TASK_LABELS, which delivery.js puts last), and no other state's does.
  for (const state of TASK_STATES) {
    assert.equal(resultIdOf(`jev-5 · Fix the parser · ${TASK_LABELS[state]}`), TERMINAL_STATES.includes(state) ? 'jev-5' : null, state)
  }
})
