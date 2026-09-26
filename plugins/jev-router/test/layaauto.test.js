// Laya Auto, whole runs (docs/laya-auto.md 3 and 9.3): the adapter's Laya Auto row, through a
// route() and classify() wired as index.js wires them, into the real routing loop, decision engine
// and review. Laya is a fake client on this PC that answers as the Laya client does; Jev is a
// client that records any call and fails it, and so is every TypeSafe client, so a Laya Auto path
// that reached Jev shows up here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import * as adapter from '../adapter.js'
import { createDecisionEngine } from '../decision.js'
import { createDomainRegistry } from '../domains.js'
import { createJev } from '../jev.js'
import { createCapabilityRegistry, loadPriors } from '../profiles.js'
import { resolveProviders } from '../providers.js'
import { formatReport, runRouted } from '../router.js'
import { resolvePolicy } from '../routing-policy.js'
import { createTrainingStore } from '../training.js'

const PRIORS = loadPriors(fileURLToPath(new URL('../../../config/capability-priors.json', import.meta.url)))
const policy = resolvePolicy()
const { jev: JEV, laya: LAYA } = resolveProviders({}, { policy })
// What the Laya client relabels laya.serve's `laya-rl-agent` as (docs/laya-auto.md 4.5).
const LABEL = 'laya-english/0.3.20@1a2b3c4'
const IDENTITY = 'laya-0.3.20|english|1a2b3c4d5e6f|adapter-1|corr:choice:11+=3.27|margin:0.1'

const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'qwen-local', name: 'Qwen3 8B (local)', provider: 'spawn', description: 'd', enabled: true, kind: 'local', size: 8_100_000_000, llm: { provider: 'local', model: 'qwen3-8b' } },
]
const config = {
  agents: AGENTS,
  tools: [],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 2, maxReviews: 2, maxRounds: 4 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
  effort: {},
}

// A repo whose `npm test` passes only when state.txt says "fixed".
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-layaauto-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" },
  }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

// Strong review answers, and a debugging task at risk level 1 (0.25), so Laya's accept bar is its
// medium one, 0.80.
const GOOD = { taskType: 'debugging', addressed: 0.95, complete: 0.95, unrelatedChanges: 0.05, regressionRisk: 0.05, needsPerson: 0.05 }

/** One answer in the shape the Laya client hands createJev: max-probability confidence and its marks. */
function answerOf(q, said, informative) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria)
    const choice = said ?? keys[0]
    const top = informative ? 0.9 : 1 / keys.length
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? top : (1 - top) / Math.max(1, keys.length - 1)]))
    return { type: 'choice', choice, confidence: top, probabilities, informative }
  }
  if (q.type === 'score') return { type: 'score', score: said ?? 1, confidence: informative ? 0.8 : 0.2, informative }
  const noul = said ?? 0.2
  return { type: 'noul', noul, confidence: Math.max(noul, 1 - noul), informative }
}

/**
 * Laya on this PC as createJev meets it through the Laya client (docs/laya-auto.md 4.5): the
 * relabelled model, the marks the client sets on each answer, and the call's meta. A choice answers
 * `said[name]` or its first option, a score level `said[name]` or 1, a yes/no `said[name]` or 0.2;
 * a `said` value may be a function of the call's state. `flat` names answers too flat to use, or is
 * a function of an answer's name and its call's phase; `fail` names the phases that time out.
 */
function layaClient({ said = {}, flat = [], fail = [], device = 'cpu' } = {}) {
  const isFlat = typeof flat === 'function' ? flat : (name) => flat.includes(name)
  const phases = []
  return {
    phases,
    async systemOne({ state, questions }, { phase } = {}) {
      phases.push(phase)
      const names = Object.keys(questions)
      // As the Laya client times out: the deadline in the message, the call's size and device beside it.
      if (fail.includes(phase)) throw Object.assign(new Error('timed out after 42 s'), { code: 'LAYA_TIMEOUT', questions: names.length, device })
      const say = { ...GOOD, ...said }
      const answers = Object.fromEntries(names.map((n) => [n, answerOf(questions[n], typeof say[n] === 'function' ? say[n](state) : say[n], !isFlat(n, phase))]))
      return {
        model: LABEL, answers, usage: { input_tokens: 40 * names.length, output_tokens: 0 },
        meta: { provider: 'laya', device, waitedMs: 0, requests: 1, rows: names.length, atContextLimit: 0, uninformative: names.filter((n) => isFlat(n, phase)), corrected: [], lang: 'latin', identity: IDENTITY },
      }
    },
  }
}

