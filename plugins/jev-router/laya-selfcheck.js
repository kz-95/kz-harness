// Test Laya, and the calls that warm a fresh Laya up (docs/laya-auto.md 4.6, 7.5).
//
// Fixed calls in KzH's own shapes, built with the unchanged jev.js builders and rendered with
// laya-questions.js exactly as the Laya client renders them:
//   - the protocol calls: an intent on a clear task and on a clear question, a route and a review;
//   - seven yes/no pairs, one clearly-yes and one clearly-no state for each of seven nouls, which
//     show directly whether Laya issue #156 (a confident no on clearly positive input) survives the
//     labels workaround, and the kind pair (the intent's task-or-question choice) beside them;
//   - the maximal route and review, which a fresh start per device sends once so its first real
//     route is never the first request to need that much memory, and to measure every phase.
// `createProbe(connection)` sends them with a bare SDK client, so the sidecar's warm-up and the
// install's check can run them without the Laya client, which itself needs a running sidecar.
// `runSelfTest(systemOne)` runs Test Laya over any client of that shape, the real Laya client
// included. The result gates nothing; it is shown on the Laya card.
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { eligibleStrategies } from './broker.js'
import { CAPABILITIES } from './capabilities.js'
import { createJev } from './jev.js'
import { LAYA_MODEL, mergeLaya, normalizeLayaAnswers, renderForLaya } from './laya-questions.js'

/** A yes/no pair separates when the clear yes's P(true) exceeds the clear no's by this much. */
export const SEPARATION = 0.2
/** The nouls Test Laya pairs, in the order the card lists them. */
export const PAIR_NOULS = Object.freeze(['alsoWork', 'needsPerson', 'unrelatedChanges', 'addressed', 'complete', 'continueHandoff', 'humanReview'])

// --- building the calls --------------------------------------------------------------------------

/**
 * The `{ phase, state, questions }` one jev.js builder call sends, taken at the SDK boundary.
 * createJev's new form sends through the `client` it is handed; the old form builds its own
 * TypeSafeClient, so for the synchronous moment the builder takes to reach `systemOne`, the
 * SDK's method is the capture too. Either way nothing is sent: the captured call never settles.
 */
function built(phase, call) {
  let sent = null
  const capture = function systemOne(body) { sent ??= body; return new Promise(() => {}) }
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = capture
  try {
    call(createJev({ apiKey: 'laya-selfcheck', client: { systemOne: capture } }))?.catch?.(() => {})
  } finally {
    TypeSafeClient.prototype.systemOne = real
  }
  if (!sent) throw new Error(`laya-selfcheck: jev.js sent no ${phase} call to capture`)
  return { phase, state: sent.state, questions: sent.questions }
}

const ALL_CAPABILITIES = Object.keys(CAPABILITIES).filter((c) => c !== 'human_required')

const CONTEXT = {
  gitRepo: true, productionCritical: false, branch: 'main', uncommittedFiles: [], uncommittedFileCount: 0,
  trackedFileCount: 48, fileTypes: { '.js': 31, '.json': 7, '.md': 6, '.css': 4 }, scripts: ['test', 'lint', 'build'], dependencies: ['react', 'vitest', 'eslint'],
}

const AGENTS = [
  { id: 'claude', description: 'The Claude Code CLI, paid for by a Claude subscription.' },
  { id: 'codex', description: 'The OpenAI Codex CLI, paid for by a ChatGPT subscription.' },
  { id: 'deepseek', description: 'The native harness agent on the DeepSeek API, paid per token.' },
]

/** A decision record's candidate, with the numbers the review's anonymous table is built from. */
const candidate = (id, key, tier, { fit, reliability, cost }) => ({
  id, key, tier, source: tier === 'standard' ? 'api' : 'subscription', scarcity: 0.3, scarcityConfidence: 0.6,
  capabilities: { coding: { score: 0.6 + (tier === 'frontier' ? 0.3 : tier === 'strong' ? 0.2 : 0), confidence: 0.7, samples: 12 } },
  marginalCost: cost, expectedCost: { total: 0.2, class: cost }, latency: 'medium', availability: 'ok',
  reliability: { score: reliability, confidence: 0.7 }, evidenceSamples: 12, fit,
})

