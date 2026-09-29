// A read pass (docs/queue-and-cost-findings.md 1): a task the decider judged only reads runs beside
// any task changing its folder, on agents locked against writing, and whenever it cannot do the
// task locked it hands the task to its folder's line. Drives the real routing loop against a
// throwaway git repo with a fake Jev, fake agents and a fake lock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as router from '../router.js'

const { formatReport, runRouted } = router

const config = {
  agents: [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'codex', provider: 'codex', description: 'b', enabled: true },
    { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true },
  ],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 5 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
}

// A repo whose `npm test` leaves a marker behind, so a check that ran is seen.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-read-pass-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('checks-ran.txt','x')\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const history = () => { const rows = []; return { rows, recent: async () => [], append: async (r) => { rows.push(r) } } }
const routeResult = (over = {}) => ({
  primaryAgent: 'claude', agentConfidence: 0.8, agentProbabilities: { claude: 0.8, codex: 0.1, deepseek: 0.1 },
  taskType: 'explanation', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2,
  needsSecondOpinion: 0.1, needsHumanReview: 0.1, needsTests: 0.9, capability: 'project_read', capabilityConfidence: 0.9, ...over,
})
const signal = new AbortController().signal
const VERDICT = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
const READ = { mode: 'read', verdict: VERDICT }
// Claude locks by plan mode and DeepSeek by its read tools; Codex never locks.
const LOCKS = {
  claude: { lock: { how: 'Claude Code plan mode', provider: 'claude-code-readonly' } },
  deepseek: { lock: { how: 'read tools only (read, glob, grep)', toolFilter: { allow: ['read', 'glob', 'grep'] } } },
  codex: { lock: null, why: 'Codex cannot be locked through its provider' },
}
const lockOf = (only = null) => (a) => (!only || only.includes(a.id) ? LOCKS[a.id] : { lock: null, why: `${a.id} is not lockable in this test` })

/** A read pass with a spy on everything it must and must not do. */
function readRun({ dir = repo(), route = routeResult(), execute, deps = {}, cfg = config, task = 'how does the parser work?', access = READ, answerOnly = false, signal: stop = signal } = {}) {
  const seen = []
  const events = []
  const h = history()
  let assessed = 0
  const jev = { route: async () => route, assess: async () => { assessed++; return {} } }
  const run = runRouted({
    task, cwd: dir, config: cfg, signal: stop, access, answerOnly,
    deps: {
      jev, history: h, lockOf: lockOf(), emit: (e) => events.push(e),
      execute: async (a, prompt, sig, opts) => { seen.push({ id: a.id, prompt, opts }); return execute ? execute(a, prompt, opts) : { stopReason: 'completed', answerText: 'the parser reads tokens in order' } },
      ...deps,
    },
  })
  return { run, dir, seen, events, rows: h.rows, assessed: () => assessed }
}

const needsLane = (re) => (err) => { assert.equal(err.code, 'NEEDS_LANE', `not a hand-back: ${err.message}`); assert.match(err.message, re); return true }

test('a read pass starts every agent locked and runs no baseline, checks or review, ending answered', async () => {
  const { run, dir, seen, events, assessed } = readRun()
  const r = await run
  assert.equal(r.finalStatus, 'answered')
  assert.equal(existsSync(join(dir, 'checks-ran.txt')), false, 'a project check ran')
  assert.ok(!events.some((e) => e.type === 'checks'), 'a baseline was taken')
  assert.equal(assessed(), 0, 'the answer was sent to review')
  assert.deepEqual(seen.map((s) => [s.id, s.opts.locked]), [['claude', true]])
  assert.deepEqual(r.attempts[0].changedFiles, [])
  assert.equal(r.attempts[0].locked, true)
  assert.equal(r.access.mode, 'read')
  assert.deepEqual(r.access.lock, { claude: 'Claude Code plan mode' })
  assert.ok(events.some((e) => e.type === 'access' && e.mode === 'read' && e.verdict?.p === 0.93), 'the read line was not emitted')
})

test('a read pass neither reads, continues, writes nor archives the handoff note, not even at a usage limit, and never touches .git/info/exclude', async () => {
  const dir = repo()
  mkdirSync(join(dir, '.kz-harness'), { recursive: true })
  const note = join(dir, '.kz-harness', 'handoff.md')
  writeFileSync(note, '## Done\nA writer is halfway through: secret-marker-7731\n')
  const exclude = join(dir, '.git', 'info', 'exclude')
  const excludeBefore = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null
  const noteMtime = statSync(note).mtimeMs
  let n = 0
  const { run, seen } = readRun({
    dir, task: 'continue the explanation of the parser', route: routeResult({ continueHandoff: 0.99 }),
    execute: () => (++n === 1 ? { stopReason: 'error', diagnostic: 'usage limit reached', answerText: '' } : { stopReason: 'completed', answerText: 'it reads tokens' }),
    deps: { isLimitError: (a, res) => ({ hit: /usage limit/.test(res.diagnostic ?? '') }) },
  })
  const r = await run
  assert.equal(r.finalStatus, 'answered')
  assert.deepEqual(seen.map((s) => s.id), ['claude', 'deepseek'], 'the hand-over at the limit went to the other locked agent')
  for (const s of seen) {
    assert.doesNotMatch(s.prompt, /secret-marker-7731/, 'the note was read into a prompt')
    assert.doesNotMatch(s.prompt, /handoff/i, 'a prompt asks for the note')
  }
  assert.equal(r.continuedFromHandoff, false)
  assert.equal(readFileSync(note, 'utf8'), '## Done\nA writer is halfway through: secret-marker-7731\n', 'the note was rewritten')
  assert.equal(statSync(note).mtimeMs, noteMtime)
  assert.deepEqual(readdirSync(join(dir, '.kz-harness')), ['handoff.md'], 'the note was archived')
  assert.equal(existsSync(exclude) ? readFileSync(exclude, 'utf8') : null, excludeBefore, '.git/info/exclude was written')
})

