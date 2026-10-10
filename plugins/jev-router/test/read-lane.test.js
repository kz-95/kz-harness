// A task judged read only (docs/queue-and-cost-findings.md 1) takes a slot of its own rather than its
// workspace's lane, still counts against Tasks at once, and when its read pass hands it back it
// waits in its workspace's line and runs once more as work that writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import * as T from '../tasks.js'

const { WAITING, createLanes, createTasks, laneKey } = T
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function fakeJobs() {
  let n = 0
  const jobs = new Map()
  return {
    start: (spec) => { const id = `jev-${++n}`; jobs.set(id, { spec, hooks: spec.run() }); return id },
    read: () => ({ text: '' }),
    kill: (id, _owner, reason) => { jobs.get(id)?.hooks.cancel(reason); return 'requested' },
  }
}

/**
 * createTasks over real lanes whose runner admits each task as index.js's does (runAdmitted). Each
 * pass holds until the test ends it: `finish` settles it, `handBack` makes a read pass hand the
 * task to its workspace's line the way route() does (the access event, then NEEDS_LANE).
 */
function readQueue({ max = null, file = join(mkdtempSync(join(tmpdir(), 'kz-read-')), 'tasks.jsonl'), now } = {}) {
  assert.equal(typeof T.runAdmitted, 'function', 'tasks.js has no runAdmitted')
  const lanes = createLanes({ max })
  const jobs = fakeJobs()
  const passes = new Map() // `${task}:${mode}` -> { pass, finish, handBack, emit }
  const tasks = createTasks({
    file, lanes, jobs: () => jobs, ...(now ? { now } : {}),
    run: (t, { signal, emit, onEntry }) => T.runAdmitted({
      lanes, task: t, signal, who: { kind: 'task', decider: t.decider },
      onWait: (why) => emit({ type: 'queued', text: WAITING[why] }),
      run: (pass) => new Promise((res, rej) => {
        onEntry({ id: `run-${t.jobId}-${pass.mode}` })
        passes.set(`${t.task}:${pass.mode}`, {
          pass, emit,
          finish: () => res(`${t.task} ${pass.mode} report`),
          handBack: (why) => { emit({ type: 'access', mode: 'write', from: 'read', why }); rej(Object.assign(new Error(why), { code: 'NEEDS_LANE', readPass: { runId: `run-${t.jobId}-read`, agent: 'claude', durationMs: 41_000 } })) },
        })
      }),
    }),
  })
  return { lanes, tasks, passes, file }
}
const own = { owner: {}, sessionId: 's1' }
const VERDICT = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
const reader = (task, over = {}) => ({ ...own, workspace: 'C:/w', task, readVerdict: VERDICT, access: 'read', ...over })

test('a read task takes a slot of its own: it starts beside the task writing in its workspace, and a writer queued after it waits only for that writer', async () => {
  const { tasks, passes, lanes } = readQueue()
  const w = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  assert.ok(passes.has('R:read'), 'the read task waited for the writer')
  assert.equal(tasks.get(r.jobId).state, 'routing')
  assert.equal(tasks.get(r.jobId).position, 0)
  assert.equal(passes.get('R:read').pass.mode, 'read')
  assert.equal(lanes.busy(laneKey('C:/w')), true, 'the writer still holds the workspace')
  const w2 = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W2' })
  await tick()
  const waiting = tasks.get(w2.jobId)
  assert.equal(waiting.state, 'queued')
  assert.deepEqual([waiting.position, waiting.waiting.why, waiting.waiting.placeText], [2, 'workspace', '2nd in line'], 'only the writer is ahead of it')
  passes.get('W:write').finish()
  await tick()
  assert.ok(passes.has('W2:write'), 'the second writer started while the reader still runs')
  assert.equal(tasks.get(r.jobId).state, 'routing')
  passes.get('R:read').finish()
  passes.get('W2:write').finish()
  await tick()
  assert.equal(tasks.get(w.jobId).state, 'completed')
  assert.equal(tasks.get(r.jobId).state, 'completed')
})