const DECISION = {
  candidates: [
    candidate('claude', 'RESOURCE_A', 'frontier', { fit: 0.81, reliability: 0.9, cost: 'low' }),
    candidate('codex', 'RESOURCE_B', 'strong', { fit: 0.74, reliability: 0.85, cost: 'low' }),
    candidate('deepseek', 'RESOURCE_C', 'standard', { fit: 0.62, reliability: 0.8, cost: 'metered' }),
  ],
  excluded: [],
}

const RENAME = 'Rename the variable foo to bar in utils.js'
const RENAME_PATCH = [
  'diff --git a/utils.js b/utils.js', '--- a/utils.js', '+++ b/utils.js', '@@ -1,6 +1,6 @@',
  '-export const foo = 42', '+export const bar = 42', '-export const double = () => foo * 2', '+export const double = () => bar * 2',
  'diff --git a/main.js b/main.js', '--- a/main.js', '+++ b/main.js', '@@ -1,3 +1,3 @@',
  "-import { foo } from './utils.js'", "+import { bar } from './utils.js'", '-console.log(foo)', '+console.log(bar)',
].join('\n')
const RENAME_STAT = ' main.js  | 4 ++--\n utils.js | 4 ++--\n 2 files changed, 4 insertions(+), 4 deletions(-)'
const PASSING = [{ name: 'test', passed: true, exitCode: 0, durationMs: 1200, output: 'ok 14 tests' }]

/**
 * A review of the latest attempt, built the way jev-review asks for it: over the anonymous table of
 * the run's decision record, with the first candidate as the agent that did the work.
 */
function review({ task = RENAME, answer, status = 'completed', files = ['utils.js', 'main.js'], patch = RENAME_PATCH, stat = RENAME_STAT, checks = PASSING, regressed = [], attempts = [], decision = DECISION }) {
  const agents = decision.candidates.map((c) => AGENTS.find((a) => a.id === c.id) ?? { id: c.id, description: `The ${c.id} agent.` })
  return built('review', (jev) => jev.assess({
    task,
    routing: { taskType: 'refactor', risk: 0.2, complexity: 0.2, decision },
    attempts: [...attempts, { agent: agents[0].id, role: 'primary', stopReason: status, answerText: answer, changedFiles: files }],
    checks: { results: checks, regressed, fixed: [], failing: checks.filter((c) => !c.passed).map((c) => c.name) },
    diff: { stat, patch },
    agents,
  }))
}

/** The task group of a route, as decision.js asks it first (no candidates yet). */
const route = ({ task, context = CONTEXT, handoff, tools }) => built('route', (jev) => jev.route({
  task, context, handoff, tools, capabilities: ALL_CAPABILITIES, ask: { task: true, resource: false, judgments: false },
}))

const intent = (message) => built('intent', (jev) => jev.intent({ message }))

/**
 * The resource and judgments call a task's routing sends once its pool exists (decision.js
 * askJev('resource')): the strategy over what the review's three candidates can run, and the second
 * opinion, with the task's profile as the numbers decision.js hands over.
 */
const resource = ({ task, taskProfile }) => built('route', (jev) => jev.route({
  task, taskProfile, candidates: DECISION.candidates, strategies: eligibleStrategies({ candidates: DECISION.candidates }),
  ask: { task: false, resource: true, judgments: true },
}))

/** The numbers of the rename's profile, as decision.js profileNumbers hands them to the resource call. */
const RENAME_PROFILE = {
  complexity: 0.25, risk: 0.25, needsSecondOpinion: 0.2, needsHumanReview: 0.1, needsTests: 0.8,
  req_general_reasoning: 0.25, req_architecture: 0, req_planning: 0, req_explanation: 0, req_coding: 0.75,
  req_debugging: 0, req_security_review: 0, req_code_review: 0.25, req_testing: 0.5, req_long_context: 0,
}