test('a read pass is credited with no file another task changes meanwhile, and its lock check says it could not measure', async () => {
  const breaches = []
  const dir = repo()
  const { run } = readRun({
    dir,
    // The task writing beside it changes state.txt while the locked agent reads.
    execute: () => { writeFileSync(join(dir, 'state.txt'), 'the writer\'s unfinished edit'); return { stopReason: 'completed', answerText: 'read it' } },
    deps: { besideOther: () => true, onLockBreach: (ids, files) => breaches.push({ ids, files }) },
  })
  const r = await run
  assert.deepEqual(r.attempts[0].changedFiles, [])
  assert.deepEqual(r.access.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  assert.equal(r.access.besideOther, true)
  assert.deepEqual(breaches, [])
  assert.match(formatReport(r), /Lock check: not measured: another run was going on in this repository at the same time, so a change there cannot be told from one this run made, and what it read may include that run's unfinished edits/)
})

test('a read pass whose routing names project_change, document_processing, web_research or other hands the task to its folder\'s line before any agent runs', async () => {
  const cases = [
    ['project_change', /Jev's routing named project_change \(90%\), which may change files/],
    ['document_processing', /Jev's routing named document_processing \(90%\), which may change files/],
    ['web_research', /Jev's routing named web_research \(90%\), and no locked agent is known to reach the web/],
    ['other', /Jev's routing could not name what it needs \(other\), and unsure means it may write/],
  ]
  for (const [capability, re] of cases) {
    const { run, seen, rows } = readRun({ route: routeResult({ capability }) })
    await assert.rejects(run, needsLane(re))
    assert.deepEqual(seen, [], `${capability}: an agent ran`)
    assert.deepEqual(rows, [], `${capability}: a pass that ran no agent wrote a history row`)
  }
})

test('a read pass whose worker cannot be locked hands the task to the line, naming the agent and why', async () => {
  const { run, seen } = readRun({ route: routeResult({ primaryAgent: 'codex', agentProbabilities: { codex: 0.8, claude: 0.1, deepseek: 0.1 } }) })
  await assert.rejects(run, needsLane(/^codex, the agent picked for it, cannot be locked against writing: Codex cannot be locked through its provider$/))
  assert.deepEqual(seen, [])
})

test('with no ready agent that can be locked, a read pass hands the task to the line before the decider is asked', async () => {
  let asked = 0
  const { run, seen } = readRun({
    deps: {
      jev: { route: async () => { asked++; return routeResult() }, assess: async () => ({}) },
      lockOf: lockOf(['deepseek']),
      ready: { deepseek: { loggedIn: false, detail: 'no key' } },
    },
  })
  await assert.rejects(run, needsLane(/^no agent that can run now can be locked against writing \(claude: claude is not lockable in this test; codex: codex is not lockable in this test; deepseek: not signed in\)$/))
  assert.equal(asked, 0, 'the decider was asked')
  assert.deepEqual(seen, [])
})

test('a locked agent that writes NEEDS-WRITE-ACCESS on a line of its own hands the task to the line, after its run is recorded as needs_write', async () => {
  const { run, rows } = readRun({ execute: () => ({ stopReason: 'completed', answerText: 'NEEDS-WRITE-ACCESS\nThe parser has to change: src/parse.js keeps the old grammar.' }) })
  let caught = null
  await assert.rejects(run, (err) => { caught = err; return needsLane(/^claude said it needs to change files: The parser has to change: src\/parse\.js keeps the old grammar\.$/)(err) })
  assert.equal(caught.readPass.agent, 'claude')
  assert.equal(typeof caught.readPass.runId, 'string')
  assert.equal(typeof caught.readPass.durationMs, 'number')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].finalStatus, 'needs_write')
  assert.equal(rows[0].access.mode, 'read')
  assert.equal(rows[0].runId, caught.readPass.runId)
  // Quoting the marker mid-sentence is still an answer.
  const quoted = readRun({ execute: () => ({ stopReason: 'completed', answerText: 'It never needs NEEDS-WRITE-ACCESS for this.' }) })
  assert.equal((await quoted.run).finalStatus, 'answered')
})

test('retries, hand-overs at a limit and a parallel second opinion in a read pass go only to agents that can be locked, and with none left the task goes to the line', async () => {
  // A retry: Codex ranks first among the others, but only DeepSeek can be locked.
  let n = 0
  const retry = readRun({ execute: () => (++n === 1 ? { stopReason: 'error', diagnostic: 'crashed', answerText: '' } : { stopReason: 'completed', answerText: 'ok' }) })
  assert.equal((await retry.run).finalStatus, 'answered')
  assert.deepEqual(retry.seen.map((s) => [s.id, s.opts.locked]), [['claude', true], ['deepseek', true]])

  // The strategy's own hand-over order names Codex first: it is passed over for the locked agent.
  let m = 0
  const ordered = readRun({
    execute: () => (++m === 1 ? { stopReason: 'error', diagnostic: 'crashed', answerText: '' } : { stopReason: 'completed', answerText: 'ok' }),
    deps: {
      decide: async () => ({ routing: routeResult(), plan: { strategy: 'STANDARD_DIRECT', steps: [{ role: 'primary', agent: 'claude' }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: null, fallbackOrder: ['codex', 'deepseek'], notes: [] } }),
      review: async () => ({ status: 'accepted', action: 'accept' }),
    },
  })
  assert.equal((await ordered.run).finalStatus, 'answered')
  assert.deepEqual(ordered.seen.map((s) => s.id), ['claude', 'deepseek'])

  // A parallel second opinion the plan gave to Codex is not started unlocked.
  const decide = async () => ({
    routing: { ...routeResult({ primaryAgent: 'deepseek', agentProbabilities: { deepseek: 0.9 } }), strategy: 'PARALLEL_SECOND_OPINION' },
    plan: { strategy: 'PARALLEL_SECOND_OPINION', steps: [{ role: 'primary', agent: 'deepseek' }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: 'codex', fallbackOrder: [], notes: [] },
  })
  const opinion = readRun({ deps: { decide, review: async () => ({ status: 'accepted', action: 'accept' }) } })
  await opinion.run
  assert.ok(!opinion.seen.some((s) => s.id === 'codex'), 'Codex was started in a read pass')
  assert.ok(opinion.seen.every((s) => s.opts.locked === true))

  // At a usage limit with nobody locked left: the line, not a pause with a handoff note.
  const alone = readRun({
    execute: () => ({ stopReason: 'error', diagnostic: 'usage limit reached', answerText: '' }),
    deps: { lockOf: lockOf(['claude']), isLimitError: () => ({ hit: true }) },
  })
  await assert.rejects(alone.run, needsLane(/^no other agent that can be locked is left to try/))
  assert.deepEqual(alone.seen.map((s) => s.id), ['claude'])
  assert.equal(alone.rows[0].finalStatus, 'needs_write')
  assert.equal(existsSync(join(alone.dir, '.kz-harness', 'handoff.md')), false, 'a handoff note was written')
})

test('a read pass offers no tool, and its prompt says it is locked, gives the marker, and never mentions the handoff note', async () => {
  let offered = null
  const tools = [{ id: 'weather', description: 'weather lookup', command: 'x', params: {} }]
  const { run, seen } = readRun({
    cfg: { ...config, tools },
    deps: { jev: { route: async (args) => { offered = args.tools.map((t) => t.id); return routeResult() }, assess: async () => ({}) } },
  })
  await run
  assert.deepEqual(offered, [])
  const prompt = seen[0].prompt
  assert.match(prompt, /^how does the parser work\?/)
  assert.match(prompt, /Read only inside this workspace\./)
  assert.match(prompt, /This run is locked to reading: you cannot create, change or delete any file here, or run a command\. Another agent may be changing files in this folder while you read\./)
  assert.match(prompt, /write NEEDS-WRITE-ACCESS on a line of its own/)
  assert.match(prompt, /say which files you read and how you checked what you say/)
  assert.doesNotMatch(prompt, /handoff/i)
  assert.doesNotMatch(prompt, /usage limit/i)
})

test('files changed during a read pass with no task changing the folder raise a warning and report the breach', async () => {
  const breaches = []
  const dir = repo()
  const { run, events } = readRun({
    dir,
    execute: () => { writeFileSync(join(dir, 'state.txt'), 'written through the lock'); return { stopReason: 'completed', answerText: 'read it' } },
    deps: { besideOther: () => false, onLockBreach: (ids, files) => breaches.push({ ids, files }) },
  })
  const r = await run
  assert.deepEqual(r.attempts[0].changedFiles, [], 'the breach is not credited to the run as its work')
  assert.deepEqual(r.access.lockCheck, { measured: true, changed: ['state.txt'] })
  assert.deepEqual(breaches, [{ ids: ['claude'], files: ['state.txt'] }])
  assert.ok(events.some((e) => e.type === 'error' && /files changed while a locked run read this folder: state\.txt/.test(e.message)))
  assert.match(formatReport(r), /Warning: state\.txt changed in this repository while this locked run was reading and no other run was going on in it\. Either you edited it, or the lock on claude did not hold; claude takes no read-only work until the harness restarts\./)

  // A commit leaves `git status` clean: the moved HEAD is the breach.
  const committed = []
  const dir2 = repo()
  const c = readRun({
    dir: dir2,
    execute: () => {
      writeFileSync(join(dir2, 'new.txt'), 'x')
      execFileSync('git', ['add', '-A'], { cwd: dir2 }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'sneaky'], { cwd: dir2 })
      return { stopReason: 'completed', answerText: 'read it' }
    },
    deps: { besideOther: () => false, onLockBreach: (ids, files) => committed.push(files) },
  })
  const r2 = await c.run
  assert.equal(r2.access.lockCheck.measured, true)
  assert.match(r2.access.lockCheck.changed.join(', '), /^HEAD \(moved from [0-9a-f]{7} to [0-9a-f]{7}\)$/)
  assert.equal(committed.length, 1)
})

test('an agent that cannot be started locked hands the task to the line', async () => {
  const breaches = []
  const { run, rows } = readRun({
    execute: () => { throw Object.assign(new Error('its child could still see write, bash'), { code: 'LOCK_UNAVAILABLE' }) },
    deps: { besideOther: () => false, onLockBreach: (ids, files) => breaches.push({ ids, files }) },
  })
  await assert.rejects(run, needsLane(/^claude could not be started locked: its child could still see write, bash$/))
  assert.equal(rows[0].finalStatus, 'needs_write')
  assert.deepEqual([rows[0].attempts[0].notStarted, rows[0].attempts[0].lockLost], [true, true])
  assert.equal(rows[0].attempts[0].locked, undefined, 'an agent that never started is not recorded as having run locked')
  assert.deepEqual(breaches, [])
})

test('the report says who judged it read only with the bar, what locked the agent and what the lock check measured; a writer pass says why it needed the folder', async () => {
  const { run } = readRun({ deps: { besideOther: () => false } })
  const r = await run
  const report = formatReport(r)
  assert.match(report, /- Read only: Jev judged it only reads the project \(93%, bar 80%\); claude ran locked \(Claude Code plan mode\)\n/)
  assert.match(report, /- Lock check: nothing changed in this repository while it ran \(measured over the files git lists as changed or untracked, HEAD, \.git\/config and its hooks folder when that is in the repository; ignored files are not checked\)/)
  assert.match(report, /Changed files: none \(locked against writing\)/)

  assert.equal(typeof router.accessLines, 'function')
  const handedBack = { access: { mode: 'write', verdict: VERDICT, from: 'read', why: 'claude said it needs to change files: the parser', readPass: { agent: 'claude', durationMs: 41_000 } } }
  assert.deepEqual(router.accessLines(handedBack), ['- Judged read only (Jev 93%, bar 80%), then needed the folder: claude said it needs to change files: the parser; claude read for 41 s first, locked'])
  // What the read pass's own lock check came to goes with it.
  const measured = { access: { ...handedBack.access, readPass: { ...handedBack.access.readPass, lockCheck: { measured: true, changed: [] } } } }
  assert.equal(router.accessLines(measured)[1], "- Its read pass's lock check: nothing changed in this repository while it ran (measured over the files git lists as changed or untracked, HEAD, .git/config and its hooks folder when that is in the repository; ignored files are not checked)")
  const unmeasured = { access: { ...handedBack.access, readPass: { ...handedBack.access.readPass, lockCheck: { measured: false, reason: 'not a git repository' } } } }
  assert.equal(router.accessLines(unmeasured)[1], "- Its read pass's lock check: not measured: not a git repository")
  const noLock = { access: { mode: 'write', verdict: VERDICT, why: 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)' } }
  assert.deepEqual(router.accessLines(noLock), ['- Judged read only (Jev 93%, bar 80%), but ran as work that writes: no agent here can be locked against writing (codex: Codex cannot be locked through its provider)'])
  assert.deepEqual(router.accessLines({ access: { mode: 'write', verdict: { ...VERDICT, p: 0.4, reads: false } } }), [])
  assert.deepEqual(router.accessLines({}), [])

  // A writer pass after a hand-back records why, and runs as work that writes.
  const dir = repo()
  const h = history()
  const jev = { route: async () => routeResult({ capability: 'project_change' }), assess: async () => ({}) }
  const w = await runRouted({
    task: 'fix the parser', cwd: dir, config, signal,
    access: { mode: 'write', verdict: VERDICT, from: { why: 'claude said it needs to change files: the parser', readPass: { runId: 'r1', agent: 'claude', durationMs: 41_000 } } },
    deps: { jev, history: h, lockOf: lockOf(), review: async () => ({ status: 'accepted', action: 'accept' }), execute: async (a, p, s, opts) => { assert.equal(opts.locked, undefined); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'fixed' } } },
  })
  assert.deepEqual(w.attempts[0].changedFiles, ['state.txt'])
  assert.deepEqual(w.access, { mode: 'write', verdict: VERDICT, from: 'read', why: 'claude said it needs to change files: the parser', readPass: { runId: 'r1', agent: 'claude', durationMs: 41_000 } })
  assert.match(formatReport(w), /Judged read only \(Jev 93%, bar 80%\), then needed the folder: claude said it needs to change files: the parser; claude read for 41 s first, locked/)
})

const parallel = (primary, opinion) => async () => ({
  routing: { ...routeResult({ primaryAgent: primary, agentProbabilities: { [primary]: 0.9 } }), strategy: 'PARALLEL_SECOND_OPINION' },
  plan: { strategy: 'PARALLEL_SECOND_OPINION', steps: [{ role: 'primary', agent: primary }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: opinion, fallbackOrder: [], notes: [] },
})

test('a primary that cannot be started locked stops its parallel opinion and waits for it before the task goes to the line', async () => {
  let opinionEnded = false
  let settled = false
  const { run, rows } = readRun({
    deps: {
      decide: parallel('deepseek', 'claude'),
      execute: async (a, prompt, sig) => {
        if (a.id === 'deepseek') { await new Promise((r) => setTimeout(r, 20)); throw Object.assign(new Error('its child could still see write'), { code: 'LOCK_UNAVAILABLE' }) }
        // The opinion works until it is stopped, or gives up after a while so nothing hangs.
        const stopped = await new Promise((r) => {
          const timer = setTimeout(() => r(false), 3000)
          sig.addEventListener('abort', () => { clearTimeout(timer); r(true) }, { once: true })
        })
        opinionEnded = stopped && !settled
        return { stopReason: 'error', diagnostic: 'stopped', answerText: '' }
      },
    },
  })
  await assert.rejects(run.finally(() => { settled = true }), needsLane(/^deepseek could not be started locked: its child could still see write$/))
  assert.equal(opinionEnded, true, 'the opinion was left running after the pass ended')
  const opinion = rows[0].attempts.find((a) => a.role === 'opinion')
  assert.ok(opinion, 'the opinion is on the record')
  assert.equal(opinion.locked, true, 'it did run, locked')
})

test('an opinion stopped because its primary could not be started locked is not given the primary\'s lock refusal', async () => {
  // The opinion started locked and works until it is stopped; its engine then rejects with the
  // reason it was stopped with, as the engine's subagents do.
  const { run, rows } = readRun({
    deps: {
      decide: parallel('deepseek', 'claude'),
      execute: async (a, prompt, sig, opts) => {
        if (a.id === 'deepseek') { await new Promise((r) => setTimeout(r, 20)); throw Object.assign(new Error('its child could still see write'), { code: 'LOCK_UNAVAILABLE' }) }
        opts.onStarted?.()
        await new Promise((r) => { const t = setTimeout(r, 3000); sig.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
        sig.throwIfAborted()
        return { stopReason: 'completed', answerText: 'too late' }
      },
    },
  })
  await assert.rejects(run, needsLane(/^deepseek could not be started locked: its child could still see write$/))
  const opinion = rows[0].attempts.find((a) => a.role === 'opinion')
  assert.deepEqual([opinion.cutOff, opinion.diagnostic, opinion.locked, opinion.lockLost, opinion.notStarted], [true, 'stopped when deepseek broke off', true, undefined, undefined])
  assert.deepEqual(rows[0].access.lock, { claude: 'Claude Code plan mode' })
  const report = formatReport(rows[0])
  assert.match(report, /claude \(opinion\): error in \d+s, stopped when deepseek broke off\n\s+Changed files: none \(locked against writing\)/)
})

test('a parallel opinion that could not be started locked is not said to have run locked, and is never blamed for a breach', async () => {
  const breaches = []
  const dir = repo()
  const { run } = readRun({
    dir,
    deps: {
      decide: parallel('claude', 'deepseek'),
      besideOther: () => false,
      onLockBreach: (ids, files) => breaches.push({ ids, files }),
      execute: async (a) => {
        if (a.id === 'deepseek') throw Object.assign(new Error('no read tool is mounted for it'), { code: 'LOCK_UNAVAILABLE' })
        writeFileSync(join(dir, 'state.txt'), 'through the lock')
        return { stopReason: 'completed', answerText: 'read it' }
      },
    },
  })
  const r = await run
  const opinion = r.attempts.find((a) => a.role === 'opinion')
  assert.ok(opinion, 'the opinion is on the record')
  assert.deepEqual([opinion.notStarted, opinion.locked], [true, undefined])
  assert.deepEqual(Object.keys(r.access.lock), ['claude'])
  assert.deepEqual(breaches.map((b) => b.ids), [['claude']])
})

test('a hand-back names the agent that read, with its own time, and none when no agent read', async () => {
  const marked = readRun({ execute: () => ({ stopReason: 'completed', answerText: '**NEEDS-WRITE-ACCESS**\nThe parser must change.' }) })
  let err = null
  await assert.rejects(marked.run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.equal(err.message, 'claude said it needs to change files: The parser must change.', 'the marker in bold still counts')
  assert.equal(err.readPass.agent, 'claude')
  assert.equal(err.readPass.durationMs, marked.rows[0].attempts[0].durationMs)
  const lost = readRun({ execute: () => { throw Object.assign(new Error('its child could still see write'), { code: 'LOCK_UNAVAILABLE' }) } })
  await assert.rejects(lost.run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.deepEqual([err.readPass.agent, err.readPass.durationMs], [null, null])
  const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
  assert.deepEqual(router.accessLines({ access: { mode: 'write', verdict, from: 'read', why: err.message, readPass: err.readPass } }),
    ['- Judged read only (Jev 93%, bar 80%), then needed the folder: claude could not be started locked: its child could still see write'], 'it read nothing, so it says nothing of reading')
})

test('after a measured breach the report never says the lock held, and names every locked agent in agreement', () => {
  const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
  const r = {
    routing: { mode: 'manual', primaryAgent: 'claude' }, baseline: [], assessments: [], finalStatus: 'answered',
    attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', durationMs: 1000, changedFiles: [], locked: true }, { agent: 'deepseek', role: 'opinion', stopReason: 'completed', durationMs: 1000, changedFiles: [], locked: true }],
    access: { mode: 'read', verdict, lock: { claude: 'Claude Code plan mode', deepseek: 'read tools only (read, glob, grep)' }, besideOther: false, lockCheck: { measured: true, changed: ['src/a.ts'] } },
  }
  const report = formatReport(r)
  assert.doesNotMatch(report, /could not change files/)
  assert.doesNotMatch(report, /none \(locked against writing\)/)
  assert.match(report, /Changed files: none credited to it \(it ran locked; see the warning above\)/)
  assert.match(report, /the lock on claude and deepseek did not hold; claude and deepseek take no read-only work until the harness restarts\./)
})

test('a read pass the person stops still runs its lock check on every agent it started locked', async () => {
  const breaches = []
  const dir = repo()
  const ac = new AbortController()
  const h = history()
  const run = runRouted({
    task: 'how does the parser work?', cwd: dir, config, signal: ac.signal, access: READ,
    deps: {
      jev: { route: async () => routeResult(), assess: async () => ({}) }, history: h, lockOf: lockOf(),
      besideOther: () => false, onLockBreach: (ids, files) => breaches.push({ ids, files }),
      execute: async (a, prompt, sig, opts) => {
        opts.onStarted?.()
        // The lock does not hold; the person sees the edit and presses Stop.
        writeFileSync(join(dir, 'state.txt'), 'written through the lock')
        ac.abort(new Error('stopped by the user'))
        throw new Error('aborted')
      },
    },
  })
  await assert.rejects(run)
  assert.equal(h.rows[0].finalStatus, 'stopped')
  assert.deepEqual(h.rows[0].access.lockCheck, { measured: true, changed: ['state.txt'] })
  assert.deepEqual(breaches, [{ ids: ['claude'], files: ['state.txt'] }])
})

test('a lock check that cannot see inside a changed path says it could not measure', async () => {
  const dir = repo()
  // An untracked nested repository: git reports it as one path, and cannot hash or look into it.
  const nested = join(dir, 'vendor')
  mkdirSync(nested)
  execFileSync('git', ['init', '-q'], { cwd: nested })
  writeFileSync(join(nested, 'x.txt'), 'x')
  const { run } = readRun({ dir, deps: { besideOther: () => false } })
  const r = await run
  assert.equal(r.access.lockCheck.measured, false)
  assert.match(r.access.lockCheck.reason, /^git cannot see inside vendor\/, so a change there would not show$/)
})

test('a breach measured before a hand-back goes with the task, and the writer\'s report names it', async () => {
  const breaches = []
  const dir = repo()
  const { run } = readRun({
    dir,
    execute: () => { writeFileSync(join(dir, 'state.txt'), 'stashed away'); return { stopReason: 'completed', answerText: 'NEEDS-WRITE-ACCESS\nA file has to be created.' } },
    deps: { besideOther: () => false, onLockBreach: (ids, files) => breaches.push(files) },
  })
  let err = null
  await assert.rejects(run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.deepEqual(err.readPass.breach, { changed: ['state.txt'], agents: ['claude'] })
  assert.equal(breaches.length, 1)
  const lines = router.accessLines({ access: { mode: 'write', verdict: VERDICT, from: 'read', why: err.message, readPass: err.readPass } })
  assert.match(lines[1], /^- Warning: state\.txt changed in this repository while the read pass before this run was reading and no other run was going on\. Either you edited it, or the lock on claude did not hold; claude takes no read-only work until the harness restarts\. This run started from those changes\.$/)
})

test('a parallel opinion stopped before its child existed is recorded as never started', async () => {
  const { run } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => {
        if (a.id === 'deepseek') throw Object.assign(new Error('stopped before deepseek started: aborted'), { notStarted: true })
        return { stopReason: 'completed', answerText: 'read it' }
      },
    },
  })
  const r = await run
  const opinion = r.attempts.find((a) => a.role === 'opinion')
  assert.ok(opinion, 'the opinion is on the record')
  assert.deepEqual([opinion.notStarted, opinion.lockLost, opinion.locked], [true, undefined, undefined])
  assert.deepEqual(Object.keys(r.access.lock), ['claude'])
  // Stopped first, not refused its lock, and the report says which.
  assert.match(formatReport(r), /deepseek \(opinion\)[^\n]*\n(?:[^\n]*\n)*?\s+Changed files: none \(it was stopped before it started\)/)
  assert.doesNotMatch(formatReport(r), /could not be started locked/)
})

test('a parallel opinion its primary\'s break-off stopped has not tried the task, so a read pass still asks it', async () => {
  // The primary's agent fails outright, or throws at its usage limit; either way it stops the
  // opinion before its child exists.
  for (const failure of ['claude process exited with code 1', 'Claude AI usage limit reached']) {
    let opinions = 0
    const seen = []
    const { run } = readRun({
      deps: {
        decide: parallel('claude', 'deepseek'),
        execute: async (a, prompt, sig, opts) => {
          seen.push([a.id, opts.locked])
          if (a.id === 'claude') { await new Promise((r) => setTimeout(r, 20)); throw new Error(failure) }
          if (++opinions === 1) {
            await new Promise((r) => { const t = setTimeout(r, 3000); sig.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
            throw Object.assign(new Error('stopped before deepseek started: aborted'), { notStarted: true })
          }
          return { stopReason: 'completed', answerText: 'the parser reads tokens in order' }
        },
      },
    })
    const r = await run.catch((err) => err)
    assert.equal(r.finalStatus, 'answered', `${failure}: ${r.message}`)
    assert.deepEqual(seen, [['claude', true], ['deepseek', true], ['deepseek', true]], failure)
    const opinion = r.attempts.find((a) => a.role === 'opinion')
    assert.deepEqual([opinion.cutOff, opinion.diagnostic], [true, 'stopped when claude broke off'], failure)
    const answer = r.attempts.at(-1)
    assert.deepEqual([answer.agent, answer.role, answer.locked], ['deepseek', 'retry', true], failure)
    assert.match(formatReport(r), /deepseek \(opinion\): error in \d+s, stopped when claude broke off/)
  }
})

test('an opinion whose own result is in, or that was refused its own lock, is not said to be stopped by its primary\'s break-off', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // Its result is in (onEnded) and its process is still being ended when the primary breaks off:
  // a complete answer is the run's, and a failed one counts as tried, so it is not asked again.
  for (const own of [{ stopReason: 'completed', answerText: 'the parser reads tokens in order' }, { stopReason: 'error', diagnostic: 'HTTP 500 from the provider', answerText: '' }]) {
    const seen = []
    const { run } = readRun({
      deps: {
        decide: parallel('claude', 'deepseek'),
        execute: async (a, prompt, sig, opts) => {
          seen.push(a.id)
          if (a.id === 'claude') { await sleep(30); throw new Error('claude process exited with code 1') }
          await sleep(10)
          opts.onEnded?.()
          await sleep(60)
          return own
        },
      },
    })
    const r = await run.catch((err) => err)
    const opinion = r.attempts?.find((a) => a.role === 'opinion')
    if (own.stopReason === 'completed') {
      assert.equal(r.finalStatus, 'answered', r.message)
      assert.deepEqual([opinion.cutOff, opinion.diagnostic, opinion.answered], [undefined, undefined, true])
      assert.doesNotMatch(formatReport(r), /stopped when/)
    } else {
      assert.equal(r.code, 'NEEDS_LANE', `deepseek was asked again: ${JSON.stringify(seen)}`)
      assert.match(r.message, /no other agent that can be locked is left to try/)
      assert.deepEqual(seen, ['claude', 'deepseek'])
    }
  }
  // Both refused their locks in the same moment: the opinion's own refusal stands.
  const { run, rows } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => { await null; throw Object.assign(new Error(`${a.id}: its child could still see write`), { code: 'LOCK_UNAVAILABLE' }) },
    },
  })
  const err = await run.catch((e) => e)
  assert.equal(err.code, 'NEEDS_LANE', err.message)
  const opinion = rows[0]?.attempts.find((a) => a.role === 'opinion')
  assert.ok(opinion, 'the opinion is on the record')
  assert.deepEqual([opinion.cutOff, opinion.lockLost], [undefined, true])
  assert.match(opinion.diagnostic, /deepseek: its child could still see write/)
})

test('an opinion its primary\'s break-off stopped uses up no attempt, so a read pass still has one for it', async () => {
  // deepseek hits its limit and goes on with its next key, which fails outright; claude, whose
  // opinion the first break-off stopped, is the third attempt and answers.
  const seen = []
  let deepseekRuns = 0
  const { run } = readRun({
    deps: {
      decide: parallel('deepseek', 'claude'),
      onLimit: async () => ({ rotated: true }),
      execute: async (a, prompt, sig) => {
        seen.push(a.id)
        if (a.id === 'deepseek') { await new Promise((r) => setTimeout(r, 20)); if (++deepseekRuns === 1) throw new Error('usage limit reached'); return { stopReason: 'error', diagnostic: 'the model gave up', answerText: '' } }
        if (seen.filter((id) => id === 'claude').length === 1) {
          await new Promise((r) => { const t = setTimeout(r, 3000); sig.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
          throw Object.assign(new Error('stopped before claude started: aborted'), { notStarted: true })
        }
        return { stopReason: 'completed', answerText: 'the parser reads tokens in order' }
      },
    },
  })
  const r = await run.catch((err) => err)
  assert.equal(r.finalStatus, 'answered', `${r.message ?? r.statusReason}: ${JSON.stringify(seen)}`)
  assert.deepEqual(seen, ['deepseek', 'claude', 'deepseek', 'claude'])
  assert.deepEqual(r.attempts.map((a) => [a.agent, a.role, !!a.cutOff]), [['deepseek', 'primary', false], ['claude', 'opinion', true], ['deepseek', 'retry', false], ['claude', 'retry', false]])
})

test('a primary refused its lock after its opinion answered in full gives way to that answer; a failed opinion is named as the one that read', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (const own of [{ stopReason: 'completed', answerText: 'the parser reads tokens in order, from src/parse.ts' }, { stopReason: 'error', diagnostic: 'HTTP 500 from the provider', answerText: '' }]) {
    const { run, rows } = readRun({
      deps: {
        decide: parallel('claude', 'deepseek'),
        execute: async (a, prompt, sig, opts) => {
          if (a.id === 'claude') { await sleep(100); throw Object.assign(new Error('could not start claude locked: spawn failed'), { code: 'LOCK_UNAVAILABLE' }) }
          opts.onStarted?.()
          await sleep(10)
          opts.onEnded?.()
          return own
        },
      },
    })
    const r = await run.catch((err) => err)
    const opinion = rows[0].attempts.find((a) => a.role === 'opinion')
    if (own.stopReason === 'completed') {
      assert.equal(r.finalStatus, 'answered', r.message)
      assert.equal(opinion.answered, true)
      assert.match(formatReport(r), /the answer below is the second opinion from deepseek/)
    } else {
      assert.equal(r.code, 'NEEDS_LANE', r.message)
      assert.match(r.message, /^claude could not be started locked: /)
      assert.equal(r.readPass.agent, 'deepseek', 'the agent that read, locked')
    }
  }
})

test('each of two parallel attempts is timed to its own end, whichever ends first', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (const [primaryMs, opinionMs] of [[500, 20], [20, 500]]) {
    const { run } = readRun({
      deps: {
        decide: parallel('claude', 'deepseek'),
        execute: async (a) => {
          if (a.id === 'claude') { await sleep(primaryMs); return { stopReason: 'error', diagnostic: 'gave up', answerText: '' } }
          await sleep(opinionMs)
          return { stopReason: 'completed', answerText: 'the parser reads tokens in order' }
        },
      },
    })
    const r = await run
    const [primary, opinion] = r.attempts
    const own = (a, ms) => (ms > 100 ? a.durationMs >= ms - 20 : a.durationMs < 400)
    assert.ok(own(primary, primaryMs), `the primary took its own ${primaryMs} ms (${primary.durationMs})`)
    assert.ok(own(opinion, opinionMs), `the opinion took its own ${opinionMs} ms (${opinion.durationMs})`)
  }
})

test('a limit spends the key its call started on, and each call\'s usage row names that key, though another limit moved the key on first', async () => {
  let active = 'k1'
  const order = []
  const { run } = readRun({
    access: null, answerOnly: true,
    deps: {
      decide: parallel('claude', 'deepseek'),
      accountAt: () => ({ key: active, account: active }),
      onLimit: async (id, info) => { order.push(['limit', id, info.key]); active = 'k2'; return { rotated: true } },
      logAttempt: (e) => { order.push(['row', e.agent, e.account]) },
      execute: async (a) => {
        if (a.id === 'claude') { await new Promise((r) => setTimeout(r, 30)); return { stopReason: 'error', diagnostic: 'HTTP 402: usage limit reached', answerText: '' } }
        if (order.some(([k]) => k === 'limit')) return { stopReason: 'completed', answerText: 'the parser reads tokens in order' }
        return { stopReason: 'error', diagnostic: 'HTTP 402: usage limit reached', answerText: '' }
      },
    },
  })
  await run
  // Each row is written before its limit is handled, under the key its call ran on; each limit
  // names that key.
  assert.deepEqual(order.slice(0, 4), [['row', 'deepseek', 'k1'], ['limit', 'deepseek', 'k1'], ['row', 'claude', 'k1'], ['limit', 'claude', 'k1']])
})

test('a parallel opinion\'s own usage limit rotates its key or sets it aside for the run, and its call is logged', async () => {
  for (const rotated of [false, true]) {
    const logged = []
    const limited = []
    const seen = []
    const { run } = readRun({
      access: null, answerOnly: true,
      deps: {
        decide: async () => ({
          routing: { ...routeResult({ agentProbabilities: { claude: 0.9 } }), strategy: 'PARALLEL_SECOND_OPINION' },
          plan: { strategy: 'PARALLEL_SECOND_OPINION', steps: [{ role: 'primary', agent: 'claude' }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: 'deepseek', fallbackOrder: ['deepseek', 'codex'], notes: [] },
        }),
        onLimit: async (id, info) => { limited.push([id, info.reason]); return rotated ? { rotated: true } : {} },
        logAttempt: (e) => { logged.push([e.agent, e.role, e.limitHit, e.tokens]) },
        execute: async (a) => {
          seen.push(a.id)
          if (a.id === 'claude') { await new Promise((r) => setTimeout(r, 30)); return { stopReason: 'error', diagnostic: 'gave up', answerText: '' } }
          if (a.id === 'deepseek' && seen.filter((id) => id === 'deepseek').length === 1) return { stopReason: 'error', diagnostic: 'HTTP 402: usage limit reached', answerText: '', usage: { input: 500, output: 100 } }
          return { stopReason: 'completed', answerText: 'the parser reads tokens in order' }
        },
      },
    })
    const r = await run
    assert.deepEqual(limited, [['deepseek', 'HTTP 402: usage limit reached']])
    assert.deepEqual(r.limits.map((l) => [l.agent, l.action]), [['deepseek', rotated ? 'rotated' : 'set_aside']])
    assert.equal(r.attempts.find((a) => a.role === 'opinion').limitHit, true)
    assert.deepEqual(logged.find((l) => l[1] === 'opinion'), ['deepseek', 'opinion', true, { input: 500, output: 100 }])
    // Its plan's fallback goes to deepseek next: on a fresh key it may take the retry, set aside it may not.
    assert.deepEqual(seen, ['claude', 'deepseek', rotated ? 'deepseek' : 'codex'])
    assert.match(formatReport(r), rotated ? /- Usage limit: deepseek → next API key/ : /- Usage limit: deepseek → out until it resets; the run went on without it/)
  }
})

test('a Stop while a stopped opinion is still ending is said as the Stop, not as the break-off', async () => {
  const stop = new AbortController()
  const { run, rows } = readRun({
    signal: stop.signal,
    deps: {
      decide: parallel('deepseek', 'claude'),
      execute: async (a, prompt, sig, opts) => {
        if (a.id === 'deepseek') { await new Promise((r) => setTimeout(r, 20)); throw new Error('deepseek process exited with code 1') }
        opts.onStarted?.()
        await new Promise((r) => sig.addEventListener('abort', r, { once: true }))
        // The person presses Stop while this child's process is still being ended.
        stop.abort(new Error('stopped by the user'))
        await new Promise((r) => setTimeout(r, 30))
        sig.throwIfAborted()
      },
    },
  })
  await assert.rejects(run, /^Error: stopped by the user$/)
  assert.equal(rows[0].finalStatus, 'stopped')
})

test('a read pass outside git does not ask whether another run went on beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-read-nogit-'))
  let asked = 0
  const { run } = readRun({ dir, deps: { besideOther: () => { asked++; return true } } })
  const r = await run
  assert.equal(r.finalStatus, 'answered')
  assert.deepEqual(r.access.lockCheck, { measured: false, reason: 'not a git repository' })
  assert.equal(asked, 0, 'it waited on the run log for nothing')
  assert.equal(r.access.besideOther, false)
})

test('an answer-only run is marked so on its history row, whatever it came to', async () => {
  const h = history()
  await runRouted({
    task: 'what does parse() return?', cwd: repo(), config, answerOnly: true,
    deps: { jev: { route: async () => routeResult(), assess: async () => ({}) }, history: h, execute: async () => ({ stopReason: 'error', answerText: '' }) },
  }).catch(() => {})
  assert.equal(h.rows[0].answerOnly, true)
  assert.notEqual(h.rows[0].finalStatus, 'answered')
})

test('a lock check sees git\'s own files a write that got past the lock would use: a new hook', async () => {
  const breaches = []
  const dir = repo()
  const { run } = readRun({
    dir,
    execute: () => { writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n'); return { stopReason: 'completed', answerText: 'read it' } },
    deps: { besideOther: () => false, onLockBreach: (ids, files) => breaches.push(files) },
  })
  const r = await run
  assert.deepEqual(r.access.lockCheck, { measured: true, changed: ['.git/hooks/pre-commit'] })
  assert.deepEqual(breaches, [['.git/hooks/pre-commit']])
})

test('a primary that fails beside an opinion that answered: the opinion\'s answer is the run\'s, and no retry is paid for', async () => {
  const seen = []
  const { run } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => {
        seen.push(a.id)
        return a.id === 'claude' ? { stopReason: 'error', answerText: 'half an ans' } : { stopReason: 'completed', answerText: 'the whole answer from deepseek' }
      },
    },
  })
  const r = await run
  assert.deepEqual(seen, ['claude', 'deepseek'])
  assert.equal(r.finalStatus, 'answered')
  assert.equal(r.lastAnswer, 'the whole answer from deepseek')
  assert.match(r.lastAnswerBy, /^deepseek.*, opinion$/)
  // The report compares nothing with a cut-off answer, and says whose answer is shown.
  const report = formatReport(r)
  assert.match(report, /\*\*Second opinion \(deepseek\)\*\*: the primary did not finish, so there was nothing to compare\. The primary did not finish; the answer below is the second opinion from deepseek\./)
  assert.doesNotMatch(report, /DIFFER/)
  // Every reader that learns from runs credits the agent that answered, not the failed primary.
  const { trackRecord } = router
  const { calibration } = await import('../usage.js')
  const rows = Array.from({ length: 5 }, () => ({ ...r, workspace: '/w', routing: { ...r.routing, agentConfidence: 0.85, primaryAgent: 'claude' } }))
  const t = trackRecord(rows, '/w', [{ id: 'claude', provider: 'claude-code' }, { id: 'deepseek', kind: 'api' }])
  assert.deepEqual([t.claude.overall.accepted_rate, t.deepseek.overall.accepted_rate], [0, 1])
  assert.equal(calibration(rows, { minSamples: 1 }).overall.successRate, 0, 'the pick did not do the work')
})

test('a primary out of allowance beside an opinion that answered: that answer stands, and no retry is paid for', async () => {
  const seen = []
  const { run } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => {
        seen.push(a.id)
        return a.id === 'claude' ? { stopReason: 'error', diagnostic: 'You have hit your usage limit', answerText: '' } : { stopReason: 'completed', answerText: 'the answer from deepseek' }
      },
      quota: { claude: { state: 'ok' } },
      isLimit: () => ({ hit: true, until: null }),
    },
  })
  const r = await run
  assert.deepEqual(seen, ['claude', 'deepseek'])
  assert.deepEqual([r.finalStatus, r.lastAnswer], ['answered', 'the answer from deepseek'])
  assert.deepEqual(r.limits.map((l) => [l.agent, l.action]), [['claude', 'opinion']])
})

