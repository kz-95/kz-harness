import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as waits from '../waits.js'

const { MIN_RUNS, WINDOW, createWaitStats, placeText, remainingOf, sampleOf, spanText, waitEstimate, waitStats, waitText } = waits
const MIN = 60_000
let id = 0
/** A history row as router.js writes it, wall time included. */
const row = (wallMs, over = {}) => ({
  runId: `r${++id}`, workspace: 'C:\\Work\\app', routing: { primaryAgent: 'claude', decider: 'jev' }, strategy: 'CHEAP_DIRECT',
  plan: { forceReview: false, reviewer: null }, finalStatus: 'accepted', attempts: [{ role: 'primary', agent: 'claude', effort: 'medium' }], wallMs, ...over,
})
const shape = { decider: 'jev', agent: 'claude', effort: 'medium', review: false }
const here = 'C:\\Work\\app'
const at = (why, over = {}) => ({ why, place: 2, ahead: 0, slotsAhead: 0, overCap: false, ...over })

test('only rows that say how long work takes are counted, each once', () => {
  assert.equal(sampleOf(row(4 * MIN)).ms, 4 * MIN)
  assert.equal(sampleOf(row(undefined)), null, 'a row from before runs kept their wall time')
  for (const finalStatus of ['stopped', 'paused_limit', 'answered', 'needs_write']) assert.equal(sampleOf(row(4 * MIN, { finalStatus })), null, finalStatus)
  // An answer asked for in chat that did not answer says no more of how long work takes.
  for (const finalStatus of ['limit_reached', 'failed']) assert.equal(sampleOf(row(4 * MIN, { finalStatus, answerOnly: true })), null, finalStatus)
  assert.equal(sampleOf(row(4 * MIN, { attempts: [{ role: 'primary', limitHit: true }] })), null)
  assert.ok(sampleOf(row(4 * MIN, { finalStatus: 'needs_human' })), 'a run that ended asking for a person still ran its course')
  assert.equal(sampleOf(row(Number.NaN)), null)
  // A run whose work went to a tool first fits no agent's shape: it counts at its workspace only.
  assert.deepEqual([sampleOf(row(MIN, { attempts: [{ role: 'tool' }] })).agent, sampleOf(row(MIN, { routing: { primaryAgent: 'claude', tool: 'lint' } })).agent], [null, null])
  // A row read from the file and told again as it was appended counts once.
  const stats = createWaitStats()
  const r = row(5 * MIN)
  assert.equal(stats.add(r), true)
  assert.equal(stats.add(r), false)
  stats.load([r])
  assert.equal(stats.get('jev|a|claude').length, 1)
})

test('a level keeps its newest runs only', () => {
  const stats = waitStats([...Array.from({ length: WINDOW }, () => row(100 * MIN)), ...Array.from({ length: 10 }, () => row(MIN))])
  const kept = stats.get('jev|a|claude')
  assert.equal(kept.length, WINDOW)
  assert.equal(kept.filter((ms) => ms === MIN).length, 10, 'the ten newest are in')
})

test('the running task\'s remaining time is the middle half of what runs like it took beyond now', () => {
  const stats = waitStats([2, 4, 6, 8, 10].map((m) => row(m * MIN)))
  const r = remainingOf(stats, { shape, workspace: here, elapsedMs: 0 })
  assert.deepEqual([r.lowMs / MIN, r.highMs / MIN, r.n], [4, 8, 5])
  assert.equal(r.basis, 'of claude at medium effort with no planned review')
  // Runs shorter than the time already run say nothing about what is left: they are left out.
  const later = remainingOf(waitStats([2, 4, 6, 8, 10, 12, 14].map((m) => row(m * MIN))), { shape, elapsedMs: 3 * MIN })
  assert.equal(later.k, 6)
  assert.ok(later.lowMs > 0)
})