/** One question of a built call, alone, with the call's full state. */
const only = (call, name) => ({ phase: call.phase, state: call.state, questions: { [name]: call.questions[name] } })

const HANDOFF = 'Earlier unfinished work: the parser refactor in src/parser.ts is half done. tokenize() is split out into src/tokenizer.ts, but parse() still calls the old helpers. Next step: move parse() onto the new tokenizer and delete the old helpers.'
const TYPO = 'Fix the typo "recieve" in README.md'

function pairCalls() {
  const pair = (name, yes, no) => ({ name, phase: yes.phase, yes: only(yes, name), no: only(no, name) })
  return [
    pair('alsoWork',
      intent('What does the --fit flag in llama.cpp do? Also add it to the llama-server start command in scripts/start-llama.sh.'),
      intent('What does the --fit flag in llama.cpp do?')),
    pair('needsPerson',
      review({ answer: 'I found a second copy of the data in the users_old table. I stopped before deleting anything: should I drop users_old in production? Please decide.', files: [], patch: '', stat: '' }),
      review({ answer: 'Renamed foo to bar in utils.js and its call site in main.js. All 14 tests pass.' })),
    pair('unrelatedChanges',
      review({
        answer: 'Renamed foo to bar, bumped the package version and removed the old docs folder.',
        files: ['utils.js', 'main.js', 'package.json', 'docs/old-api.md'],
        patch: `${RENAME_PATCH}\ndiff --git a/package.json b/package.json\n-  "version": "1.4.2",\n+  "version": "2.0.0",\ndiff --git a/docs/old-api.md b/docs/old-api.md\ndeleted file mode 100644\n-# Old API\n-The v1 API reference.`,
        stat: ' docs/old-api.md | 2 --\n main.js  | 4 ++--\n package.json | 2 +-\n utils.js | 4 ++--\n 4 files changed, 5 insertions(+), 7 deletions(-)',
      }),
      review({ answer: 'Renamed foo to bar in utils.js and its call site in main.js.' })),
    pair('addressed',
      review({ answer: 'Renamed foo to bar in utils.js and its call site in main.js.' }),
      review({
        answer: 'I added a comment to README.md explaining what utils.js does.',
        files: ['README.md'], patch: 'diff --git a/README.md b/README.md\n+utils.js holds small shared helpers.', stat: ' README.md | 1 +\n 1 file changed, 1 insertion(+)',
      })),
    pair('complete',
      review({
        task: `${RENAME}, and add a test for double()`,
        answer: 'Renamed foo to bar in utils.js and main.js, and added utils.test.js with a test for double().',
        files: ['utils.js', 'main.js', 'utils.test.js'],
        patch: `${RENAME_PATCH}\ndiff --git a/utils.test.js b/utils.test.js\n+import { double } from './utils.js'\n+test('double', () => expect(double()).toBe(84))`,
      }),
      review({ task: `${RENAME}, and add a test for double()`, answer: 'Renamed foo to bar in utils.js and main.js. I did not add the test.' })),
    pair('continueHandoff',
      route({ task: 'Continue the parser refactor from where it stopped.', handoff: HANDOFF }),
      route({ task: TYPO, handoff: HANDOFF })),
    pair('humanReview',
      route({ task: 'Delete the old customer records from the production database and rotate the payment API keys.' }),
      route({ task: TYPO })),
  ]
}

function protocolCalls() {
  return [
    { name: 'intent.task', ...intent('Fix the failing test in src/parser.ts') },
    { name: 'intent.question', ...intent('What does the --fit flag in llama.cpp do?') },
    { name: 'route', ...route({ task: RENAME }) },
    { name: 'review', ...review({ answer: 'Renamed foo to bar in utils.js and its call site in main.js. All 14 tests pass.' }) },
  ]
}