test('a primary out of allowance whose locked opinion needs the folder: the limit says the task goes to the line, not that an answer stands', async () => {
  const { run } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => (a.id === 'claude' ? { stopReason: 'error', diagnostic: 'You have hit your usage limit', answerText: '' } : { stopReason: 'completed', answerText: 'NEEDS-WRITE-ACCESS\nA file has to be created.' }),
    },
  })
  let err = null
  await assert.rejects(run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.match(err.message, /^deepseek said it needs to change files: A file has to be created\.$/)
  const { line } = await import('../adapter.js')
  assert.equal(line({ type: 'limit', agent: 'claude', action: 'line' }), 'claude hit its usage limit: the task goes to its folder\'s line')
})

test('a complete answer whose metered key crossed its floor with that call stands: it is the run\'s, and its agent is credited', async () => {
  const { run } = readRun({
    deps: {
      decide: parallel('deepseek', 'claude'),
      execute: async (a) => ({ stopReason: 'completed', answerText: `the full answer from ${a.id}` }),
      checkBalance: async (id) => (id === 'deepseek' ? { state: 'stopped' } : { state: 'ok' }),
    },
  })
  const r = await run
  assert.deepEqual([r.finalStatus, r.lastAnswer], ['answered', 'the full answer from deepseek'])
  assert.deepEqual(r.limits.map((l) => [l.agent, l.action]), [['deepseek', 'answered']])
  assert.equal(r.attempts.find((a) => a.role === 'opinion').answered, undefined, 'the opinion is not the work')
  assert.match(formatReport(r), /- Usage limit: deepseek → its answer had come back complete, and it stands/)
  // The limit came after the work: the answer is credited as work done, and the key is still spent.
  const primary = r.attempts.find((a) => a.role === 'primary')
  assert.deepEqual([primary.limitHit, primary.spentAfter], [undefined, true])
  const rows = Array.from({ length: 5 }, () => ({ ...r, workspace: '/w' }))
  assert.equal(router.trackRecord(rows, '/w', [{ id: 'deepseek', kind: 'api' }]).deepseek.overall.accepted_rate, 1)
})

