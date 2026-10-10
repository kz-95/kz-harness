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

// ---------- Send now and Steer for waiting work (docs/live-agent-view.md Feature 5) ----------

/** A waiting task as tasks.js view(t) hands it, its controls read off the line. */
const waiting = (controls, over = {}) => task({ jobId: 'jev-5', key: 'k5', state: 'queued', startedAt: null, workspace: 'C:\\work\\kz-harness', controls: { sendNow: 'slot', holder: null, heldBy: null, ahead: [], chatAhead: 0, held: 2, max: 2, local: null, forcedLocal: false, ...controls }, ...over })

test('the queue buttons per state: Send now and Steer on a waiting row, Steer on a running one, none on a finished one, each named by its task', () => {
  assert.equal(typeof t.queueActions, 'function', 'the rows offer Send now and Steer')
  const { queueActions, queueLabel } = t
  assert.deepEqual(queueActions(waiting({})), ['send', 'steer'])
  assert.deepEqual(queueActions(waiting({ sendNow: 'workspace', holder: 'jev-4' })), ['send', 'steer'], 'Send now opens the choice of what to do about the folder')
  assert.deepEqual(queueActions(waiting({ sendNow: null })), ['steer'], 'a task in no line has nothing to send now')
  assert.deepEqual(queueActions(task({ state: 'queued', startedAt: null })), ['steer'], 'nor does a row from a server with no controls')
  for (const state of ['routing', 'running', 'verifying', 'reviewing']) assert.deepEqual(queueActions(task({ state })), ['steer'], state)
  for (const state of ['completed', 'failed', 'stopped', 'needs_human', 'paused_limit']) assert.deepEqual(queueActions(task({ state })), [], state)
  assert.deepEqual([queueLabel('send', waiting({})), queueLabel('steer', task({ jobId: 'jev-4' }))], ['Send jev-5 now', 'Steer jev-4'])
})

test('the Send now dialog of a task waiting for a slot says what starting it does: over the cap, past its own line, locked beside the writer, beside a local model', () => {
  assert.equal(typeof t.sendNowWords, 'function', 'Send now has its words')
  const { sendNowWords } = t
  assert.deepEqual(sendNowWords(waiting({})), {
    kind: 'slot', holder: null, title: 'Start jev-5 now?', confirmLabel: 'Start now',
    body: ['It runs beside 2 other tasks, over your limit of 2 tasks at once (Settings, Resource budget), so the next task to end frees no slot.'],
  })
  assert.deepEqual(sendNowWords(waiting({ held: 1, max: 1 })).body, ['It runs beside 1 other task, over your limit of 1 task at once (Settings, Resource budget), so the next task to end frees no slot.'])
  // Behind the first of its own line, which waits for the slot.
  assert.deepEqual(sendNowWords(waiting({ ahead: ['jev-3', 'jev-4'] })).body.slice(1), ['jev-3 and jev-4 were ahead of it in kz-harness; they wait for it now.'])
  assert.deepEqual(sendNowWords(waiting({ ahead: ['jev-3'] })).body.slice(1), ['jev-3 was ahead of it in kz-harness and now waits for it.'])
  assert.deepEqual(sendNowWords(waiting({ ahead: ['jev-3'], chatAhead: 1 })).body.slice(1), ['jev-3 and a run started from the chat were ahead of it in kz-harness; they wait for it now.'])
  // A read-only task runs beside the writer, locked.
  assert.deepEqual(sendNowWords(waiting({ heldBy: 'task', holder: 'jev-4' }, { access: 'read' })).body.slice(1), ['It runs locked against writing, beside the task changing kz-harness.'])
  assert.deepEqual(sendNowWords(waiting({}, { access: 'read' })).body.slice(1), ['It runs locked against writing.'])
  // A local model at work, or the task sent to one.
  assert.deepEqual(sendNowWords(waiting({ local: 'jev-3' })).body.slice(1), ['jev-3 runs a local model on this PC; two at once can slow it down a lot.'])
  assert.deepEqual(sendNowWords(waiting({ forcedLocal: true })).body.slice(1), ['jev-5 runs a local model on this PC; beside other work it can slow down a lot.'])
  // Under the cap with nothing else to say, it simply starts.
  assert.deepEqual(sendNowWords(waiting({ held: 0, max: null })).body, ['jev-5 starts now.'])
  assert.equal(sendNowWords(task({ state: 'running' })), null, 'a task at work is sent nowhere')
  assert.equal(sendNowWords(waiting({ sendNow: null })), null)
})