/** The largest route and review KzH sends, for the first start on a device (7.5). */
function maximalCalls() {
  const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 6 ? '.' : ''}`).join(' ')
  const context = {
    gitRepo: true, productionCritical: true, branch: 'feature/checkout-rewrite',
    uncommittedFiles: Array.from({ length: 30 }, (_, i) => `src/checkout/step-${i}/component-${i}.tsx`), uncommittedFileCount: 64,
    trackedFileCount: 2400, fileTypes: { '.ts': 900, '.tsx': 700, '.js': 300, '.json': 200, '.md': 120, '.css': 90, '.yml': 50, '.sql': 40 },
    scripts: ['build', 'test', 'test:e2e', 'lint', 'typecheck', 'format', 'migrate', 'seed', 'storybook', 'release'],
    dependencies: Array.from({ length: 25 }, (_, i) => `dependency-number-${i}`),
  }
  const tools = [
    { id: 'format_code', description: 'Runs prettier over the whole repository and commits the formatted files as one commit.', params: { scope: { question: 'Which files should be formatted?', options: { all: 'Every file in the repository, including generated code', changed: 'Only the files changed on this branch compared with main' } } } },
    { id: 'bump_version', description: 'Bumps the package version in package.json and writes a changelog entry.', params: { level: { question: 'Which part of the version should change?', options: { major: 'A breaking change', minor: 'A new feature', patch: 'A bug fix only' } } } },
  ]
  const task = `Rewrite the checkout flow in src/checkout so that every step validates its input before the payment call. ${words(220, 'detail')}`
  const decision = {
    candidates: 'ABCDEFGH'.split('').map((l, i) => candidate(`agent-${i}`, `RESOURCE_${l}`, ['frontier', 'strong', 'standard'][i % 3], { fit: 0.5 + i / 20, reliability: 0.7 + i / 40, cost: i % 2 ? 'low' : 'metered' })),
    excluded: [],
  }
  const checks = ['typecheck', 'lint', 'test', 'test:e2e', 'build', 'format'].map((name, i) => ({ name, passed: i !== 2, exitCode: i === 2 ? 1 : 0, durationMs: 9000, output: `${name} output line\n`.repeat(200) }))
  const patch = Array.from({ length: 400 }, (_, i) => `${i % 2 ? '+' : '-'}  const step${i} = validate(input${i}) // checkout step ${i}`).join('\n')
  return [
    { name: 'route.maximal', ...route({ task, context, handoff: words(500, 'handoff'), tools }) },
    {
      name: 'review.maximal',
      ...review({
        task,
        answer: `${words(700, 'answer')} Should I also migrate the stored carts, or leave them for a person to decide?`,
        status: 'end_turn',
        files: context.uncommittedFiles,
        patch,
        stat: context.uncommittedFiles.map((f) => ` ${f} | 12 ++++++------`).join('\n'),
        checks,
        regressed: ['test'],
        attempts: [
          { agent: 'agent-1', role: 'primary', stopReason: 'max_turns', answerText: words(300, 'earlier'), changedFiles: context.uncommittedFiles.slice(0, 10) },
          { agent: 'agent-2', role: 'retry', stopReason: 'error', answerText: words(300, 'retry'), changedFiles: [], diagnostic: 'exit code 1' },
        ],
        decision,
      }),
    },
  ]
}

/**
 * The calls one routed task sends, in the order decision.js sends them: the intent, the task group
 * and the resource and judgments call. Test Laya sends the first two among its protocol calls, and
 * never the third, which only a pool of candidates asks.
 */
function taskCallsOf(protocol) {
  const of = (name) => protocol.find((c) => c.name === name)
  return [of('intent.task'), of('route'), { name: 'route.resource', ...resource({ task: RENAME, taskProfile: RENAME_PROFILE }) }]
}

let cache = null
/** Every fixed call, built once on first use: importing this module builds nothing. */
function calls() {
  if (!cache) {
    const protocol = protocolCalls()
    cache = { protocol, pairs: pairCalls(), maximal: maximalCalls(), task: taskCallsOf(protocol) }
  }
  return cache
}