test('an empty answer is no answer: with an opinion that failed too, a retry follows', async () => {
  const seen = []
  // An answer asked for in chat, not a read pass, whose agents may be asked again.
  const { run } = readRun({
    access: null,
    answerOnly: true,
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => {
        seen.push(a.id)
        if (seen.length === 1) return { stopReason: 'completed', answerText: '' }
        if (seen.length === 2) return { stopReason: 'error', answerText: '' }
        return { stopReason: 'completed', answerText: `${a.id} answered on the retry` }
      },
    },
  })
  const r = await run
  assert.equal(seen.length, 3, 'a retry after the empty answer')
  assert.deepEqual([r.finalStatus, r.lastAnswer], ['answered', `${seen[2]} answered on the retry`])
})

test('an empty primary beside an opinion that answered is said as one that gave no answer', async () => {
  const { run } = readRun({
    deps: {
      decide: parallel('claude', 'deepseek'),
      execute: async (a) => ({ stopReason: 'completed', answerText: a.id === 'claude' ? '' : 'the answer from deepseek' }),
    },
  })
  const r = await run
  assert.equal(r.lastAnswer, 'the answer from deepseek')
  assert.match(formatReport(r), /\*\*Second opinion \(deepseek\)\*\*: the primary gave no answer, so there was nothing to compare\. The primary gave no answer; the answer below is the second opinion from deepseek\./)
})