test('the Send now dialog of a task behind a writer offers Put first in line or Stop it and start this, confirmed twice; behind a run from the chat, only Put first in line', () => {
  assert.equal(typeof t.sendNowWords, 'function', 'Send now has its words')
  const { sendNowWords, stopForWords } = t
  assert.deepEqual(sendNowWords(waiting({ sendNow: 'workspace', holder: 'jev-4', heldBy: 'task' })), {
    kind: 'workspace', holder: 'jev-4', title: 'jev-4 is changing kz-harness',
    body: 'Only one task changes a folder at a time. You can put jev-5 first in line, or stop jev-4 now (what it changed so far stays in the folder) and start jev-5.',
  })
  assert.deepEqual(stopForWords(waiting({}), 'jev-4'), { title: 'Stop jev-4?', body: 'Work it already did stays in kz-harness. jev-5 starts as soon as it has stopped.', confirmLabel: 'Stop jev-4' })
  assert.deepEqual(sendNowWords(waiting({ sendNow: 'chat', heldBy: 'chat' })), {
    kind: 'chat', holder: null, title: 'A run from the chat is using kz-harness',
    body: 'A run started from the chat is using kz-harness; jev-5 can go first in line after it.',
  })
})

test('a Send now dialog closes with \'jev-5 has already started.\' once its task leaves the line, and Steer turns to the choices for a task at work, keeping the words', () => {
  assert.equal(typeof t.queueDrift, 'function', 'a queue dialog that no longer fits closes and says why')
  const { queueDrift, steerDialogWords, restartWords } = t
  const sent = { kind: 'send', key: 'k5', jobId: 'jev-5', wait: 'slot', holder: null }
  assert.equal(queueDrift(sent, waiting({})), '')
  assert.equal(queueDrift(sent, waiting({ sendNow: null }, { state: 'routing' })), 'jev-5 has already started.')
  assert.equal(queueDrift(sent, waiting({}, { state: 'stopped' })), 'jev-5 ended while you were deciding, so nothing was done.')
  assert.equal(queueDrift(sent, null), 'jev-5 ended while you were deciding, so nothing was done.', 'cleared from the list')
  assert.equal(queueDrift(sent, waiting({ sendNow: 'workspace', holder: 'jev-6' })), 'What jev-5 waits for changed while you were deciding, so nothing was done. Send now says what it waits for now.')
  assert.equal(queueDrift({ ...sent, kind: 'stop', wait: 'workspace', holder: 'jev-4' }, waiting({ sendNow: 'workspace', holder: 'jev-6' })), 'What jev-5 waits for changed while you were deciding, so nothing was done. Send now says what it waits for now.', 'the task to stop is the one the person read')
  // Steer: a task that starts only turns the dialog; one that ends closes it.
  const steer = { kind: 'steer', key: 'k5', jobId: 'jev-5', text: 'also the README', typed: true }
  assert.equal(queueDrift(steer, waiting({}, { state: 'running' })), '')
  assert.equal(queueDrift(steer, waiting({}, { state: 'completed' })), 'jev-5 ended while you were typing, so your words were not sent.')
  assert.deepEqual(steerDialogWords(waiting({})), { mode: 'amend', title: 'Steer jev-5', body: 'Your words are added to the task before it starts. It keeps its place in line.', placeholder: 'What should it do differently?', confirmLabel: 'Add to task', note: '' })
  const turned = steerDialogWords(waiting({}, { state: 'running' }), { typed: true })
  assert.equal(turned.mode, 'running')
  // Since slice 8 a task at work takes words mid-run, so one that started meanwhile says they now go to it.
  assert.equal(turned.note, 'jev-5 started while you were typing, so your words were not added. Steer it again: they now go to the running agent.')
  assert.deepEqual(turned.body, ['Your words go to jev-5 while it works, or with its next attempt.', 'Or send them as a follow-up task that runs after it, or stop it and start again with them. What it changed so far stays in kz-harness.'])
  assert.equal(steerDialogWords(waiting({}), { typed: true, started: true }).mode, 'running', 'the server found it started before its row says so')
  assert.equal(steerDialogWords(task({ state: 'running', jobId: 'jev-4' })).note, '', 'opened on a running task, nothing drifted')
  assert.equal(steerDialogWords(task({ state: 'failed' })), null)
  assert.deepEqual(restartWords(task({ jobId: 'jev-4', workspace: 'C:\\work\\kz-harness' })), { title: 'Stop jev-4 and start again?', body: 'Stop jev-4 and start again with your message? What it changed so far stays in kz-harness.', confirmLabel: 'Stop and start again' })
  assert.equal(queueDrift({ ...steer, kind: 'restart' }, waiting({})), 'jev-5 went back to waiting in line while you were deciding, so nothing was stopped.')
  for (const s of [turned.note, ...turned.body, queueDrift(sent, null)]) assert.doesNotMatch(s, /[\u2013\u2014]|undefined|null/)
})