/** Test Laya's calls: the protocol calls and the seven yes/no pairs. */
export const selfTestCalls = () => ({ protocol: calls().protocol, pairs: calls().pairs })

/**
 * What routing one task sends Laya: its intent, its task group and its resource and judgments call,
 * each `{ name, phase, state, questions }`. The picker's figure for routing a task is their measured
 * cost together (docs/laya-auto.md 3.1).
 */
export const taskCalls = () => calls().task

/**
 * What a fresh start sends before it counts as ready (7.5): always Test Laya's two intent probes,
 * which pay CUDA initialisation before the first real call; with `full`, also the maximal route
 * and review, once per device and identity, which measure every phase and the memory peak.
 */
export const warmUpCalls = ({ full = false } = {}) => [...calls().protocol.slice(0, 2), ...(full ? calls().maximal : [])]

// --- running them --------------------------------------------------------------------------------

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** What is wrong with one call's answers, as protocol problems; empty when every answer is sound. */
export function checkAnswers(name, questions, answers) {
  const problems = []
  for (const [q, def] of Object.entries(questions)) {
    const a = answers?.[q]
    if (!a) { problems.push(`${name}: ${q} was not answered`); continue }
    if (a.type !== def.type) { problems.push(`${name}: ${q} was answered as a ${a.type}, asked as a ${def.type}`); continue }
    const p = a.probabilities ? Object.values(a.probabilities) : null
    if (def.type === 'choice' && !Object.hasOwn(def.criteria, a.choice)) problems.push(`${name}: ${q} chose ${a.choice}, which was not offered`)
    if (def.type !== 'noul' && (!p || Math.abs(sum(p) - 1) > 0.01)) problems.push(`${name}: ${q} probabilities do not sum to 1`)
    if (def.type === 'noul' && !(a.noul >= 0 && a.noul <= 1)) problems.push(`${name}: ${q} answered ${a.noul}, not a probability`)
    if (def.type === 'score' && !(a.score >= 0 && a.score <= def.criteria.length - 1)) problems.push(`${name}: ${q} scored ${a.score}, off its scale`)
    if (!(a.confidence >= 0 && a.confidence <= 1)) problems.push(`${name}: ${q} confidence ${a.confidence} is not in [0, 1]`)
  }
  return problems
}

const deadlineOf = (deadlineMs, phase) => (typeof deadlineMs === 'function' ? deadlineMs(phase) : deadlineMs)

/**
 * Run fixed calls one after another through `systemOne({ state, questions }, { phase, signal })`,
 * checking each answer set. Stops at the first call that throws.
 * @returns {Promise<{ ok: boolean, error: string|null, status: number|null, problems: string[],
 *   calls: { name: string, phase: string, ms: number, tokens: number, rows: number, requests: number, answers: object }[] }>}
 */
export async function runCalls(systemOne, list, { deadlineMs, now = Date.now, signal } = {}) {
  const done = []
  const problems = []
  for (const c of list) {
    const t0 = now()
    let res
    try {
      res = await systemOne({ state: c.state, questions: c.questions }, { phase: c.phase, signal })
    } catch (err) {
      return { ok: false, error: `${c.name}: ${err?.message ?? String(err)}`, status: typeof err?.status === 'number' ? err.status : null, problems, calls: done }
    }
    const ms = now() - t0
    const limit = deadlineOf(deadlineMs, c.phase)
    if (typeof limit === 'number' && ms > limit) problems.push(`${c.name}: took ${ms} ms, over its ${limit} ms deadline`)
    problems.push(...checkAnswers(c.name, c.questions, res?.answers))
    done.push({ name: c.name, phase: c.phase, ms, tokens: res?.usage?.input_tokens ?? 0, rows: res?.meta?.rows ?? Object.keys(c.questions).length, requests: res?.meta?.requests ?? 1, answers: res?.answers ?? {} })
  }
  return { ok: problems.length === 0, error: null, status: null, problems, calls: done }
}