test('a read task still counts against Tasks at once, and waiting for it says the cap, not the workspace', async () => {
  const { tasks, passes, lanes } = readQueue({ max: 1 })
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  const v = tasks.get(r.jobId)
  assert.equal(v.state, 'queued')
  assert.equal(v.waiting.why, 'cap')
  assert.equal(v.waiting.reason, WAITING.cap)
  assert.equal(v.progressText, WAITING.cap)
  assert.equal(v.position, 1)
  passes.get('W:write').finish()
  await tick()
  assert.ok(passes.has('R:read'))
  assert.deepEqual(lanes.slots(), { held: 1, waiting: 0, max: 1 }, 'the read pass holds the one slot')
  // A task in another workspace now waits for the slot the reader holds.
  const other = tasks.enqueue({ ...own, workspace: 'C:/elsewhere', task: 'X' })
  await tick()
  assert.equal(tasks.get(other.jobId).waiting.why, 'cap')
  passes.get('R:read').finish()
  await tick()
  assert.ok(passes.has('X:write'))
  passes.get('X:write').finish()
  await tick()
})

test('runAdmitted: a read pass handed back gives up its slot before waiting for its folder, and runs once as a writer; a hand-back from a writer is an error', async () => {
  assert.equal(typeof T.runAdmitted, 'function')
  assert.equal(typeof T.readLaneKey, 'function')
  const lanes = createLanes({ max: 1 })
  const t = { jobId: 'jev-1', workspace: 'C:/w', access: 'read' }
  const seen = []
  const run = async (pass) => {
    seen.push({ mode: pass.mode, from: pass.from ?? null, held: lanes.slots().held, readHeld: lanes.busy(T.readLaneKey('C:/w', 'jev-1')), writeHeld: lanes.busy(laneKey('C:/w')), who: pass.who })
    if (pass.mode === 'read') throw Object.assign(new Error('claude said it needs to change files'), { code: 'NEEDS_LANE', readPass: { agent: 'claude', durationMs: 5 } })
    return 'written'
  }
  // With a cap of 1, holding the slot while waiting for the workspace would wait for itself.
  const out = await Promise.race([
    T.runAdmitted({ lanes, task: t, signal: new AbortController().signal, who: { kind: 'task' }, run }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('runAdmitted waited for its own slot')), 2000)),
  ])
  assert.equal(out, 'written')
  assert.deepEqual(seen.map(({ who, ...s }) => s), [
    { mode: 'read', from: null, held: 1, readHeld: true, writeHeld: false },
    { mode: 'write', from: { why: 'claude said it needs to change files', readPass: { agent: 'claude', durationMs: 5 } }, held: 1, readHeld: false, writeHeld: true },
  ])
  assert.equal(seen[0].who.reads, true, 'the lane says a read pass holds it')
  assert.equal(seen[1].who.reads, undefined)
  assert.notEqual(seen[0].who, seen[1].who, 'each pass gets its own description on the lane')
  assert.deepEqual(lanes.slots(), { held: 0, waiting: 0, max: 1 })

  // A writer's NEEDS_LANE is a bug, never a second hand-back.
  let passesRun = 0
  await assert.rejects(
    T.runAdmitted({ lanes, task: { jobId: 'jev-2', workspace: 'C:/w', access: 'write' }, signal: new AbortController().signal, run: async () => { passesRun++; throw Object.assign(new Error('huh'), { code: 'NEEDS_LANE' }) } }),
    /^Error: a pass that writes cannot be handed back: huh$/,
  )
  assert.equal(passesRun, 1)
  // Any other failure of a read pass is the task's failure: no writer pass follows.
  const modes = []
  await assert.rejects(T.runAdmitted({ lanes, task: { ...t, jobId: 'jev-3' }, signal: new AbortController().signal, run: async (p) => { modes.push(p.mode); throw new Error('crashed') } }), /crashed/)
  assert.deepEqual(modes, ['read'])
  // Stopped during the read pass: stopped, not handed back.
  const ac = new AbortController()
  const stopped = []
  await assert.rejects(T.runAdmitted({ lanes, task: { ...t, jobId: 'jev-4' }, signal: ac.signal, run: async (p) => { stopped.push(p.mode); ac.abort(); throw Object.assign(new Error('x'), { code: 'NEEDS_LANE' }) } }), /x/)
  assert.deepEqual(stopped, ['read'])
  assert.deepEqual(lanes.slots(), { held: 0, waiting: 0, max: 1 })
})