test('Steer on a task at work: its dialog says what the agent at work does with the words, sends them now unless that agent cannot take them, and its row lists each piece of guidance with what became of it; the Live tab\'s box says where words go', () => {
  assert.equal(typeof t.guidanceRows, 'function', 'a task\'s row lists its guidance')
  assert.equal(typeof t.composerWords, 'function', 'the Live tab has a box for Steer')
  const { steerDialogWords, guidanceRows, composerWords } = t
  const at = (steer, over = {}) => task({ jobId: 'jev-4', key: 'k4', workspace: 'C:\\work\\kz-harness', controls: { sendNow: null, steer }, ...over })
  const codex = { path: 'codex', why: null, agent: 'codex', name: 'Codex', sendable: true, words: 'Codex takes this in at its next step.' }
  const w = steerDialogWords(at(codex))
  assert.deepEqual([w.mode, w.title, w.confirmLabel, w.live, w.note], ['running', 'Steer jev-4', 'Now, while it works', true, ''])
  assert.deepEqual(w.body, ['Codex takes this in at its next step.', 'Or send them as a follow-up task that runs after it, or stop it and start again with them. What it changed so far stays in kz-harness.'])
  const checks = { path: null, why: 'checks', agent: null, name: null, sendable: true, words: 'jev-4 is running its checks right now, so this goes with its next attempt, if there is one.' }
  assert.deepEqual([steerDialogWords(at(checks)).live, steerDialogWords(at(checks)).body[0]], [true, checks.words], 'with no agent at work the words still go, for its next attempt')
  const claude = { path: null, why: 'claude-off', agent: 'claude', name: 'Claude Code', sendable: false, words: 'Claude Code can\'t take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). It goes to the next attempt if there is one.' }
  assert.deepEqual([steerDialogWords(at(claude)).live, steerDialogWords(at(claude)).body[0]], [false, claude.words], 'past an agent that cannot take them, Now is off and the dialog says why')
  // Each piece with what became of it, oldest first; one its task ended without can be copied or sent again.
  const steers = [
    { id: 'a1', how: 'amend', state: 'added', text: 'and the README', words: 'Added to the task before it started' },
    { id: 'g1', how: 'live', state: 'delivered', text: 'use tabs', words: 'Read by Codex at 14:02' },
    { id: 'g2', how: 'live', state: 'returned', text: 'run the linter', words: 'Not used: Codex finished first' },
    { id: 'g3', how: 'live', state: 'pending', text: '   ' },
  ]
  assert.deepEqual(guidanceRows(at(codex, { steers })), [
    { id: 'a1', text: 'and the README', state: 'added', words: 'Added to the task before it started', returned: false },
    { id: 'g1', text: 'use tabs', state: 'delivered', words: 'Read by Codex at 14:02', returned: false },
    { id: 'g2', text: 'run the linter', state: 'returned', words: 'Not used: Codex finished first', returned: true },
  ])
  assert.deepEqual(guidanceRows(task({})), [])
  // The Live tab's box.
  assert.deepEqual(composerWords(at(codex)), { placeholder: 'Steer jev-4: tell Codex something while it works', open: true })
  assert.deepEqual(composerWords(at(checks, { activity: { agent: 'DeepSeek agent' } })), { placeholder: 'Steer jev-4: tell DeepSeek agent something while it works', open: true })
  assert.deepEqual(composerWords(at(claude)), { placeholder: claude.words, open: false })
  assert.deepEqual(composerWords(waiting({})), { placeholder: 'Add to jev-5 before it starts', open: true })
  assert.equal(composerWords(task({ state: 'completed' })), null)
})