const r4 = (x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : null)
/**
 * Whether a clear yes's P(true) exceeds the clear no's by SEPARATION. Laya answers in 4 decimals,
 * so an exact 0.2 is an ordinary difference, and 0.7 - 0.5 is 0.19999999999999996 in floating point.
 */
const separates = (yes, no) => yes - no >= SEPARATION - 1e-9

/**
 * Test Laya (4.6) over any client of the Laya client's shape: the protocol calls with their
 * timings, the seven yes/no pairs and the kind pair, each pair reported apart with the direction
 * of any miss. The result is what `laya.json` keeps as `lastSelfTest` and the card shows through
 * `selfTestLine`.
 * @param {(call: { state, questions }, opts: { phase, signal }) => Promise<{ answers, usage?, meta? }>} systemOne
 * @param {{ identity?: string, device?: 'cuda'|'cpu'|null, deadlineMs?: number|((phase) => number), now?: () => number, signal?: AbortSignal }} [opts]
 */
export async function runSelfTest(systemOne, { identity = null, device = null, deadlineMs, now = Date.now, signal } = {}) {
  const at = new Date(now()).toISOString()
  const { protocol, pairs } = selfTestCalls()
  const ran = await runCalls(systemOne, protocol, { deadlineMs, now, signal })
  const result = {
    at, identity, device,
    protocol: { ok: ran.ok, problems: ran.error ? [ran.error, ...ran.problems] : ran.problems },
    timings: null, pairs: [], kind: null, error: ran.error,
  }
  if (ran.error) return result
  const ms = Object.fromEntries(ran.calls.map((c) => [c.name, c.ms]))
  result.timings = { intent: Math.round((ms['intent.task'] + ms['intent.question']) / 2), route: ms.route, review: ms.review }
  // The kind pair is the two protocol intents: a two-option choice, no noul labels involved.
  const pTask = (name) => ran.calls.find((c) => c.name === name)?.answers?.kind?.probabilities?.task
  const onTask = pTask('intent.task')
  const onQuestion = pTask('intent.question')
  result.kind = { task: r4(onTask), question: r4(onQuestion), separates: separates(onTask, onQuestion) }
  for (const p of pairs) {
    const got = {}
    for (const side of ['yes', 'no']) {
      const one = await runCalls(systemOne, [{ name: `${p.name} (clear ${side})`, ...p[side] }], { deadlineMs, now, signal })
      // A probe that throws fails the run as a protocol call would; the pairs asked so far are kept.
      if (one.error) {
        result.error = one.error
        result.protocol = { ok: false, problems: [one.error, ...result.protocol.problems] }
        return result
      }
      result.protocol.problems.push(...one.problems)
      got[side] = one.calls[0].answers[p.name]?.noul
    }
    result.pairs.push({
      name: p.name, yes: r4(got.yes), no: r4(got.no),
      separates: separates(got.yes, got.no),
      // The direction of a miss: a clear yes answered no is the #156 pattern; a clear no answered
      // yes is the opposite bias.
      noOnYes: got.yes < 0.5,
      yesOnNo: got.no > 0.5,
    })
  }
  result.protocol.ok = result.protocol.problems.length === 0
  return result
}