test('a level under the minimum is passed over for a coarser one, named, and within one decider', () => {
  const rows = [
    ...[3, 5].map((m) => row(m * MIN)),
    ...[6, 7, 8].map((m) => row(m * MIN, { plan: { forceReview: true, reviewer: 'codex' } })),
  ]
  const r = remainingOf(waitStats(rows), { shape, workspace: here, elapsedMs: 0 })
  assert.equal(r.n, 5)
  assert.equal(r.basis, 'of claude at medium effort', 'the planned review split them; the effort did not')
  // A workspace spelled with another case or separator is the same lane.
  assert.equal(remainingOf(waitStats(rows), { shape: { decider: 'jev' }, workspace: 'c:/work/APP/', elapsedMs: 0 }).basis, 'in this workspace')
  // Laya-decided runs are not Jev's: a Laya holder is not estimated from Jev runs, nor the reverse.
  assert.equal(remainingOf(waitStats(rows), { shape: { ...shape, decider: 'laya' }, workspace: here, elapsedMs: 0 }), null)
  // Under the minimum everywhere: nothing, not a figure and not a sentence.
  assert.equal(remainingOf(waitStats(rows.slice(0, MIN_RUNS - 1)), { shape, workspace: here, elapsedMs: 0 }), null)
})

test('a running task longer than all but a few runs like it gets no figure, never a negative one', () => {
  const stats = waitStats([2, 3, 4, 5, 6, 20].map((m) => row(m * MIN)))
  const r = remainingOf(stats, { shape, elapsedMs: 5.5 * MIN })
  assert.deepEqual(r, { over: true, n: 6, k: 2, basis: 'of claude at medium effort with no planned review' })
  const e = waitEstimate(stats, at('workspace'), { holder: { shape, elapsedMs: 5.5 * MIN }, workspace: here })
  assert.equal(e.lowMs, null)
  assert.equal(e.text, `No estimate: only 2 of the 6 past runs of claude at medium effort with no planned review ran longer than the running task has so far, and an estimate needs ${MIN_RUNS}.`)
})

test('the estimate names its basis, counts the tasks ahead at what a run in the workspace takes, and is nothing when it cannot be drawn', () => {
  assert.equal(typeof waitEstimate, 'function')
  const stats = waitStats([2, 4, 6, 8, 10].map((m) => row(m * MIN)))
  const holder = { shape, elapsedMs: 0 }
  assert.equal(waitEstimate(stats, at('workspace'), { holder, workspace: here }).text, 'Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review.')
  const third = waitEstimate(stats, at('workspace', { place: 3, ahead: 1 }), { holder, workspace: here, ahead: [{ kind: 'task', decider: 'jev' }] })
  assert.deepEqual([third.lowMs / MIN, third.highMs / MIN], [8, 16])
  assert.equal(third.text, 'Starts in about 8 to 16 min, estimated from 5 past runs of claude at medium effort with no planned review for the running task and 5 past runs in this workspace for the task ahead of it.')
  // Too few runs in this workspace to count the tasks ahead: the running task's end, said as that.
  const elsewhere = waitStats([2, 4, 6, 8, 10].map((m) => row(m * MIN, { workspace: 'D:\\other' })))
  assert.equal(waitEstimate(elsewhere, at('workspace', { ahead: 2 }), { holder, workspace: here, ahead: [{ kind: 'task', decider: 'jev' }, { kind: 'task', decider: 'jev' }] }).text,
    'The running task likely ends in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review; 2 more tasks are ahead of this one.')
  // A Laya holder says its runs are Laya's.
  const laya = waitStats([2, 4, 6, 8, 10].map((m) => row(m * MIN, { routing: { primaryAgent: 'claude', decider: 'laya' } })))
  assert.match(waitEstimate(laya, at('workspace'), { holder: { shape: { ...shape, decider: 'laya' }, elapsedMs: 0 }, workspace: here }).text, /estimated from 5 past Laya runs of claude/)
  // Nothing: a slot under the cap; a line whose first waits for one; a slot another workspace's
  // earlier task takes first; more running than the cap allows; a holder KzH knows nothing of;
  // and too few runs to say anything.
  for (const [w, h] of [[at('cap', { slot: 1 }), holder], [at('line', { ahead: 1 }), holder], [at('workspace', { slotsAhead: 1 }), holder], [at('workspace', { overCap: true }), holder], [at('workspace'), null]]) {
    assert.equal(waitEstimate(stats, w, { holder: h, workspace: here }), null, JSON.stringify(w))
  }
  assert.equal(waitEstimate(waitStats([row(undefined)]), at('workspace'), { holder, workspace: here }), null)
})