test('a task keeps its read verdict and access on the record, in the list, on disk and through a restart; a row saved before there was a read lane waited in its workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-read-'))
  const file = join(dir, 'tasks.jsonl')
  const { tasks, passes } = readQueue({ file })
  const r = tasks.enqueue(reader('R'))
  const w = tasks.enqueue({ ...own, workspace: 'C:/other', task: 'W', readVerdict: { ...VERDICT, p: 0.2, reads: false }, access: 'write' })
  const nl = tasks.enqueue({ ...own, workspace: 'C:/third', task: 'N', readVerdict: VERDICT, access: 'write', accessWhy: 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)' })
  await tick()
  assert.deepEqual([tasks.get(r.jobId).access, tasks.get(r.jobId).readVerdict], ['read', VERDICT])
  assert.deepEqual([tasks.get(w.jobId).access, tasks.get(w.jobId).readVerdict.p], ['write', 0.2])
  assert.equal(tasks.get(nl.jobId).accessWhy, 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)')
  assert.equal(passes.get('R:read').pass.mode, 'read')
  assert.equal(passes.get('N:write').pass.mode, 'write', 'a task no agent can lock for runs in its workspace\'s lane')
  for (const k of ['R:read', 'W:write', 'N:write']) passes.get(k).finish()
  await tick()
  await tasks.flushed()
  const onDisk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const row = onDisk.find((x) => x.jobId === r.jobId)
  assert.deepEqual([row.access, row.readVerdict, row.accessWhy, row.requeuedAt], ['read', VERDICT, null, null])
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ jobId: 'jev-99', sessionId: 's1', workspace: 'C:/old', task: 'old one', state: 'completed', deliveryState: 'delivered' })}\n`)
  const again = readQueue({ file })
  await again.tasks.ready
  assert.deepEqual([again.tasks.get(r.jobId).access, again.tasks.get(r.jobId).readVerdict], ['read', VERDICT])
  const old = again.tasks.get('jev-99')
  assert.deepEqual([old.access, old.readVerdict, old.accessWhy, old.requeuedAt], ['write', null, null, null])
  assert.equal(T.laneOf({ ...old, access: old.access }), laneKey('C:/old'))
  assert.equal(T.laneOf({ workspace: 'C:/w', jobId: 'jev-1', access: 'read' }), T.readLaneKey('C:/w', 'jev-1'))
  assert.notEqual(T.readLaneKey('C:/w', 'jev-1'), laneKey('C:/w'))
})

test('a task handed back is waiting again: it loses read, its agent and model, gets its own effort back, keeps its first start, and counts its time in line from the rejoin', async () => {
  let clock = 1_000
  const { tasks, passes } = readQueue({ now: () => clock })
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  clock = 2_000
  const r = tasks.enqueue(reader('R', { effort: 'high' }))
  await tick()
  const firstStart = tasks.get(r.jobId).startedAt
  assert.equal(firstStart, 2_000)
  const { emit, handBack } = passes.get('R:read')
  emit({ type: 'routed', routing: { primaryAgent: 'claude', capability: 'project_read' } })
  emit({ type: 'attempt_start', agent: 'claude', role: 'primary', effort: 'low' })
  emit({ type: 'attempt_end', attempt: { agent: 'claude', model: 'opus', effort: 'low' } })
  assert.deepEqual([tasks.get(r.jobId).agent, tasks.get(r.jobId).model, tasks.get(r.jobId).effort], ['claude', 'opus', 'low'])
  clock = 45_000
  handBack('claude said it needs to change files: the parser')
  await tick()
  const v = tasks.get(r.jobId)
  assert.equal(v.state, 'queued')
  assert.equal(v.phase, 'queued')
  assert.equal(v.access, 'write')
  assert.equal(v.accessWhy, 'claude said it needs to change files: the parser')
  assert.deepEqual([v.agent, v.model, v.effort], [null, null, 'high'])
  assert.equal(v.startedAt, firstStart)
  assert.equal(v.durationMs, null, 'waiting again, it shows no running time anywhere')
  assert.equal(v.requeuedAt, 45_000)
  assert.equal(v.waiting.since, 45_000)
  assert.deepEqual([v.position, v.waiting.why], [2, 'workspace'], 'it waits behind the writer in its workspace')
  clock = 60_000
  passes.get('W:write').finish()
  await tick()
  const running = tasks.get(r.jobId)
  assert.equal(running.state, 'routing')
  assert.equal(running.startedAt, firstStart, 'the writer pass keeps the task\'s first start')
  assert.equal(running.runId, `run-${r.jobId}-write`)
  assert.deepEqual(running.runIds, [`run-${r.jobId}-read`, `run-${r.jobId}-write`], 'both passes are the task\'s own')
  assert.equal(passes.get('R:write').pass.from.why, 'claude said it needs to change files: the parser')
  // Its 15 s back in line is no part of its running time: 43 s of reading, then the writer pass.
  assert.equal(running.inLineMs, 15_000)
  assert.equal(running.durationMs, 43_000)
  clock = 80_000
  passes.get('R:write').finish()
  await tick()
  assert.equal(tasks.get(r.jobId).state, 'completed')
  assert.equal(tasks.get(r.jobId).durationMs, 63_000, '43 s reading and 20 s writing')
})

test('a task sent to an agent you picked keeps that agent when its read pass hands it back, as it keeps its own effort: its row names it while it waits and as its pass that writes starts, and a direct answer is told it starts on that agent', async () => {
  const { tasks, passes } = readQueue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  // Picked in the model menu, as its own row: the read pass and the pass that writes run on it alike.
  const r = tasks.enqueue(reader('R', { forceAgent: 'claude', effort: 'high' }))
  await tick()
  const { emit, handBack } = passes.get('R:read')
  emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'manual', capability: 'project_read' }, primary: { agent: 'claude', model: 'opus', effort: 'high', level: 'high', speed: null } })
  emit({ type: 'attempt_start', agent: 'claude', role: 'primary', effort: 'high' })
  emit({ type: 'attempt_end', attempt: { agent: 'claude', model: 'opus', effort: 'high' } })
  handBack('claude said it needs to change files: the parser')
  await tick()
  const waiting = tasks.get(r.jobId)
  assert.deepEqual([waiting.state, waiting.agent, waiting.model, waiting.effort], ['queued', 'claude', null, 'high'], 'waiting again, it names the agent it was sent to, not who would pick one')
  passes.get('W:write').finish()
  await tick()
  const starting = tasks.get(r.jobId)
  assert.deepEqual([starting.state, starting.agent], ['routing', 'claude'], 'its pass that writes starts on it')
  const { liveStatusSentence } = await import('../reply-words.js')
  assert.equal(liveStatusSentence([starting], { claude: 'Claude Code' }), `Right now in this chat: ${r.jobId} is starting on Claude Code.`, 'nobody is choosing its agent')
  passes.get('R:write').finish()
  await tick()
  assert.equal(tasks.get(r.jobId).state, 'completed')
})

test('a task removed while back in line after its read pass counts only its read pass as running time', async () => {
  let clock = 1_000
  const { tasks, passes } = readQueue({ now: () => clock })
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  clock = 31_000
  passes.get('R:read').handBack('claude said it needs to change files')
  await tick()
  clock = 691_000
  tasks.stop(r.jobId, { onlyIfWaiting: true })
  await tick()
  assert.deepEqual([tasks.get(r.jobId).state, tasks.get(r.jobId).durationMs], ['stopped', 30_000])
  passes.get('W:write').finish()
  await tick()
})

test('a read task removed while it waits again after reading says it changed nothing, and a restart says the same', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-read-'))
  const file = join(dir, 'tasks.jsonl')
  const { tasks, passes } = readQueue({ file })
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  passes.get('R:read').handBack('it needs the folder')
  await tick()
  assert.equal(tasks.stop(r.jobId, { onlyIfWaiting: true }), 'requested')
  await tick()
  assert.equal(tasks.get(r.jobId).state, 'stopped')
  assert.equal(tasks.get(r.jobId).terminalReason, 'removed from the line after its read pass, before it changed anything')

  const r2 = tasks.enqueue(reader('R2'))
  await tick()
  passes.get('R2:read').handBack('it needs the folder')
  await tick()
  await tasks.flushed()
  const again = readQueue({ file })
  await again.tasks.ready
  assert.equal(again.tasks.get(r2.jobId).state, 'stopped')
  assert.equal(again.tasks.get(r2.jobId).terminalReason, 'the app restarted while this task waited in line again after its read pass, so it changed nothing')
  passes.get('W:write').finish()
  await tick()
})

test('a task keeps the run ids of both its passes through a restart, so no view shows either as a run of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-read-'))
  const file = join(dir, 'tasks.jsonl')
  const { tasks, passes } = readQueue({ file })
  const r = tasks.enqueue(reader('R'))
  await tick()
  passes.get('R:read').handBack('it needs the folder')
  await tick()
  passes.get('R:write').finish()
  await tick()
  await tasks.flushed()
  const again = readQueue({ file })
  await again.tasks.ready
  assert.deepEqual(again.tasks.get(r.jobId).runIds, [`run-${r.jobId}-read`, `run-${r.jobId}-write`])
})

test('a slot a read-only task of the same workspace takes first is counted as that workspace\'s', async () => {
  const lanes = createLanes({ max: 2 })
  const a = await lanes.acquire(laneKey('C:/a'), 'w1')
  const b = await lanes.acquire(laneKey('C:/b'), 'x1')
  const r = lanes.acquire(T.readLaneKey('C:/a', 'r1'), 'r1')
  const w2 = lanes.acquire(laneKey('C:/a'), 'w2')
  await tick()
  const w = lanes.waitOf(laneKey('C:/a'), 'w2')
  assert.deepEqual([w.why, w.slotsAhead, w.slotsAheadHere], ['workspace', 1, 1])
  a(); b()
  ;(await r)(); (await w2)()
})

test('reordering names a read-only task as one with no place in the line, and an empty workspace is no crash', async () => {
  const { tasks, passes, lanes } = readQueue({ max: 1 })
  tasks.enqueue({ ...own, workspace: 'C:/other', task: 'X' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  assert.throws(() => tasks.reorder('C:/w', [r.jobId]), /a read-only task waits for a slot of its own, not in this workspace's line/)
  assert.doesNotThrow(() => lanes.reorder(laneKey('C:/nobody'), []))
  passes.get('X:write').finish()
  await tick()
  passes.get('R:read').finish()
  await tick()
})

test('a task removed after a read pass whose lock check saw files change says so, and keeps no Waiting phase', async () => {
  const { tasks, passes } = readQueue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  const p = passes.get('R:read')
  // route() tells the task of the breach as it hands it back; the hand-back itself follows.
  p.emit({ type: 'access', mode: 'write', from: 'read', why: 'claude said it needs to change files', breach: { changed: ['src/a.ts'], agents: ['claude'] } })
  p.handBack('claude said it needs to change files')
  await tick()
  assert.deepEqual(tasks.get(r.jobId).readBreach, { changed: ['src/a.ts'], agents: ['claude'] })
  assert.equal(tasks.stop(r.jobId, { onlyIfWaiting: true }), 'requested')
  await tick()
  const v = tasks.get(r.jobId)
  assert.equal(v.state, 'stopped')
  assert.equal(v.phase, null, 'a stopped row says nothing of waiting')
  assert.equal(v.terminalReason, 'removed from the line after its read pass, during which src/a.ts changed in this repository while no other run was going on')
  passes.get('W:write').finish()
  await tick()
})

test('route() awaits nothing between the lane letting a run in and the task record saying it started', () => {
  // A Remove is allowed while the record still says waiting: an await there let a Remove through
  // on a task that already held its lane, which then started and ended as stopped by the user.
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const body = index.slice(index.indexOf('async function route('))
  const granted = body.indexOf('const release = laneHeld')
  const entered = body.indexOf('onEntry?.(entry)')
  assert.ok(granted > 0 && entered > granted, 'route() takes its lane, then calls onEntry')
  assert.doesNotMatch(body.slice(body.indexOf('\n', granted), entered), /\bawait\b/)
})

test('a task behind others in its own line is told of another workspace\'s task that arrived before it', async () => {
  // Tasks at once 1: X runs in A, A1 waits behind it, B1 waits for a slot, then A2 joins A. The
  // slots go X, A1, B1, A2, so A2 gets no figure that leaves B1 out.
  const lanes = createLanes({ max: 1 })
  const started = []
  const go = (k, id) => lanes.acquire(laneKey(k), id).then((release) => { started.push(id); return release })
  const x = await go('C:/a', 'x')
  const a1 = go('C:/a', 'a1')
  const b1 = go('C:/b', 'b1')
  const a2 = go('C:/a', 'a2')
  await tick()
  assert.deepEqual([lanes.waitOf(laneKey('C:/a'), 'a1').slotsAhead, lanes.waitOf(laneKey('C:/a'), 'a2').slotsAhead], [0, 1])
  x(); await tick()
  ;(await a1)(); await tick()
  ;(await b1)(); await tick()
  ;(await a2)()
  assert.deepEqual(started, ['x', 'a1', 'b1', 'a2'])
})

test('a task waiting for a slot counts a held workspace\'s earlier waiter ahead of it', async () => {
  // Tasks at once 1: X runs in A and A2 waits behind it, then B1 waits for a slot. X's slot goes to A2.
  const lanes = createLanes({ max: 1 })
  const started = []
  const go = (k, id) => lanes.acquire(k, id).then((release) => { started.push(id); return release })
  const x = await go(laneKey('C:/a'), 'x')
  const a2 = go(laneKey('C:/a'), 'a2')
  const b1 = go(laneKey('C:/b'), 'b1')
  const r = go(T.readLaneKey('C:/c', 'r'), 'r')
  await tick()
  assert.deepEqual([lanes.waitOf(laneKey('C:/b'), 'b1').slot, lanes.waitOf(T.readLaneKey('C:/c', 'r'), 'r').slot], [2, 3])
  x(); await tick()
  ;(await a2)(); await tick()
  ;(await b1)(); await tick()
  ;(await r)()
  assert.deepEqual(started, ['x', 'a2', 'b1', 'r'])
})

test('a run beside another is one in a folder that holds its repository, sits inside it, or is it, at any time while it ran', () => {
  assert.equal(typeof T.createRunLog, 'function')
  const log = T.createRunLog({ sep: '\\' })
  // A folder of projects (not a repository), a repository inside it, and one elsewhere.
  const reader = log.open('c:\\harnessprojects\\foo')
  const elsewhere = log.open('c:\\other')
  assert.equal(log.beside(reader), false, 'a run in another folder is no run beside it')
  const parent = log.open('c:\\harnessprojects')
  log.close(parent)
  assert.equal(log.beside(reader), true, 'a writer in the folder holding it, gone again, still went on while it ran')
  const late = log.open('c:\\harnessprojects\\foobar')
  assert.equal(log.beside(late), false, 'a folder whose name only starts the same is not inside it')
  log.close(late)
  log.close(elsewhere)
  log.close(reader)
  assert.equal(log.size, 0, 'nothing is kept once no run that started before an end goes on')
  // One that ended before it started never went on beside it.
  const before = log.open('c:\\harnessprojects\\foo\\vendor\\lib')
  log.close(before)
  const after = log.open('c:\\harnessprojects\\foo')
  assert.equal(log.beside(after), false)
  const inside = log.open('c:\\harnessprojects\\foo\\vendor\\lib')
  assert.equal(log.beside(after), true, 'a run in a clone inside its repository')
  log.close(inside)
  log.close(after)  // A run whose folder is still being looked up is related to every run until it is known.
  const unknown = log.open()
  const known = log.open('c:\\elsewhere')
  assert.equal(log.beside(known), true)
  log.key(unknown, 'c:\\somewhere')
  assert.equal(log.beside(known), false)
  log.close(unknown)
  log.close(known)
  // A run known by two spellings of its folder (a link on the way) is related through either.
  const linked = log.open(['c:\\harnessprojects\\foo', 'd:\\code\\foo'])
  const holder = log.open('c:\\harnessprojects')
  const target = log.open('d:\\code')
  const apart = log.open(['c:\\other', 'd:\\other'])
  assert.deepEqual([log.beside(holder), log.beside(target), log.beside(apart)], [true, true, false])
  log.close(holder)
  assert.equal(log.beside(linked), true)
  for (const r of [linked, target, apart]) log.close(r)
  // Two worktrees of one repository are sibling folders sharing one git folder.
  const main = log.open('c:\\harnessprojects\\proj', 'c:\\harnessprojects\\proj\\.git')
  const feat = log.open('c:\\harnessprojects\\proj-feat', 'c:\\harnessprojects\\proj\\.git')
  const other = log.open('c:\\harnessprojects\\other', 'c:\\harnessprojects\\other\\.git')
  assert.deepEqual([log.beside(main), log.beside(other)], [true, false])
  for (const r of [main, feat, other]) log.close(r)
})

test('the tasks another workspace\'s line starts first are counted each, not as one line', async () => {
  // Tasks at once 1: H runs in A, x1 then x2 wait in B, then W joins A. The slots go H, x1, x2, W.
  const lanes = createLanes({ max: 1 })
  const started = []
  const go = (k, id) => lanes.acquire(laneKey(k), id).then((release) => { started.push(id); return release })
  const h = await go('C:/a', 'h')
  const x1 = go('C:/b', 'x1')
  const x2 = go('C:/b', 'x2')
  const w = go('C:/a', 'w')
  await tick()
  assert.equal(lanes.waitOf(laneKey('C:/a'), 'w').slotsAhead, 2)
  assert.equal(lanes.waitOf(laneKey('C:/b'), 'x1').slot, 1)
  h(); await tick()
  ;(await x1)(); await tick()
  ;(await x2)(); await tick()
  ;(await w)()
  assert.deepEqual(started, ['h', 'x1', 'x2', 'w'])
})

test('with more than one slot, another line counts once, as only its first task surely starts first', async () => {
  // Tasks at once 2: a0 holds A, w0 holds W, b1 then b2 wait in B, then w waits in W. When a0 ends
  // b1 starts and B is held, so when w0 ends w starts before b2.
  const lanes = createLanes({ max: 2 })
  const started = []
  const go = (k, id) => lanes.acquire(laneKey(k), id).then((release) => { started.push(id); return release })
  const a0 = await go('C:/a', 'a0')
  const w0 = await go('C:/w', 'w0')
  const b1 = go('C:/b', 'b1')
  const b2 = go('C:/b', 'b2')
  const w = go('C:/w', 'w')
  await tick()
  assert.equal(lanes.waitOf(laneKey('C:/w'), 'w').slotsAhead, 1)
  a0(); await tick()
  w0(); await tick()
  ;(await b1)(); await tick()
  ;(await w)(); await tick()
  ;(await b2)()
  assert.deepEqual(started, ['a0', 'w0', 'b1', 'w', 'b2'])
})

test('a section stopped while it waits its turn never runs, and those after it keep their order', async () => {
  const mutex = T.createMutex()
  const ran = []
  let letFirstEnd
  const first = mutex(() => new Promise((r) => { ran.push('first'); letFirstEnd = r }))
  const ac = new AbortController()
  const second = mutex(() => { ran.push('second') }, ac.signal)
  const third = mutex(() => { ran.push('third') })
  await tick()
  ac.abort(new Error('stopped'))
  letFirstEnd()
  const [, s] = await Promise.allSettled([first, second, third])
  assert.equal(s.status, 'rejected', 'the stopped section is refused')
  assert.match(String(s.reason?.message), /stopped/)
  assert.deepEqual(ran, ['first', 'third'])
})

test('a lock check asks after the folder lookups still pending, and a run that starts while it waits does not count', async () => {
  const log = T.createRunLog({ sep: '\\', waitMs: 2000 })
  assert.equal(typeof log.track, 'function')
  const after = (ms, value) => () => new Promise((r) => setTimeout(() => r(value), ms))
  const reader = log.open('c:\\proj\\a')
  // Started a moment before the check, in another repository, its folder still being looked up.
  const x = log.track(after(100, ['c:\\other\\b', null]), 'c:\\other\\b')
  assert.equal(log.beside(reader), true, 'not known yet, so it counts')
  const asked = log.besideNow(reader)
  // One more starts while the check waits: it cannot have written what the check read.
  await new Promise((r) => setTimeout(r, 30))
  const y = log.track(after(1000, ['c:\\third\\c', null]), 'c:\\third\\c')
  assert.equal(await asked, false, 'once known, x is another repository, and y does not count')
  // A lookup that fails keys the run by its own folder, here another one.
  const z = log.track(() => Promise.reject(new Error('git gone')), 'c:\\elsewhere\\z')
  assert.equal(await log.besideNow(reader), false, 'it stayed unknown, so it counted')
  for (const r of [reader, x, y, z]) log.close(r)
})

test('a run in a folder reached through a link is beside one in the folder that holds either spelling of it', async () => {
  assert.equal(typeof T.runKeysOf, 'function')
  const base = mkdtempSync(join(tmpdir(), 'jev-run-keys-'))
  const gitInit = (dir) => { mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: dir }) }
  // A folder of projects moved elsewhere and linked back (a junction on Windows), with a
  // repository inside it.
  gitInit(join(base, 'real', 'projects', 'foo'))
  symlinkSync(join(base, 'real', 'projects'), join(base, 'link'), 'junction')
  // A folder of projects holding a link to a repository kept elsewhere.
  mkdirSync(join(base, 'projects'))
  gitInit(join(base, 'code', 'bar'))
  symlinkSync(join(base, 'code', 'bar'), join(base, 'projects', 'bar'), 'junction')
  mkdirSync(join(base, 'unrelated'))
  const log = T.createRunLog({ sep })
  const run = async (dir) => { const r = log.track(() => T.runKeysOf(dir), T.laneKey(dir)); await r.pending; return r }
  const pairs = [
    [join(base, 'link'), join(base, 'link', 'foo')],
    [join(base, 'real', 'projects'), join(base, 'link', 'foo')],
    [join(base, 'projects'), join(base, 'projects', 'bar')],
    [join(base, 'code'), join(base, 'projects', 'bar')],
  ]
  for (const [outer, inner] of pairs) {
    const writer = await run(outer)
    const reader = await run(inner)
    assert.equal(await log.besideNow(reader), true, `a writer in ${outer} beside a read pass in ${inner}`)
    log.close(writer)
    log.close(reader)
  }
  const writer = await run(join(base, 'unrelated'))
  const reader = await run(join(base, 'projects', 'bar'))
  assert.equal(await log.besideNow(reader), false, 'a folder that holds neither spelling')
  log.close(writer)
  log.close(reader)
})

test('a lock check waits only for the lookups of runs that could have gone on beside it', async () => {
  const log = T.createRunLog({ sep: '\\', waitMs: 3000 })
  assert.equal(typeof log.besideNow, 'function')
  const writer = log.open('c:\\big\\repo')
  // A run whose lookup never ends, gone before the reader started.
  const stuck = log.track(() => new Promise(() => {}), 'c:\\x')
  log.close(stuck)
  const reader = log.open('c:\\proj\\a')
  const t0 = Date.now()
  assert.equal(await log.besideNow(reader), false)
  assert.ok(Date.now() - t0 < 1000, `it did not wait for it (${Date.now() - t0} ms)`)
  log.close(reader)
  log.close(writer)
})


test('Send now starts a read-only task beside the task writing in its folder with a cap of 1, and never lets a second writer into a folder a writer holds', async () => {
  const { tasks, passes, lanes } = readQueue({ max: 1 })
  assert.equal(typeof tasks.startNow, 'function', 'a waiting task can be sent now')
  const w = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  const w2 = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W2' })
  await tick()
  assert.deepEqual([tasks.get(r.jobId).waiting.why, tasks.get(r.jobId).controls.sendNow], ['cap', 'slot'])
  assert.deepEqual([tasks.get(w2.jobId).waiting.why, tasks.get(w2.jobId).controls.sendNow], ['workspace', 'workspace'])
  assert.equal(tasks.startNow(w2.key), 'workspace-busy', 'a second writer is never let into a folder a writer holds')
  assert.equal(tasks.startNow(r.key), 'started')
  await tick()
  assert.ok(passes.has('R:read'), 'the read pass runs beside the writer, locked against writing')
  assert.equal(passes.get('R:read').pass.mode, 'read')
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 0, max: 1 }, 'over the cap of 1')
  assert.equal(tasks.startNow(w2.key), 'workspace-busy')
  passes.get('W:write').finish()
  await tick()
  assert.equal(tasks.get(w2.jobId).waiting.why, 'cap', 'the writer has ended, and the read pass holds the one slot')
  assert.equal(tasks.get(w2.jobId).state, 'queued')
  passes.get('R:read').finish()
  await tick()
  assert.ok(passes.has('W2:write'))
  passes.get('W2:write').finish()
  await tick()
  assert.deepEqual([w, r, w2].map((t) => tasks.get(t.jobId).state), ['completed', 'completed', 'completed'])
})

test('a read-only task steered while it waits reads with the words, and the pass that writes after its read pass hands it back keeps them', async () => {
  const { tasks, passes } = readQueue({ max: 1 })
  assert.equal(typeof tasks.amend, 'function', 'a waiting task can be steered')
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W' })
  await tick()
  const r = tasks.enqueue(reader('R'))
  await tick()
  assert.equal(tasks.amend(r.key, 'and fix the typo it finds'), 'added')
  const amended = 'R\n\nAdded while it waited: and fix the typo it finds'
  passes.get('W:write').finish()
  await tick()
  assert.ok(passes.has(`${amended}:read`), 'the read pass is handed the words')
  assert.equal(passes.get(`${amended}:read`).pass.mode, 'read', 'and still runs locked against writing')
  passes.get(`${amended}:read`).handBack('the person asked for a change, which needs a pass that writes')
  await tick()
  assert.ok(passes.has(`${amended}:write`), 'the pass that writes is handed them too')
  assert.equal(tasks.get(r.jobId).taskText, amended)
  assert.equal(tasks.get(r.jobId).access, 'write')
  passes.get(`${amended}:write`).finish()
  await tick()
  assert.equal(tasks.get(r.jobId).state, 'completed')
})