const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** The card's line for a Test Laya result (8.2). */
export function selfTestLine(r) {
  const commit = String(r?.identity ?? '').split('|')[2]?.slice(0, 7) || 'unknown'
  const out = [`Test Laya (model ${commit}):`]
  out.push(r?.protocol?.ok && !r?.error ? 'protocol ok.' : `protocol failed (${r?.error ?? r?.protocol?.problems?.[0] ?? 'no answer'}).`)
  if (r?.timings) {
    const where = r.device === 'cuda' ? 'the GPU' : r.device === 'cpu' ? 'the CPU' : 'this PC'
    out.push(`On ${where}: intent ${r.timings.intent} ms, routing ${r.timings.route} ms, review ${r.timings.review} ms.`)
  }
  // A run that stopped at an error asked only some of the pairs: a count over those would read as
  // a result of all seven, so the line waits for a run that finishes.
  const pairs = r?.error ? [] : r?.pairs ?? []
  if (pairs.length) {
    const misses = pairs.filter((p) => !p.separates)
    let line = `${pairs.length - misses.length} of ${pairs.length} yes/no questions separate`
    if (misses.length) {
      const n = misses.filter((p) => p.noOnYes).length
      const m = misses.filter((p) => p.yesOnNo).length
      const why = [n ? `${n} answered no to the clear yes, the pattern of Laya issue #156` : '', m ? `${m} answered yes to the clear no` : ''].filter(Boolean).join('; ')
      line += `; ${listed(misses.map((p) => p.name))} ${misses.length === 1 ? 'does' : 'do'} not${why ? ` (${why})` : ''}`
    }
    out.push(`${line}.`)
  }
  if (r?.kind) out.push(`Task or question: ${r.kind.separates ? 'separates' : 'does not separate'}.`)
  return out.join(' ')
}

// --- the bare probe ------------------------------------------------------------------------------

/**
 * A probe of one running laya.serve, for the sidecar's warm-up (7.5) and the install's check
 * (7.2 step 7). It sends through a bare SDK client, with no gate, no retries and no Laya client,
 * rendering, merging and normalising each call exactly as the Laya client does.
 * The SDK's own default timeout is 10 s, under a CPU route call, so each request gets `timeoutMs`.
 * A connection without a key or a url is refused: the SDK would fill either from TYPESAFE_API_KEY
 * and TYPESAFE_BASE_URL, and send the person's TypeSafe secret to whatever answers on the port.
 * @param {{ url: string, key: string, device?: string }} connection  what `sidecar.connection()` returns
 * @param {{ timeoutMs?: number, temperatureCorrections?: object, minTopMargin?: number, fetch?: Function, now?: () => number }} [opts]
 */
export function createProbe(connection, { timeoutMs = 120_000, temperatureCorrections, minTopMargin, fetch, now = Date.now } = {}) {
  for (const field of ['key', 'url']) {
    if (typeof connection?.[field] !== 'string' || !connection[field]) throw new Error(`laya-selfcheck: the connection has no ${field}`)
  }
  const client = new TypeSafeClient({
    apiKey: connection.key, baseURL: connection.url, defaultModel: LAYA_MODEL, retry: { maxRetries: 0 }, timeout: timeoutMs,
    ...(fetch ? { fetch } : {}),
  })
  const settings = {
    ...(temperatureCorrections ? { temperatureCorrections } : {}),
    ...(typeof minTopMargin === 'number' ? { minTopMargin } : {}),
  }
  const systemOne = async ({ state, questions }, { phase, signal } = {}) => {
    const parts = []
    for (const r of renderForLaya({ phase, state, questions }, { role: 'act' })) {
      parts.push({ key: r.key, response: await client.systemOne({ model: r.model, state: r.state, questions: r.questions }, { signal }) })
    }
    const merged = mergeLaya({ phase, questions }, parts)
    const norm = normalizeLayaAnswers(merged.answers, questions, settings)
    return { model: parts[0]?.response?.model, answers: norm.answers, usage: merged.usage, meta: { ...merged.meta, uninformative: norm.uninformative, corrected: norm.corrected } }
  }
  return {
    systemOne,
    /** The warm-up of 7.5; `calls` carry each phase's milliseconds and input tokens. */
    warmUp: ({ full = false, signal } = {}) => runCalls(systemOne, warmUpCalls({ full }), { now, signal }),
    /** The protocol checks of 4.6 alone, for the install's step 7. */
    protocol: ({ signal } = {}) => runCalls(systemOne, selfTestCalls().protocol, { now, signal }),
    /** The whole of Test Laya through this bare client. */
    selfTest: ({ identity, signal } = {}) => runSelfTest(systemOne, { identity, device: connection.device ?? null, now, signal }),
  }
}