test('a waiting task\'s place and whole line are said in sentences', () => {
  assert.equal(placeText({ why: 'workspace', place: 2 }), '2nd in line')
  assert.equal(placeText({ why: 'line', place: 3 }), '3rd in line')
  assert.equal(placeText({ why: 'cap', place: 1, slot: 1 }), 'next for a free slot')
  assert.equal(placeText({ why: 'cap', place: 1, slot: 2 }), '2nd for a free slot')
  assert.equal(waitText('Waiting: another task is running in this workspace', { text: 'Starts in about 4 min, estimated from 5 past runs in this workspace.' }),
    'Waiting: another task is running in this workspace. Starts in about 4 min, estimated from 5 past runs in this workspace.')
  assert.equal(waitText('Waiting for a free slot: the resource budget caps how many tasks run at once', null), 'Waiting for a free slot: the resource budget caps how many tasks run at once.')
})

test('a span is said in whole minutes, and never as a figure that includes now', () => {
  assert.equal(spanText(10_000, 40_000), 'under a minute')
  assert.equal(spanText(4 * MIN, 4.2 * MIN), 'about 4 min')
  assert.equal(spanText(3 * MIN, 7 * MIN), 'about 3 to 7 min')
  assert.equal(spanText(10_000, 3 * MIN), 'under 3 min')
  assert.equal(spanText(65 * MIN, 120 * MIN), 'about 1 h 5 min to 2 h')
  assert.equal(spanText(30 * MIN, 90 * MIN), 'about 30 min to 1 h 30 min')
  for (const t of [spanText(1, 2), spanText(0, 9e6)]) assert.doesNotMatch(t, /[\u2013\u2014]|NaN|undefined|-\d/)
})

test('a read pass is no sample for the waiting line, whatever it ended in: it never holds a workspace\'s lane', () => {
  for (const finalStatus of ['needs_human', 'limit_reached', 'accepted']) assert.equal(sampleOf(row(4 * MIN, { finalStatus, access: { mode: 'read' } })), null, finalStatus)
  assert.ok(sampleOf(row(4 * MIN, { access: { mode: 'write', from: { why: 'x' } } })), 'the writer pass after a hand-back is ordinary work')
})