/** Jev's stores and Laya's, the domain registry over Jev's, and the engine that reads both. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'kz-layaauto-data-'))
  const store = createTrainingStore({ file: join(root, 'routing-samples.jsonl') })
  const sink = createTrainingStore({ file: join(root, 'laya-samples.jsonl'), kind: 'laya' })
  const domains = createDomainRegistry({ policy, store, artifactsDir: join(root, 'classifiers'), stateDir: join(root, 'domains') })
  const engine = createDecisionEngine({ policy, domains, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, store })
  // What index.js hands the review of a Laya run, so jev-review stays ignorant of stores.
  const outcome = { decide: (args) => domains.get('outcome_disposition').decide({ ...args, answeredBy: 'laya', sink }) }
  return { store, sink, domains, engine, outcome }
}

/**
 * createJev as index.js calls it for either decider: with the provider's record and a client of its
 * own, which it must use. A createJev that took neither would build a TypeSafe client instead.
 */
function deciderOf(options) {
  let decider
  assert.doesNotThrow(() => { decider = createJev(options) }, 'createJev takes a provider record and the client it is handed')
  return decider
}

/**
 * route() and classify() as index.js wires them (docs/laya-auto.md 2.4), cut down to what these
 * tests read: the decider the adapter names picks the client and the record, a Laya run gets
 * Laya's store as its sink and the outcome domain behind a facade that decides for Laya, and every
 * answered call is a 'jev' event and every failed one a 'decider-error' event. Offline, Jev is not
 * asked at all, as today.
 */
function wire({ laya = layaClient(), jev: jevClient, offline = false, work } = {}) {
  const w = world()
  const dir = repo()
  const events = []
  const records = []
  const executed = []
  const jevAsked = []
  const refusing = { async systemOne(_, { phase } = {}) { jevAsked.push(phase); throw new Error('Jev was asked') } }
  const clientOf = (decider) => (decider === 'laya' ? laya : jevClient ?? refusing)
  const providerOf = (decider) => (decider === 'laya' ? LAYA : JEV)
  const execute = work ?? (async (a) => { executed.push(a.id); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'fixed it' } })
  const route = async ({ task, forceAgent, mode = 'auto', decider = 'jev', signal = new AbortController().signal, emit }) => {
    const on = (e) => { events.push(e); emit?.(e) }
    const provider = providerOf(decider)
    const client = deciderOf({
      provider, client: clientOf(decider),
      onTrace: (trace) => on({ type: 'jev', at: Date.now(), trace }),
      onError: (error) => on({ type: 'decider-error', at: Date.now(), error }),
    })
    const r = await runRouted({
      task, cwd: dir, forceAgent, config, signal,
      deps: {
        decider: offline && !provider.local ? null : client,
        provider,
        runId: `run-${records.length + 1}`,
        offline,
        localOnly: offline || mode === 'local' || mode === 'offline',
        jevUnavailableReason: 'offline: no internet, checks only',
        decide: (args) => w.engine.decide({ ...args, sink: decider === 'laya' ? w.sink : undefined }),
        outcomeDomain: decider === 'laya' ? w.outcome : w.domains.get('outcome_disposition'),
        execute: async (a, ...rest) => execute(a, ...rest),
        history: { recent: async () => [], records: async () => [], append: async () => {} },
        emit: on,
        deciderDevice: () => 'cpu',
      },
    })
    records.push(r)
    return formatReport(r)
  }
  const classify = async (message, mode, decider = 'jev') => {
    const r = await deciderOf({ provider: providerOf(decider), client: clientOf(decider) }).intent({ message }, AbortSignal.timeout(5000))
    return { ...r, thresholds: providerOf(decider).thresholds }
  }
  return { w, dir, route, classify, events, records, executed, jevAsked, laya }
}