test('an agent that is not ready is said as not signed in, or, for a local model, not ready on this PC with why', () => {
  assert.equal(typeof router.notReadyWhy, 'function')
  const ready = { qwen: { loggedIn: false, detail: 'this PC cannot run qwen.gguf: needs 12 GB of RAM' }, claude: { loggedIn: false, detail: 'not signed in. Run: claude then /login' } }
  assert.equal(router.notReadyWhy({ id: 'qwen', provider: 'spawn', llm: { provider: 'local' } }, ready), 'not ready on this PC (this PC cannot run qwen.gguf: needs 12 GB of RAM)')
  assert.equal(router.notReadyWhy({ id: 'claude', provider: 'claude-code' }, ready), 'not signed in')
})

test('a read pass whose only lockable agent comes back empty goes to its folder\'s line, not to that agent again', async () => {
  const seen = []
  const { run } = readRun({
    deps: {
      lockOf: lockOf(['claude']),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: '' } },
    },
  })
  let err = null
  await assert.rejects(run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.deepEqual(seen, ['claude'])
  assert.match(err.message, /^no other agent that can be locked is left to try/)
})

test('a read pass never asks an agent again that already tried it, and hands the task back once none is left', async () => {
  const seen = []
  const { run } = readRun({
    deps: {
      lockOf: lockOf(['claude', 'deepseek']),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: '' } },
    },
  })
  let err = null
  await assert.rejects(run, (e) => { err = e; return e.code === 'NEEDS_LANE' })
  assert.equal(seen.length, 2, `each lockable agent once (${seen.join(', ')})`)
  assert.deepEqual([...new Set(seen)].sort(), ['claude', 'deepseek'])
  assert.match(err.message, /^no other agent that can be locked is left to try/)
})