// ---------------------------------------------------------------- the waiting line, second pass
// A block of its own: its rows carry a decider and an effort of their own, under the same names.
{
  let id = 0
  const row = (ms, { agent = 'claude', effort = 'medium', decider = 'jev', workspace = 'C:\\work\\app', finalStatus = 'accepted', attempts } = {}) => ({
    runId: `r${++id}`, wallMs: ms, workspace, finalStatus, routing: { primaryAgent: agent, decider }, plan: { forceReview: false, reviewer: null },
    attempts: attempts ?? [{ agent, role: 'primary', effort }],
  })
  const shape = { decider: 'jev', agent: 'claude', effort: 'medium', review: false }
  const here = 'C:\\work\\app'
  const at = (why, over = {}) => ({ why, place: 2, ahead: 0, slotsAhead: 0, overCap: false, ...over })

  test('the figure names the runs it stands on: those that ran longer than the running task has so far', () => {
    const stats = waitStats([...Array(45)].map(() => row(1 * MIN)).concat([20, 22, 24, 26, 28].map((m) => row(m * MIN))))
    const e = waitEstimate(stats, at('workspace'), { holder: { shape, elapsedMs: 10 * MIN }, workspace: here })
    assert.equal(e.n, 5, 'five runs make the figure, not fifty')
    assert.equal(e.text, 'Starts in about 12 to 16 min, estimated from the 5 of 50 past runs of claude at medium effort with no planned review that ran longer than the running task has so far.')
  })

  test('with too few runs that lasted as long, the line says how many did and how many a figure needs', () => {
    const stats = waitStats([1, 2, 3, 10, 11, 12].map((m) => row(m * MIN)))
    const e = waitEstimate(stats, at('workspace'), { holder: { shape, elapsedMs: 10.5 * MIN }, workspace: here })
    assert.equal(e.lowMs, null)
    assert.equal(e.text, `No estimate: only 2 of the 6 past runs of claude at medium effort with no planned review ran longer than the running task has so far, and an estimate needs ${MIN_RUNS}.`)
  })

  test('a run in which no agent worked counts only at its workspace', () => {
    const s = sampleOf(row(5_000, { finalStatus: 'needs_human', attempts: [] }))
    assert.deepEqual([s.agent, s.effort, s.workspace], [null, null, 'c:/work/app'])
  })

  test('a run that ended before the history was read stays among the newest the window keeps', () => {
    const stats = createWaitStats()
    stats.add(row(99 * MIN))
    stats.load([...Array(60)].map(() => row(1 * MIN)))
    assert.equal(stats.get('jev|a|claude').length, 50)
    assert.ok(stats.get('jev|a|claude').includes(99 * MIN), 'the start-up read does not push out a run that ended after it began')
  })

  test('each task ahead is counted under the provider that will decide it', () => {
    const stats = waitStats([...Array(6)].map(() => row(10 * MIN, { decider: 'jev' })).concat([...Array(6)].map(() => row(40 * MIN, { decider: 'laya' }))))
    const holder = { shape: { ...shape, decider: 'laya' }, elapsedMs: 0 }
    const e = waitEstimate(stats, at('workspace', { place: 3, ahead: 1 }), { holder, workspace: here, ahead: [{ kind: 'task', decider: 'jev' }] })
    assert.deepEqual([e.lowMs / MIN, e.highMs / MIN], [50, 50])
    assert.equal(e.text, 'Starts in about 50 min, estimated from 6 past Laya runs of claude at medium effort with no planned review for the running task and 6 past runs in this workspace for the task ahead of it.')
    const unknown = waitEstimate(stats, at('workspace', { place: 3, ahead: 1 }), { holder, workspace: here, ahead: [null] })
    assert.equal(unknown.lowMs, null, 'one ahead whose decider is not known is not counted as anything')
    assert.match(unknown.text, /^The running task likely ends in about 40 min, .*; 1 more task is ahead of this one\.$/)
  })

  test('a run that only answers a question gets no figure drawn from runs that did work', () => {
    const stats = waitStats([...Array(6)].map(() => row(20 * MIN)))
    assert.equal(waitEstimate(stats, at('workspace'), { holder: { shape, elapsedMs: 10_000, answerOnly: true }, workspace: here }), null, 'an answer takes seconds; past task runs say minutes')
    assert.equal(waitEstimate(stats, at('chat'), { holder: { shape, elapsedMs: 10_000, answerOnly: true }, workspace: here }), null)
    assert.match(waitEstimate(stats, at('chat'), { holder: { shape, elapsedMs: 0 }, workspace: here })?.text ?? '', /^Starts in about 20 min, estimated from 6 past runs/, 'a run from the chat that works is estimated as a task is')
  })

  test('what else decides when a waiting task starts is said in sentences, never as a figure', () => {
    assert.equal(typeof waits.slotFacts, 'function')
    assert.equal(waits.slotFacts(at('workspace')), '')
    assert.equal(waits.slotFacts(at('workspace', { slotsAhead: 2 })), '2 tasks waiting in other workspaces take free slots before this one.')
    assert.equal(waits.slotFacts(at('cap', { max: 2, held: { benchmark: 1, task: 1 } })), 'Tasks at once: 2 of 2 in use (1 background task and 1 capability benchmark task).')
    assert.equal(waits.slotFacts(at('workspace', { overCap: true, max: 1, held: { task: 2 } })), 'Tasks at once: 2 in use, over the 1 now set, so the next to end frees no slot (2 background tasks).')
    assert.equal(waits.slotFacts(at('line', { chatAhead: 1, max: 3, held: { task: 3 } })), 'Tasks at once: 3 of 3 in use (3 background tasks). 1 run from the chat waits ahead of it in this line.')
    assert.equal(waits.waitText('Waiting: x', null, 'One fact.'), 'Waiting: x. One fact.')
    for (const t of [waits.slotFacts(at('cap', { max: 1, held: { chat: 1 } }))]) assert.doesNotMatch(t, /[\u2013\u2014]|undefined|NaN/)
  })
}

test('a slot taken first by a read-only task of the same workspace is said as that, not as another workspace\'s', () => {
  const at = (why, over = {}) => ({ why, place: 2, ahead: 0, slotsAhead: 0, overCap: false, ...over })
  assert.equal(waits.slotFacts(at('workspace', { slotsAhead: 1, slotsAheadHere: 1 })), '1 read-only task in this workspace takes a free slot before this one.')
  assert.equal(waits.slotFacts(at('workspace', { slotsAhead: 3, slotsAheadHere: 1 })), '2 tasks waiting in other workspaces take free slots before this one. 1 read-only task in this workspace takes a free slot before this one.')
  assert.equal(waits.slotFacts(at('workspace', { slotsAhead: 1 })), '1 task waiting in another workspace takes a free slot before this one.')
})