const chatCtx = (asked = []) => ({
  agents: { get: () => ({ session: { header: { cwd: 'C:\\ws' } } }) },
  llm: {
    async *stream(o) {
      asked.push(`${o.provider}/${o.model}`)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'A chat answer.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
})

/** One message through the adapter: the reasoning lines and the reply text, apart. */
async function send(a, text, extra = {}) {
  const chunks = []
  const options = { messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], sessionId: 's', model: 'laya-auto', signal: new AbortController().signal, ...extra }
  for await (const c of a.stream(options)) chunks.push(c)
  return {
    reasoning: chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''),
    reply: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    chunks,
  }
}

/** The agent strip the report carries under it (router.js answeredSteps). */
const stripOf = (report) => JSON.parse(Buffer.from(/\[jev-agents\]: kzh-agents-1-(\S+)/.exec(report)[1], 'base64url').toString())

/** Every TypeSafe client, stood in for: any call is recorded and fails. */
function typesafeSpy(t) {
  const calls = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = function () { calls.push('systemOne'); throw new Error('a TypeSafe client was asked') }
  t.after(() => { TypeSafeClient.prototype.systemOne = real })
  return calls
}

test('Laya Auto never calls Jev: a question, a task and a session title in one Laya Auto session', async (t) => {
  const typesafe = typesafeSpy(t)
  // The question ends in a question mark; the task does not.
  const laya = layaClient({ said: { kind: (s) => (String(s.message).endsWith('?') ? 'question' : 'task') } })
  const x = wire({ laya })
  const offline = []
  const asked = []
  const a = adapter.jevAdapter({
    ctx: chatCtx(asked), route: x.route, classify: x.classify, auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    isOffline: async (decider) => { offline.push(decider); return false },
    agents: async () => AGENTS,
  })
  const question = await send(a, 'how does the parser handle tabs?')
  assert.match(question.reply, /^A chat answer\./, 'the question is answered by the chat model')
  const task = await send(a, 'fix the parser')
  assert.match(task.reply, /^\*\*Laya router\*\* · AUTO/, 'and the task is routed by Laya')
  for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], purpose: 'session-title', model: 'laya-auto', signal: new AbortController().signal })) { /* drain */ }
  assert.deepEqual(x.jevAsked, [], 'Jev was never asked')
  assert.deepEqual(typesafe, [], 'and no TypeSafe client was')
  assert.deepEqual(x.laya.phases.filter((p) => p === 'intent'), ['intent', 'intent'], 'Laya sorted both messages')
  assert.ok(x.laya.phases.includes('route') && x.laya.phases.includes('review'), 'and routed and reviewed the task')
  assert.ok(offline.length >= 2 && offline.every((d) => d === 'laya'), `every connectivity probe was Laya's (${offline.join(', ')})`)
})