test('a limit the balance check after an attempt found is the agent\'s own floor, said as such to onLimit, which then marks no key', async () => {
  const limits = []
  const { run } = readRun({
    access: null, answerOnly: true,
    deps: {
      checkBalance: async () => ({ state: 'stopped', balance: { amount: 19, currency: 'USD' }, until: null }),
      onLimit: async (id, info) => { limits.push([id, info.floor, info.key]); return {} },
      accountAt: () => ({ key: 'a', account: 'a' }),
      execute: async () => ({ stopReason: 'completed', answerText: 'the parser reads tokens in order' }),
    },
  })
  await run
  assert.deepEqual(limits, [['claude', true, 'a']])
})

test('a key spent by the call that answered still counts as a limit hit beside the credited answer', () => {
  const row = { workspace: '/w', finalStatus: 'answered', routing: { taskType: 'research' }, attempts: [{ agent: 'deepseek', role: 'primary', durationMs: 1000, spentAfter: true }] }
  const t = router.trackRecord([row, row, row], '/w', [{ id: 'deepseek', kind: 'api' }]).deepseek.overall
  assert.deepEqual([t.attempts, t.accepted_rate, t.limit_hits], [3, 1, 3])
})

test('a parallel opinion\'s own usage limit counts as that agent\'s limit hit, and not as an attempt', () => {
  const row = { workspace: '/w', finalStatus: 'answered', routing: { taskType: 'research' }, attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', durationMs: 1000 }, { agent: 'deepseek', role: 'opinion', stopReason: 'error', durationMs: 50, limitHit: true }] }
  const work = { ...row, attempts: [{ agent: 'deepseek', role: 'primary', stopReason: 'completed', durationMs: 1000 }] }
  const t = router.trackRecord([row, row, work], '/w', [{ id: 'deepseek', kind: 'api' }, { id: 'claude', kind: 'subscription' }]).deepseek.overall
  assert.deepEqual([t.attempts, t.limit_hits], [1, 2])
  // An agent that ran only as an opinion still has its limit hits said.
  const only = router.trackRecord([row, row], '/w', [{ id: 'deepseek', kind: 'api' }]).deepseek
  assert.deepEqual(only.overall, { attempts: 0, note: 'no work attempts counted, only usage-limit hits', limit_hits: 2 })
  assert.deepEqual(only.here_by_task_type.research?.limit_hits, 2)
})