test('the heading, the strip and the live lines of a Laya Auto run name Laya, with no maturity bracket and no Jev', async () => {
  const x = wire()
  const a = adapter.jevAdapter({ ctx: chatCtx(), route: x.route, classify: x.classify, auxModel: { provider: 'x', model: 'y' }, agents: async () => AGENTS })
  const { reasoning, reply } = await send(a, 'fix the parser')
  const r = x.records[0]
  assert.ok(r, `the Laya Auto row routed the message: ${reply}`)
  assert.equal(r.routing.decider, 'laya')
  assert.equal(r.routing.model, LABEL, 'the model is the Laya client\'s own label')
  assert.equal(r.finalStatus, 'accepted')
  // The report.
  assert.equal(reply.split('\n')[0], '**Laya router** · AUTO (Laya and routing rules decided)')
  const decided = reply.split('\n').find((l) => l.startsWith('- Decided by: '))
  assert.ok(decided, reply)
  assert.match(decided, /task_classification laya · /)
  assert.match(decided, /resource_selection code/)
  assert.doesNotMatch(decided, /\[/, 'no maturity bracket: the local ladder says nothing about a Laya run')
  assert.match(decided, / · 2 Laya calls \(\d+\.\d s on the CPU\)$/)
  assert.deepEqual(stripOf(reply)[0], { agent: 'Laya', model: LABEL, roles: [] }, 'the strip starts with Laya and its label')
  // The live lines.
  const lines = reasoning.trim().split('\n')
  assert.equal(lines.filter((l) => /^Laya route: (\d+)\/\1 questions in \d+ ms on the CPU$/.test(l)).length, 2, reasoning)
  assert.ok(lines.includes(`Laya and routing rules decided; 2 Laya calls; ${r.routing.decision.candidates.length} candidates considered`), reasoning)
  assert.ok(lines.some((l) => l.startsWith(`Routed to ${r.routing.primaryAgent} (laya)`)), reasoning)
  assert.ok(lines.some((l) => /^Laya review: 8\/9 questions in \d+ ms on the CPU$/.test(l)), reasoning)
  assert.ok(lines.includes('Review: accept. quality 0.95 ≥ bar 0.80 (risk 0.25)'), reasoning)
  assert.doesNotMatch(`${reasoning}\n${reply}`, /Jev/, 'nothing a Laya Auto run shows mentions Jev')
})

test('a Laya call that does not answer: the decider-error line, the rules decide those domains, and the report says so', async () => {
  const x = wire({ laya: layaClient({ fail: ['route'] }) })
  const a = adapter.jevAdapter({ ctx: chatCtx(), route: x.route, classify: x.classify, auxModel: { provider: 'x', model: 'y' }, agents: async () => AGENTS })
  const { reasoning, reply } = await send(a, 'fix the parser')
  const r = x.records[0]
  assert.ok(r, `the Laya Auto row routed the message: ${reply}`)
  assert.ok(Array.isArray(r.routing.deciderErrors) && r.routing.deciderErrors.length >= 1, 'the failed calls are on the routing record')
  assert.ok(r.routing.deciderErrors.every((e) => e.phase === 'route' && /^timed out after 42 s \(\d+ questions on the CPU\)$/.test(e.reason)), JSON.stringify(r.routing.deciderErrors))
  assert.match(reasoning, /^Laya route failed after \d+ ms: timed out after 42 s \(\d+ questions on the CPU\); routing rules decide those domains$/m)
  assert.match(reply, /^- Laya did not answer: route: timed out after 42 s \(\d+ questions on the CPU\)$/m)
  assert.match(reply.split('\n')[0], /^\*\*Laya router\*\* · AUTO \(/)
  assert.match(reply, /· no Laya call$/m, 'no Laya call answered the routing')
  assert.equal(r.assessments[0].mode, 'laya', 'the review is still Laya\'s')
  assert.deepEqual(x.jevAsked, [], 'and Jev was never asked in its place')
  // A review that does not answer takes the deterministic policy, and says whose answer is missing.
  const y = wire({ laya: layaClient({ fail: ['review'] }) })
  const b = adapter.jevAdapter({ ctx: chatCtx(), route: y.route, classify: y.classify, auxModel: { provider: 'x', model: 'y' }, agents: async () => AGENTS })
  const late = await send(b, 'fix the parser')
  assert.match(late.reasoning, /^Review: accept\. fallback policy \(Laya unavailable \(timed out after 42 s\); using the deterministic fallback\)$/m)
  assert.match(late.reasoning, /^Laya review failed after \d+ ms: timed out after 42 s \(9 questions on the CPU\)$/m)
  assert.match(late.reply, /^- Laya did not answer: review: timed out after 42 s \(9 questions on the CPU\)$/m)
  assert.deepEqual(y.jevAsked, [])
})

test('under Laya checks are always required: failing checks block the accept a low needsTests lets Jev take', async () => {
  // The agent touches a file but never fixes the failing test, which failed before it too.
  const idle = (x) => async () => { writeFileSync(join(x.dir, 'notes.txt'), `${Date.now()}`); return { stopReason: 'completed', answerText: 'looked at it' } }
  const lazy = { needsTests: 0.1 }
  let x
  x = wire({ laya: layaClient({ said: lazy }), work: (...a) => idle(x)(...a) })
  await x.route({ task: 'tidy the parser', decider: 'laya' })
  const laya = x.records[0]
  assert.equal(laya.routing.needsTests, 0.1, 'the setting: Laya said checks were not needed')
  assert.equal(laya.assessments[0].action, 'retry', 'failing checks still block an accept')
  assert.match(laya.assessments[0].why, /blocked/)
  // Jev, asked the same questions and answering the same, runs by today's rule: its needsTests bar.
  let y
  y = wire({ jev: layaClient({ said: lazy }), work: (...a) => idle(y)(...a) })
  await y.route({ task: 'tidy the parser', decider: 'jev' })
  assert.equal(y.records[0].routing.decider, 'jev')
  assert.equal(y.records[0].assessments[0].action, 'accept', 'a low needsTests lets Jev accept over failing checks, as today')
})

test('a human_required capability at 0.7 stops the run under Jev (bar 0.6) and not under Laya (bar 0.8)', async () => {
  const dir = () => repo()
  const route = (confidence) => async () => ({ primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { claude: 0.1, codex: 0.8, deepseek: 0.1 }, taskType: 'debugging', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2, needsTests: 0.9, capability: 'human_required', capabilityConfidence: confidence })
  const assess = async () => ({ verdict: 'accept', addressed: 0.95, complete: 0.95, unrelatedChanges: 0.05, regressionRisk: 0.05, needsPerson: 0.05, reviewAgent: 'claude', retryAgent: 'claude' })
  const run = async (provider, confidence) => {
    const cwd = dir()
    return runRouted({ task: 'rotate the production keys', cwd, config, signal: new AbortController().signal, deps: {
      decider: { provider, route: route(confidence), assess }, provider,
      execute: async () => { writeFileSync(join(cwd, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'done' } },
      history: { recent: async () => [], append: async () => {} },
    } })
  }
  const jev = await run(JEV, 0.7)
  assert.equal(jev.finalStatus, 'needs_human')
  assert.equal(jev.statusReason, 'Jev read this as needing a person (confidence 0.70)')
  assert.equal(jev.attempts.length, 0, 'nothing ran')
  const laya = await run(LAYA, 0.7)
  assert.notEqual(laya.finalStatus, 'needs_human', 'under Laya\'s bar the run proceeds')
  assert.equal(laya.attempts[0].agent, 'codex')
  const sure = await run(LAYA, 0.85)
  assert.equal(sure.finalStatus, 'needs_human', 'over it, Laya stops the run too')
  assert.equal(sure.statusReason, 'Laya read this as needing a person (confidence 0.85)')
})

test('offline, Laya Auto keeps deciding, over the local agents only; offline Jev takes the fixed rule as before', async () => {
  const x = wire({ offline: true })
  const report = await x.route({ task: 'fix the parser', decider: 'laya' })
  const r = x.records[0]
  assert.deepEqual([r.routing.mode, r.routing.decider, r.routing.primaryAgent], ['local', 'laya', 'qwen-local'])
  assert.ok(r.routing.decision, 'the decision engine decided')
  assert.ok(x.laya.phases.includes('route'), 'with Laya answering')
  assert.equal(report.split('\n')[0], '**Laya router** · AUTO (Laya and routing rules decided), LOCAL MODELS ONLY · OFFLINE: local models only')
  const y = wire({ offline: true })
  const jevReport = await y.route({ task: 'fix the parser', decider: 'jev' })
  assert.deepEqual([y.records[0].routing.mode, y.records[0].routing.decider], ['offline', 'jev'])
  assert.equal(jevReport.split('\n')[0], '**Jev router** · OFFLINE: local models only')
  assert.deepEqual(y.jevAsked, [], 'offline, Jev is not asked')
})

test('a local effort under Laya Auto is a manual run that Laya reviews', async () => {
  const x = wire()
  const a = adapter.jevAdapter({ ctx: chatCtx(), route: x.route, classify: x.classify, auxModel: { provider: 'x', model: 'y' }, agents: async () => AGENTS })
  const { reply } = await send(a, 'fix the parser', { reasoningEffort: 'local-low' })
  const r = x.records[0]
  assert.ok(r, `the Laya Auto row ran the message: ${reply}`)
  assert.deepEqual([r.routing.mode, r.routing.decider, r.routing.primaryAgent], ['manual', 'laya', 'qwen-local'])
  assert.equal(reply.split('\n')[0], '**Laya router** · MANUAL /qwen-local')
  assert.equal(r.assessments[0].mode, 'laya', 'Laya reviews the forced run')
  assert.deepEqual(x.laya.phases, ['review'], 'Laya sorted nothing and routed nothing: the effort forced the agent')
  assert.deepEqual(x.jevAsked, [])
})

test('Laya Auto is on the menu only while it is offered, and says what a task costs by Laya\'s state', async () => {
  const LOCAL = [{ id: 'qwen-local', kind: 'local', enabled: true }]
  const menu = async (layaRow, agents = []) => adapter.jevAdapter({ ctx: chatCtx(), route: async () => '', auxModel: { provider: 'x', model: 'y' }, agents: async () => agents, layaRow }).listModels('jev')
  assert.deepEqual((await menu(async () => null)).map((m) => m.id), ['jev-auto'], 'not offered: not on the menu')
  assert.deepEqual((await menu(async () => { throw new Error('status unreadable') })).map((m) => m.id), ['jev-auto'], 'a state nobody can read offers nothing')
  const ready = async () => ({ state: 'ready', device: 'cuda', routeMs: 1500, reviewMs: 900, lastStartMs: 41_000 })
  assert.deepEqual((await menu(ready)).map((m) => m.id), ['jev-auto', 'laya-auto'], 'right after Jev Auto')
  assert.deepEqual((await menu(ready, LOCAL)).map((m) => m.id), ['jev-auto', 'laya-auto', 'jev-online', 'jev-local', 'jev-offline', 'agent-qwen-local'], 'and before the local-only rows')
  const BASE = 'Laya, a decision model on this PC, routes every message and reviews the result instead of Jev. No Jev call is made and no routing or review question leaves this PC; offline it keeps routing, to the local models. The agent it picks still sees your task and code, and questions are answered by the chat model as in Jev Auto.'
  const described = async (state) => (await menu(async () => state)).find((m) => m.id === 'laya-auto')
  const row = await described(await ready())
  assert.equal(row.name, 'Laya Auto')
  assert.equal(row.description, `${BASE} Measured on this PC, on the GPU: about 1.5 s to route a task and 0.9 s to review each attempt.`)
  assert.equal((await described({ state: 'ready', device: 'cpu', routeMs: 21_400, reviewMs: 9_000 })).description, `${BASE} Measured on this PC, on the CPU: about 21 s to route a task and 9 s to review each attempt.`)
  assert.equal((await described({ state: 'ready', device: 'cpu', routeMs: null, reviewMs: null })).description, `${BASE} Not measured on this PC yet.`)
  assert.equal((await described({ state: 'stopped', device: null, routeMs: null, reviewMs: null, lastStartMs: 41_000 })).description, `${BASE} Laya is not running; the first message starts it (the last start took 41 s).`)
  assert.equal((await described({ state: 'failed' })).description, `${BASE} Laya could not start: press Start in Settings → Jev setup → Laya decision model.`)
  // Always a known id, so a saved selection resolves to Laya Auto, never to Jev.
  const resolved = await adapter.jevAdapter({ ctx: chatCtx(), route: async () => '', auxModel: { provider: 'x', model: 'y' } }).resolveModel('jev', 'laya-auto')
  assert.deepEqual([resolved.id, resolved.name], ['laya-auto', 'Laya Auto'])
})

test('a route Laya answered all flat: the task-group line names exactly the fields the report says the rules filled, and the second opinion only on the judgments call', async () => {
  const x = wire({ laya: layaClient({ flat: (_name, phase) => phase === 'route' }) })
  const a = adapter.jevAdapter({ ctx: chatCtx(), route: x.route, classify: x.classify, auxModel: { provider: 'x', model: 'y' }, agents: async () => AGENTS })
  const { reasoning, reply } = await send(a, 'fix the parser')
  const FILLED = "- Filled by the routing rules (Laya's answers were too flat to use): "
  const reported = reply.split('\n').find((l) => l.startsWith(FILLED))
  assert.ok(reported, reply)
  const namesOf = (l) => /too flat to use \((.*)\); the routing rules filled/.exec(l)[1].split(', ').sort()
  const lines = reasoning.split('\n').filter((l) => /^Laya route: \d+ answers? too flat to use/.test(l))
  const taskLine = lines.find((l) => namesOf(l).includes('taskType'))
  assert.ok(taskLine, reasoning)
  assert.deepEqual(namesOf(taskLine), reported.slice(FILLED.length).split(', ').sort(), 'the live line and the report name the same fields')
  assert.ok(!namesOf(taskLine).includes('secondOpinion'), 'the profile keeps its flat second opinion as answered')
  const judgments = lines.filter((l) => l !== taskLine)
  assert.equal(judgments.length, 1, reasoning)
  assert.ok(namesOf(judgments[0]).includes('secondOpinion'), 'the rules answer the second_opinion domain in its place')
})

test('the Laya Auto row says what this PC measured in every state that is not stopped or failed, and a failed update of a stopped Laya reads as not running', () => {
  const costs = { device: 'cuda', routeMs: 1400, reviewMs: 900, lastStartMs: 41_000 }
  const MEASURED = 'Measured on this PC, on the GPU: about 1.4 s to route a task and 0.9 s to review each attempt.'
  assert.equal(typeof adapter.layaRowSentence, 'function', 'adapter.js says what the Laya Auto row costs')
  for (const state of ['ready', 'starting', 'restarting', 'stopping', 'installing']) assert.equal(adapter.layaRowSentence({ state, ...costs }), MEASURED, state)
  assert.equal(adapter.layaRowSentence({ state: 'restarting', device: 'cuda', routeMs: null, reviewMs: null }), 'Not measured on this PC yet.')
  // The old install is still there, and the first message starts it.
  assert.equal(adapter.layaRowSentence({ state: 'install_failed', ...costs }), 'Laya is not running; the first message starts it (the last start took 41 s).')
})

test('stream() shows a refusal from layaUnavailable as its reply, before anything is sorted or run, and only in Laya Auto', async () => {
  const REFUSAL = 'Laya Auto did not run this: Laya is not installed on this PC. Install it in Settings → Jev setup → Laya decision model, or pick Jev Auto. Nothing was run.'
  const seen = { classify: 0, route: 0, refusal: [] }
  const a = adapter.jevAdapter({
    ctx: chatCtx(), auxModel: { provider: 'x', model: 'y' },
    route: async ({ emit }) => { seen.route++; emit({ type: 'final', status: 'accepted' }); return 'routed' },
    classify: async () => { seen.classify++; return { kind: 'task' } },
    layaUnavailable: async (role) => { seen.refusal.push(role); throw new Error(REFUSAL) },
  })
  assert.equal((await send(a, 'fix the parser')).reply, REFUSAL)
  assert.equal((await send(a, 'how does it work?')).reply, REFUSAL, 'a question too: Laya sorts every Laya Auto message')
  assert.deepEqual([seen.classify, seen.route], [0, 0], 'nothing was sorted or run')
  assert.deepEqual(seen.refusal, ['act', 'act'])
  assert.equal((await send(a, 'fix the parser', { model: 'jev-auto' })).reply, 'routed', 'Jev Auto never asks about Laya')
  assert.equal(seen.refusal.length, 2)
})

test('the chat model that answers and the session title are chosen with isOffline(\'laya\') in Laya Auto', async () => {
  const probed = []
  const asked = []
  const a = adapter.jevAdapter({
    ctx: chatCtx(asked), route: async () => '', classify: async () => ({ kind: 'question', confidence: 0.95, thresholds: LAYA.thresholds }),
    auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    isOffline: async (decider) => { probed.push(decider); return true },
  })
  assert.match((await send(a, 'what is a parser?')).reply, /OFFLINE: local models only\. Answered by: local\/qwen3-8b/)
  for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], purpose: 'session-title', model: 'laya-auto', signal: new AbortController().signal })) { /* drain */ }
  assert.deepEqual(probed, ['laya', 'laya'], 'the answer and the title each probed where Laya Auto probes')
  assert.deepEqual(asked, ['local/qwen3-8b', 'local/qwen3-8b'])
  await send(a, 'what is a parser?', { model: 'jev-auto' })
  assert.equal(probed.at(-1), 'jev', 'and Jev Auto where it always did')
})

test('in the No project space a message Laya could not sort is answered, not refused; a task still is', async () => {
  const { fileURLToPath: toPath } = await import('node:url')
  const cwd = toPath(new URL('../../../no-project', import.meta.url))
  let routed = 0
  const ctx = { ...chatCtx(), agents: { get: () => ({ session: { header: { cwd } } }) } }
  const why = 'Laya could not sort this message (timed out after 8 s); treating it as a task.'
  const unsure = adapter.jevAdapter({ ctx, route: async () => { routed++; return '' }, classify: async () => ({ kind: 'task', unsure: true, why }), auxModel: { provider: 'x', model: 'y' } })
  assert.match((await send(unsure, 'why does this test fail?')).reply, /^A chat answer\./)
  const sure = adapter.jevAdapter({ ctx, route: async () => { routed++; return '' }, classify: async () => ({ kind: 'task', confidence: 0.95 }), auxModel: { provider: 'x', model: 'y' } })
  assert.match((await send(sure, 'fix the bug')).reply, /No project/)
  assert.equal(routed, 0)
})

test('while Laya starts the message waits with the Starting line, then is asked; unsure after that is a task that says why', async () => {
  const START = 'Starting Laya on this PC: loading the model on the CPU (5 s; the last start took 41 s)…'
  const why = 'Laya could not sort this message (Laya was still starting after 300 s); treating it as a task.'
  const routed = []
  const queued = []
  const make = (cls, orchestrator) => adapter.jevAdapter({
    ctx: chatCtx(), auxModel: { provider: 'x', model: 'y' }, orchestrator,
    classify: async (message, mode, decider, { onWait } = {}) => { onWait?.(START); await new Promise((r) => setTimeout(r, 5)); return cls },
    route: async ({ decider, emit }) => { routed.push(decider); emit({ type: 'final', status: 'accepted' }); return 'the report' },
  })
  const asked = await send(make({ kind: 'question', confidence: 0.95 }), 'what is a parser?')
  assert.equal(asked.reasoning, `${START}\n`, 'the wait is said as it happens')
  const reasoning = asked.chunks.findIndex((c) => c.type === 'reasoning-delta')
  const text = asked.chunks.findIndex((c) => c.type === 'text-delta')
  assert.ok(reasoning >= 0 && reasoning < text, 'before the answer')
  assert.match(asked.reply, /^A chat answer\./)
  const blocks = (chunks, kind) => chunks.filter((c) => c.type === 'block-start' && c.blockType === kind).map((c) => c.index)
  assert.deepEqual(blocks(asked.chunks, 'reasoning'), [0])
  assert.deepEqual(blocks(asked.chunks, 'text'), [1, 2], 'the answer and its credit are numbered after the waiting lines, never on them')
  const blocking = await send(make({ kind: 'task', unsure: true, why }), 'what is a parser?')
  assert.equal(blocking.reasoning, `${START}\n${why}\nFinal: accepted\n`, 'the reason rides first among the run\'s own lines')
  assert.deepEqual(routed, ['laya'])
  const orchestrator = { results: () => [], live: () => 0, enqueue: (fields, extra) => { queued.push({ fields, extra }); return 'queued' } }
  const later = await send(make({ kind: 'task', unsure: true, why }, orchestrator), 'what is a parser?')
  assert.deepEqual(queued[0].extra, { decider: 'laya', why }, 'a queued task carries who decides it and why it is a task')
  assert.deepEqual([blocks(later.chunks, 'reasoning'), blocks(later.chunks, 'text')], [[0], [1]])
  assert.equal(queued[0].fields.task, 'what is a parser?')
})
