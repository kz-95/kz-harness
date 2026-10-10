// What a person can actually see about a routing decision. The inspector is a browser file the
// test runner cannot import, so this checks the two things it renders from: the event lines the
// server writes into the log and the task rows, and the decision record the run carries.
//
// It is a contract test in both directions. A field the inspector reads must exist on the record,
// and nothing the record carries may be a secret, a prompt or a task text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decidedBy, line } from '../adapter.js'

const client = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

test('every router event has a line a person can read, with no raw type names left over', () => {
  const events = [
    { type: 'start', task: 't' },
    { type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev' }, plan: { strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW', reviewer: 'codex' } },
    { type: 'decision', decision: { domains: { task_classification: { authority: 'local' }, resource_selection: { authority: 'jev' } }, jevCalls: 1, candidates: [{}, {}, {}] } },
    { type: 'tiebreak', from: 'deepseek', to: 'claude', confidence: 0.41, margin: 0.1 },
    { type: 'stalled', attempts: 2, agents: ['claude', 'codex'] },
    { type: 'gate', agent: 'claude', to: 'codex', percent: 92, at: 90 },
    { type: 'capability', from: 'claude', to: 'deepseek', capability: 'ocr' },
    { type: 'attempt_start', agent: 'claude', role: 'plan' },
    { type: 'final', status: 'accepted' },
  ]
  for (const e of events) {
    const text = line(e)
    assert.ok(text && text.length > 10, `${e.type} needs a readable line, got "${text}"`)
    assert.notEqual(text, e.type, `${e.type} fell through to the default and printed its own name`)
  }
})

test('the routed line names the strategy and the reviewer, so the reasoning block tells the story', () => {
  const text = line({ type: 'routed', routing: { primaryAgent: 'deepseek', mode: 'jev' }, plan: { strategy: 'PREMIUM_PLAN_CHEAP_EXECUTE', reviewer: 'claude' } })
  assert.match(text, /deepseek/)
  assert.match(text, /premium plan cheap execute/)
  assert.match(text, /claude reviews/)
  // A plain direct run says nothing extra: the common case stays quiet.
  assert.equal(line({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev' }, plan: { strategy: 'STANDARD_DIRECT' } }), 'Routed to claude (jev)')
})

test('the decision line says who decided and what it cost', () => {
  const allLocal = line({ type: 'decision', decision: { domains: { task_classification: { authority: 'local' }, resource_selection: { authority: 'local' } }, jevCalls: 0, candidates: [{}, {}] } })
  assert.match(allLocal, /^the local router \(task classification, resource selection\) decided;/)
  assert.match(allLocal, /no Jev call/)
  const taught = line({ type: 'decision', decision: { domains: { task_classification: { authority: 'jev' } }, jevCalls: 2, candidates: [{}] } })
  assert.match(taught, /Jev decided/)
  assert.match(taught, /2 Jev calls/)
  // A real adaptive run: rules in code rank the resources and answer the frontier review, so the
  // line never credits Jev, or the local router, with the whole run.
  const domains = {
    task_classification: { authority: 'local' }, skill_selection: { authority: 'jev' }, resource_selection: { authority: 'code' },
    execution_strategy: { authority: 'jev' }, second_opinion: { authority: 'jev' }, frontier_escalation: { authority: 'code' },
  }
  const real = line({ type: 'decision', decision: { domains, jevCalls: 1, candidates: [{}, {}, {}] } })
  assert.equal(real, 'the local router (task classification), Jev and routing rules decided; 1 Jev call; 3 candidates considered')
  assert.equal(decidedBy({ ...domains, task_classification: { authority: 'jev' } }), 'Jev and routing rules decided')
  assert.equal(decidedBy({ resource_selection: { authority: 'code' } }), 'routing rules decided')
  assert.equal(decidedBy({ task_classification: { authority: 'fallback' }, resource_selection: { authority: 'fallback' } }), 'safe fallback, nothing could decide')
  assert.equal(decidedBy({ task_classification: { authority: 'fallback' }, resource_selection: { authority: 'code' } }), 'routing rules and the safe fallback (task classification) decided')
  assert.equal(decidedBy({}), null, 'no per-domain report: the caller says Jev, as legacy named routing is')
  // A heading with the per-domain list under it names the authorities only.
  assert.equal(decidedBy(domains, { detail: false }), 'the local router, Jev and routing rules decided')
  assert.equal(decidedBy({ task_classification: { authority: 'fallback' }, resource_selection: { authority: 'code' } }, { detail: false }), 'routing rules and the safe fallback decided')
})

test('the inspector reads the decision record, and reads it by the names the record uses', () => {
  // A rename on either side breaks the view silently, because the client is a classic script the
  // test runner cannot import. This is the tripwire for that.
  assert.match(client, /function RoutingDecision/, 'the decision card exists')
  assert.match(client, /function RouterView/, 'and the router state view')
  assert.match(client, /'\/jev-router\/routing'/, 'which reads the routing endpoint')
  for (const field of ['decision.domains', 'd.candidates', 'd.excluded', 'gateOverride', 'belowFloor', 'minimumCapability']) {
    const name = field.split('.').pop()
    assert.ok(client.includes(name), `the inspector reads ${name}`)
  }
  for (const word of ['evidenceSamples', 'scarcity', 'expectedCost', 'resetInMinutes', 'requiredConfidence', 'rollbackReason', 'oodRate']) {
    assert.ok(client.includes(word), `the inspector shows ${word}`)
  }
})

test('the inspector never renders a capability score without saying how much evidence is behind it', () => {
  // A number with no evidence behind it reads exactly like one with hundreds of runs behind it,
  // which is the one way this view could mislead.
  assert.match(client, /const evidenceNote = /)
  assert.match(client, /little evidence/)
  assert.match(client, /well evidenced/)
})

test('the Router tab is reachable and names every maturity state in words', () => {
  assert.match(client, /tab\('router', 'Router'\)/)
  for (const state of ['JEV_PRIMARY', 'SHADOW', 'GUARDED_LOCAL', 'LOCAL_ONLY', 'ROLLBACK']) {
    assert.ok(client.includes(state), `${state} is explained in the view`)
  }
  assert.match(client, /MATURITY_WORDS/, 'and each is written out in plain words, not left as an identifier')
})

// The pure display helpers, evaluated on their own with the client's real `pct` and
// `evidenceNote`, so what the Router tab and the decision card print can be checked as behaviour
// rather than as text that happens to appear in the file.
const helpers = (() => {
  const grab = (re) => {
    const m = client.match(re)
    assert.ok(m, `client.js still defines ${re}`)
    return m[0]
  }
  const start = client.indexOf('// ---- pure display helpers')
  const end = client.indexOf('// ---- end pure display helpers')
  assert.ok(start > 0 && end > start, 'the pure helper block is marked')
  // [^\r\n], not `.`: `.` stops at \r, so with a Windows (CRLF) checkout `.*\n` never matches.
  const src = [grab(/const pct = [^\r\n]*/), grab(/const evidenceNote = [^\r\n]*/), client.slice(start, end)].join('\n')
  return new Function(`${src}\nreturn { pct, evidenceNote, provenanceOf, limitText, gateNotes, moveNotes }`)()
})()

test('the Router tab marks an estimated share spent as an estimate, at its own confidence', async () => {
  const { snapshotResources, provenanceOf } = await import('../resources.js')
  const NOW = '2026-09-22T12:00:00.000Z'
  // The DeepSeek case: 40 left of a high-water mark of 100. The balance is the provider's word;
  // the 60% spent is worked out from a mark nobody reported.
  const agents = [{ id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }]
  const row = { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 40, currency: 'USD' }, creditPercent: 40, creditPeak: { amount: 100, currency: 'USD' }, limits: { minBalance: 5, handoffAtBalance: 10 }, error: null, checkedAt: NOW, state: 'ok', until: null }
  const [snap] = snapshotResources({ agents, usage: { deepseek: row }, now: Date.parse(NOW) })
  const [limit] = snap.limits
  for (const f of ['ratioUsed', 'remaining', 'used', 'total']) assert.deepEqual(helpers.provenanceOf(limit, f), provenanceOf(limit, f), `the client reads ${f}'s provenance as resources.js does`)
  const text = helpers.limitText(limit)
  assert.match(text, /60\.0% used \(estimated, little evidence\)/, text)
  assert.match(text, /40 USD left \(from the provider, well evidenced\)/, text)
  // The same balance with no mark: one figure, one note, the provider's.
  const bare = helpers.limitText({ ...limit, ratioUsed: null, used: null, total: null, fieldSources: null })
  assert.equal(bare, 'balance 40 USD left (from the provider, well evidenced)')
  // A subscription window the provider reported whole: said once.
  const [sub] = snapshotResources({ agents: [{ id: 'claude', provider: 'claude-code' }], usage: { claude: { kind: 'subscription', provider: 'claude-code', windows: [{ name: 'weekly', minutes: 10080, usedPercent: 73, resetsAt: null }], limits: {}, error: null, checkedAt: NOW, state: 'ok', until: null } }, now: Date.parse(NOW) })
  assert.equal(helpers.limitText(sub.limits[0]), 'weekly 73.0% used (from the provider, well evidenced)')
  // And the view uses it: no line prints the snapshot's single source over its limits any more.
  assert.match(client, /r\.limits\.map\(limitText\)/)
  assert.doesNotMatch(client, /` · \$\{r\.usageSource\.replace/)
})

test('the inspector says when the weekly gate yielded, in words, with or without a decision record', () => {
  const { gateNotes } = helpers
  assert.deepEqual(gateNotes({ primaryAgent: 'claude' }), [])
  assert.match(gateNotes({ primaryAgent: 'claude', gateYielded: 'capability' })[0], /claude was kept despite its weekly gate: every agent that can do this request is past its gate/)
  assert.match(gateNotes({ primaryAgent: 'codex', gateYielded: 'everything_gated' })[0], /codex was kept despite its weekly gate: every agent is past its gate/)
  assert.match(gateNotes({ primaryAgent: 'claude', decision: { gateOverride: true } })[0], /frontier capability/)
  for (const n of gateNotes({ primaryAgent: 'claude', gateYielded: 'everything_gated' })) assert.doesNotMatch(n, /_/, 'no identifiers left in the words')
  // Rendered on the decision card, and on the run view whenever that card is not beside it: the
  // Overview ledger shows a live run's WhatHappened alone, and a stored run's detail never had them.
  assert.match(client, /\.\.\.gateNotes\(R\)\.map/)
  assert.match(client, /R\.decision && decisionCard \? \[\] : gateNotes\(R\)/)
  assert.match(client, /h\(WhatHappened, \{ s, decisionCard: true \}\),\s*h\(RoutingDecision, \{ s \}\)/, 'only the view that renders the decision card beside it leaves the notes to it')
  assert.doesNotMatch(client, /h\(WhatHappened, \{ s: summarize\(row\.live\), decisionCard/, 'the ledger shows them itself')
  const detail = client.slice(client.indexOf('function HistoryRunDetail('), client.indexOf('function OverviewRow('))
  assert.match(detail, /\.\.\.gateNotes\(R\)\.map/, 'a stored run says so too')
})

test('the inspector names every move the router made, in the report\'s own words', async () => {
  const { moveLine, movesOf } = await import('../router.js')
  const { moveNotes } = helpers
  const R = { primaryAgent: 'claude', capability: 'web_research', moves: [{ kind: 'capability', from: 'qwen-local', to: 'acme' }, { kind: 'tiebreak', from: 'acme', to: 'deepseek' }, { kind: 'gate', from: 'deepseek', to: 'codex' }, { kind: 'feedback', from: 'codex', to: 'claude' }] }
  assert.deepEqual(moveNotes(R), movesOf(R).map((m) => moveLine(m, R)), 'the client and the report say the same thing')
  assert.match(moveNotes(R)[0], /qwen-local cannot do this \(web_research\): acme took the work/)
  // An old record: the fields, each read as a move to the final primary.
  const legacy = { primaryAgent: 'claude', gatedFrom: 'acme', tiebrokeFrom: 'deepseek' }
  assert.deepEqual(moveNotes(legacy), movesOf(legacy).map((m) => moveLine(m, legacy)))
  assert.deepEqual(moveNotes({ primaryAgent: 'claude' }), [])
  // Rendered on the live run view and on a stored run, and "<decider> picked" names the decider's own pick.
  assert.equal((client.match(/\.\.\.moveNotes\(R\)\.map/g) ?? []).length, 2)
  assert.match(client, /\$\{who\} picked \$\{movesOf\(R\)\[0\]\?\.from \?\? R\.primaryAgent\}/)
})

// ---------- who decided, and what Laya answered beside Jev (docs/laya-auto.md 3.3, 5.6) ----------

// The display helpers the Laya views add, evaluated on their own as the block above is, and read
// inside each test, so a client without them fails the test by assertion rather than the file.
function display() {
  for (const name of ['deciderName', 'answerPills', 'callCard', 'failedCall', 'shadowCell', 'shadowHeader']) assert.match(client, new RegExp(`const ${name} = `), `client.js defines ${name}`)
  const start = client.indexOf('// ---- pure display helpers')
  const end = client.indexOf('// ---- end pure display helpers')
  const src = [/const pct = [^\r\n]*/, /const evidenceNote = [^\r\n]*/].map((re) => client.match(re)[0]).concat(client.slice(start, end)).join('\n')
  return new Function(`${src}\nreturn { deciderName, answerPills, callCard, failedCall, shadowCell, shadowHeader }`)()
}

// client.js run with a React whose createElement only records what it was asked for, as
// budgetpanel.test.js renders the budget; `expand` calls the components in the tree in place.
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
function plugin() {
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', client)(window)
  const React = { createElement, Fragment: 'fragment', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) }).__test
}
const expand = (n) => (!n || typeof n !== 'object' ? n : typeof n.type === 'function' ? expand(n.type({ ...n.props, children: n.children })) : { ...n, children: n.children.map(expand) })
const nodes = (n) => (n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [])
const textOf = (n) => (n == null || n === false ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

/** Every question answered, as a provider answers it, with the marks given by name. */
const answering = (questions, marks = {}) => Object.fromEntries(Object.entries(questions).map(([name, q]) => {
  if (q.type === 'noul') return [name, { type: 'noul', noul: 0.8, confidence: 0.8, ...marks[name] }]
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1)]))
  return [name, { type: q.type, ...(q.type === 'choice' ? { choice: keys[0] } : { score: 0.5 }), probabilities, confidence: 0.7, ...marks[name] }]
}))

/**
 * One intent call through jev.js as each provider answers it, and the trace, or the onError payload
 * of a call that failed, that the inspector is handed: so the card reads the names jev.js writes.
 */
async function calls() {
  const jevJs = await import('../jev.js')
  const { resolveProviders } = await import('../providers.js')
  const { resolvePolicy } = await import('../routing-policy.js')
  const providers = resolveProviders({}, { policy: resolvePolicy() })
  // createJev with a provider record and a client of the caller's own, which it must use. One that
  // took neither would build a TypeSafe client, and with no key that client refuses to exist.
  const createJev = (options) => {
    let made
    assert.doesNotThrow(() => { made = jevJs.createJev(options) }, 'createJev takes a provider record and the client it is handed')
    return made
  }
  const traces = []
  const errors = []
  const laya = createJev({
    provider: providers.laya,
    client: { systemOne: async ({ questions }) => ({ model: 'laya-english/0.3.20@1a2b3c4', answers: answering(questions, { kind: { corrected: true }, depth: { informative: false } }), usage: { input_tokens: 5610, output_tokens: 0 }, meta: { provider: 'laya', device: 'cuda', waitedMs: 0, requests: 2, rows: 3, atContextLimit: 0, lang: 'latin' } }) },
    onTrace: (t) => traces.push(t), onError: (e) => errors.push(e),
  })
  const jev = createJev({
    provider: providers.jev, apiKey: 'test',
    client: { systemOne: ({ questions }) => ({ withResponse: async () => ({ data: { model: 'jev-1.13.0', answers: answering(questions), usage: { input_tokens: 1200, output_tokens: 30 } }, requestId: 'req_7Hq2' }) }) },
    onTrace: (t) => traces.push(t),
  })
  const broken = createJev({
    provider: providers.laya,
    client: { systemOne: async () => { throw Object.assign(new Error('timed out after 42 s (20 questions on the CPU)'), { code: 'LAYA_TIMEOUT' }) } },
    onError: (e) => errors.push(e),
  })
  await laya.intent({ message: 'Fix the failing test in src/parser.ts' })
  await jev.intent({ message: 'Fix the failing test in src/parser.ts' })
  await broken.intent({ message: 'Fix the failing test in src/parser.ts' }).catch(() => {})
  return { laya: traces[0], jev: traces[1], failed: { type: 'decider-error', at: Date.now(), error: errors[0] } }
}

test('a Laya call names Laya, its model and what it counted on this PC at $0, with no request id; a Jev call reads as it did', async () => {
  const { callCard } = display()
  const t = await calls()
  assert.deepEqual(callCard(t.laya), {
    head: 'Intent: 4 questions in 2 requests on the GPU',
    label: 'Laya · laya-english/0.3.20@1a2b3c4 · 5,610 tokens on this PC ($0)',
    requestId: 'none (local)',
    notes: [],
  })
  assert.deepEqual(callCard(t.jev), { head: 'Intent: 4 questions in one request', label: 'jev-1.13.0 · 1200 in / 30 out tokens', requestId: 'req_7Hq2', notes: [] })
  // A trace from before `provider` was recorded is Jev's.
  const { provider, ...old } = t.jev
  assert.equal(provider, 'jev')
  assert.deepEqual(callCard(old), callCard(t.jev))
  // What Laya's client adds: the wait behind an earlier answer, a request at the 512-token
  // context, and a task that is not English.
  const cut = callCard({ ...t.laya, phase: 'review', meta: { ...t.laya.meta, waitedMs: 4200, requests: 4, atContextLimit: 1, lang: 'non-latin' } })
  assert.equal(cut.head, 'Review: 4 questions in 4 requests on the GPU', 'the intent call\'s four, relabelled as a review for the notes')
  assert.deepEqual(cut.notes, [
    'Waited 4200 ms for an earlier Laya answer.',
    '1 of 4 requests reached the 512-token limit, so part of the evidence was cut.',
    "Laya's English checkpoint is unreliable outside English.",
  ])
})

test('the uncalibrated pill follows each answer\'s own corrected mark, never its question\'s name, and a flat answer says what became of it', async () => {
  const { answerPills } = display()
  const t = await calls()
  const by = Object.fromEntries(t.laya.questions.map((q) => [q.name, answerPills(q).map(([, text]) => text)]))
  // The marks as jev.js carries them onto the trace: re-tempered, and too flat for the rules to use.
  assert.deepEqual(by, { kind: ['uncalibrated (2 options)'], depth: ['too flat, filled by rules'], alsoWork: [], readOnly: [] })
  assert.deepEqual(t.jev.questions.map(answerPills), [[], [], [], []], 'Jev marks none')
  // A capability question asked with all nine capabilities and the two others is re-tempered; one
  // asked with seven is not, whatever it is called.
  const options = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, 1 / n]))
  assert.deepEqual(answerPills({ name: 'capability', type: 'choice', probabilities: options(11), corrected: true }).map(([, x]) => x), ['uncalibrated (11 options)'])
  assert.deepEqual(answerPills({ name: 'capability', type: 'choice', probabilities: options(7) }), [])
  assert.deepEqual(answerPills({ name: 'strategy', type: 'choice', probabilities: options(11), corrected: true }).map(([, x]) => x), ['uncalibrated (11 options)'])
  // A flat yes/no other than the second opinion, and a flat disposition, are kept as answered (4.3).
  assert.deepEqual(answerPills({ name: 'needsPerson', type: 'noul', informative: false }).map(([, x]) => x), ['too flat, kept as answered'])
  assert.deepEqual(answerPills({ name: 'secondOpinion', type: 'noul', informative: false }).map(([, x]) => x), ['too flat, filled by rules'])
  assert.deepEqual(answerPills({ name: 'disposition', type: 'choice', probabilities: options(7), informative: false }).map(([, x]) => x), ['too flat, kept as answered'])
  // Rendered beside the question's name.
  const tree = expand(plugin().Questions({ calls: [{ trace: t.laya }] }))
  const kind = nodes(tree).find((n) => n.type === 'details' && nodes(n).some((c) => c.type === 'code' && textOf(c) === 'kind'))
  assert.ok(nodes(kind).some((n) => n.type === 'span' && n.props.className === 'pill warn' && textOf(n) === 'uncalibrated (2 options)'))
})

test('a flat second opinion is filled by the rules on the judgments call only; on a task-group call it is the profile\'s, kept as answered', () => {
  const { Questions } = plugin()
  assert.equal(typeof Questions, 'function', 'the call cards can be rendered')
  const q = (name, type = 'noul') => ({ name, type, used: true, informative: false, answer: type === 'noul' ? 0.5 : 'a', probabilities: type === 'noul' ? undefined : { a: 0.5, b: 0.5 }, question: name })
  const call = (questions) => ({ trace: { phase: 'route', ms: 900, provider: 'laya', model: 'laya-english/0.3.20@1a2b3c4', questions, meta: { device: 'cpu' } } })
  const pillOf = (tree, name) => {
    const card = nodes(tree).find((n) => n.type === 'details' && nodes(n).some((c) => c.type === 'code' && textOf(c) === name))
    return nodes(card).filter((n) => n.type === 'span' && n.props.className === 'pill warn').map(textOf)
  }
  const [task, judgments] = expand(Questions({ calls: [call([q('taskType', 'choice'), q('secondOpinion')]), call([q('strategy', 'choice'), q('secondOpinion')])] })).children
  assert.deepEqual(pillOf(task, 'taskType'), ['too flat, filled by rules'])
  assert.deepEqual(pillOf(task, 'secondOpinion'), ['too flat, kept as answered'])
  assert.deepEqual(pillOf(judgments, 'secondOpinion'), ['too flat, filled by rules'])
})

test('a Laya call that timed out is a card that says how many questions it asked and where, as the live line does', () => {
  const { failedCall } = display()
  // What jev.js keeps of the Laya client's timeout (errorOf): the size and device beside the message.
  const late = (error) => ({ type: 'decider-error', at: 1, error: { phase: 'route', provider: 'laya', ms: 42000, error: { class: 'Error', status: null, message: 'timed out after 40 s', ...error } } })
  assert.deepEqual(failedCall(late({ code: 'LAYA_TIMEOUT', questions: 20, device: 'cpu' })), { head: 'Laya · Routing', text: 'failed after 42000 ms: timed out after 40 s (20 questions on the CPU)' })
  assert.deepEqual(failedCall(late({ code: 'LAYA_TIMEOUT', questions: 4, device: 'cuda' })).text, 'failed after 42000 ms: timed out after 40 s (4 questions on the GPU)')
  assert.deepEqual(failedCall(late({ code: 'LAYA_HTTP_500', message: 'Laya refused this call (HTTP 500: inference failed)' })).text, 'failed after 42000 ms: Laya refused this call (HTTP 500: inference failed)')
})

test('a call that did not answer is a card that says who, which call, how long and why, with no questions', async () => {
  const { failedCall } = display()
  const t = await calls()
  assert.equal(t.failed.error.provider, 'laya', 'the payload onError is handed')
  assert.deepEqual(failedCall({ ...t.failed, error: { ...t.failed.error, ms: 42000 } }), { head: 'Laya · Intent', text: 'failed after 42000 ms: timed out after 42 s (20 questions on the CPU)' })
  assert.deepEqual(failedCall({ type: 'decider-error', at: 1, error: { phase: 'route', provider: 'jev', ms: 20012, error: { class: 'APIConnectionTimeoutError', message: 'Request timed out.' } } }), { head: 'Jev · Routing', text: 'failed after 20012 ms: Request timed out.' })
  // In the run, in the order the calls settled: the failed call's card has no question in it.
  const { summarize, Questions } = plugin()
  const run = { id: 'r1', task: 't', startedAt: 1, events: [{ type: 'start', at: 1 }, { type: 'jev', at: 2, trace: t.laya }, { ...t.failed, at: 3, error: { ...t.failed.error, phase: 'route', ms: 42000 } }] }
  const s = summarize(run)
  assert.deepEqual(s.calls.map((c) => (c.trace ? 'answered' : 'failed')), ['answered', 'failed'])
  assert.equal(s.traces.length, 1, 'a failed call is no trace, so nothing that reads questions meets one without them')
  const cards = expand(Questions({ calls: s.calls })).children
  assert.equal(cards.length, 2)
  assert.deepEqual([textOf(cards[1].children[0]), textOf(cards[1].children[1])], ['Laya · Routing', 'failed after 42000 ms: timed out after 42 s (20 questions on the CPU)'])
  assert.ok(!nodes(cards[1]).some((n) => n.type === 'details'), 'with no questions')
})

/** A shadow row of 5.3 for one Jev call, with both sides as recorded: `jev` and `laya` are `{ name: [type, answer, confidence, p] }`. */
function shadowRow({ callId = 'c1', phase = 'route', status = 'answered', reason = null, jev = {}, laya = {}, ...over } = {}) {
  const side = (qs) => Object.fromEntries(Object.entries(qs).map(([name, [type, answer, confidence = null, p = null]]) => [name, { type, answer, p, confidence }]))
  return {
    id: `row-${callId}`, ts: '2026-09-24T12:00:00.000Z', runId: 'run-1', callId, phase, groups: phase === 'route' ? ['task'] : null,
    attempt: phase === 'review' ? 0 : null, review: phase === 'review' ? { risk: 0.4, blockAccept: false, reviewed: false } : null,
    identity: 'laya-0.3.20|english|1a2b3c4d5e6f|adapter-1|corr:choice:11+=3.27|margin:0.1', device: 'cuda', lang: 'latin',
    thresholds: { jev: 'a1b2c3d4e5f6', laya: '0f1e2d3c4b5a' }, status, reason, queuedMs: 12, ms: 950, rows: 3, requests: 1, atContextLimit: 0,
    jev: { model: 'jev-1.13.0', host: 'api.typesafe.ai', ms: 800, error: null, questions: side(jev) },
    laya: { questions: Object.fromEntries(Object.entries(side(laya)).map(([k, v]) => [k, { ...v, informative: true, corrected: false }])) },
    ...over,
  }
}

test('each question of a Jev call gains Laya\'s answer and a mark, and the card says how many Laya answered and how many agree', () => {
  const { shadowCell, shadowHeader } = display()
  const row = shadowRow({
    jev: { taskType: ['choice', 'bugfix', 0.8], risk: ['score', 2.4, 0.6, [0, 0.1, 0.4, 0.4, 0.1]], complexity: ['score', 2.4, 0.5], needsTests: ['noul', 0.55, 0.55], humanReview: ['noul', 0.2, 0.8], 'fmt.fits': ['noul', 0.9, 0.9], 'fmt.style': ['choice', '#1', 0.7] },
    laya: { taskType: ['choice', 'bugfix', 0.41], risk: ['score', 1.6, 0.35, [0.1, 0.3, 0.35, 0.2, 0.05]], complexity: ['score', 1.4, 0.3], needsTests: ['noul', 0.45, 0.55], humanReview: ['noul', 0.1, 0.9], 'fmt.style': ['choice', '#2', 0.5] },
  })
  const cell = (name, r = row, o) => shadowCell(name, r, o)
  // The same pick; the same rounded level; a level apart; the two sides of 0.5; the same side.
  assert.deepEqual(cell('taskType'), { text: 'bugfix (41.0%)', mark: 'agrees', flat: false })
  assert.deepEqual(cell('risk'), { text: '1.60 of 4 (35.0%)', mark: 'agrees', flat: false })
  assert.equal(cell('complexity').mark, 'differs')
  assert.deepEqual(cell('needsTests'), { text: '45.0%', mark: 'differs', flat: false })
  assert.equal(cell('humanReview').mark, 'agrees')
  // A tool parameter's answer is its option index on both sides, never the person's own option key.
  assert.deepEqual(cell('fmt.style'), { text: '#2 (50.0%)', mark: 'differs', flat: false })
  // Laya left one out of an answered row: that part of the call failed.
  assert.equal(cell('fmt.fits').mark, 'failed')
  // A row cut short marks what it did not answer as waiting too long behind Laya's acting calls.
  assert.equal(cell('fmt.fits', { ...row, status: 'partial' }).mark, 'skipped: Laya was busy')
  // Each way the shadow can skip a call, in the card's words.
  const skipped = Object.fromEntries(['not_running', 'starting', 'queue_full', 'too_old', 'yielded', 'jev_failed'].map((reason) => [reason, cell('taskType', shadowRow({ status: 'skipped', reason })).mark]))
  assert.deepEqual(skipped, {
    not_running: 'skipped: Laya was not running',
    starting: 'skipped: Laya was starting',
    queue_full: 'skipped: Laya was busy',
    too_old: 'skipped: Laya was busy',
    yielded: 'skipped: Laya gave its memory to a local model',
    jev_failed: 'skipped: the Jev call failed',
  })
  assert.equal(cell('taskType', shadowRow({ status: 'failed', reason: 'LAYA_HTTP_500' })).mark, 'failed')
  // No row yet: waiting while one can still land, and no Laya column once none can.
  assert.deepEqual(cell('taskType', null, { waiting: true }), { text: null, mark: 'waiting for Laya' })
  assert.equal(cell('taskType', null, { waiting: false }), null)

  // The header: 27 of 29 answered, 21 of those agree.
  const names = Array.from({ length: 29 }, (_, i) => `q${i}`)
  const many = shadowRow({
    jev: Object.fromEntries(names.map((n) => [n, ['noul', 0.8, 0.8]])),
    laya: Object.fromEntries(names.slice(0, 27).map((n, i) => [n, ['noul', i < 21 ? 0.7 : 0.2, 0.8]])),
  })
  assert.deepEqual(shadowHeader(names, many), ['Laya shadow: 27 of 29 questions answered, 21 agree (78%). Laya decides nothing in Jev Auto.'])
  assert.deepEqual(shadowHeader(names, shadowRow({ status: 'skipped', reason: 'yielded' })), ['Laya shadow: skipped: Laya gave its memory to a local model. Laya decides nothing in Jev Auto.'])
  assert.deepEqual(shadowHeader(names, null, { waiting: true }), ['Laya shadow: waiting for Laya. Laya decides nothing in Jev Auto.'])
  assert.deepEqual(shadowHeader(names, null), [])
  // A review call adds the action each side's answers give under its own thresholds.
  const review = shadowRow({ phase: 'review', jev: { addressed: ['noul', 0.9, 0.9] }, laya: { addressed: ['noul', 0.7, 0.7] }, actions: { jev: 'accept', laya: 'second_review' } })
  assert.deepEqual(shadowHeader(['addressed'], review), ['Laya shadow: 1 of 1 questions answered, 1 agree (100%). Laya decides nothing in Jev Auto.', 'Review action: Jev accept, Laya second_review.'])
})

test('a review call\'s review action line reads the row the shadow writes, each side at its own accept bar', async (t) => {
  const { createJev } = await import('../jev.js')
  const { resolveProviders } = await import('../providers.js')
  const { createShadow } = await import('../shadow.js')
  const { waitFor } = await import('./wait-for.js')
  const { mkdtempSync, readFileSync: read, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const providers = resolveProviders({}, {})
  const dir = mkdtempSync(join(tmpdir(), 'kz-obs-shadow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The same answers on both sides: quality 0.75 at risk 0.4 clears Jev's medium bar (0.7) and not Laya's (0.8).
  const marks = { addressed: { noul: 0.75 }, complete: { noul: 0.8 }, unrelatedChanges: { noul: 0.1 }, regressionRisk: { noul: 0.1 }, needsPerson: { noul: 0.05 } }
  const laya = {
    identity: () => 'laya-0.3.20|english|1a2b3c4d5e6f|adapter-1|corr:choice:11+=3.27|margin:0.1',
    offerShadow(job) {
      const answers = Object.fromEntries(Object.entries(answering(job.questions, marks)).map(([k, v]) => [k, { ...v, informative: true, corrected: false }]))
      setImmediate(() => job.onDone({ status: 'answered', reason: null, answer: { model: 'laya-english/0.3.20@1a2b3c4', answers, usage: { input_tokens: 900, output_tokens: 0 }, meta: { provider: 'laya', device: 'cuda', rows: 5, requests: 1, atContextLimit: 0, lang: 'latin' } }, queuedMs: 1, ms: 900 }))
      return { queued: true }
    },
    withdraw: () => false,
  }
  const file = join(dir, 'laya-shadow.jsonl')
  const shadow = createShadow({ file, laya, providers })
  const jev = createJev({
    provider: providers.jev, apiKey: 'test', onCall: shadow.offerer({ runId: 'run-review' }),
    client: { systemOne: ({ questions }) => ({ withResponse: async () => ({ data: { model: 'jev-1.13.0', answers: answering(questions, marks), usage: { input_tokens: 1200, output_tokens: 30 } }, requestId: 'req_r1' }) }) },
  })
  const input = {
    task: 'Fix the failing test', routing: { taskType: 'bugfix', risk: 0.4, complexity: 0.5 },
    attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', answerText: 'Fixed.', changedFiles: ['src/a.js'] }],
    checks: { results: [] }, diff: { stat: '1 file changed', patch: '+x' }, agents: [{ id: 'claude', description: 'a' }, { id: 'codex', description: 'b' }],
  }
  await jev.assess(input, new AbortController().signal, { attempt: 1, risk: 0.4, blockAccept: false, reviewed: false })
  const [row] = await waitFor('the review row', () => shadow.read({ runId: 'run-review' }), (rows) => rows.length === 1, { timeoutMs: 5000 })
  await shadow.flush()
  assert.equal(row.phase, 'review')
  assert.deepEqual(row.actions, { jev: 'accept', laya: 'second_review' })
  assert.deepEqual(JSON.parse(read(file, 'utf8').trim()).actions, row.actions, 'the file keeps what the inspector is served')
  const { shadowHeader } = display()
  assert.equal(shadowHeader(Object.keys(row.jev.questions), row).at(-1), 'Review action: Jev accept, Laya second_review.')
})

test('the Decisions tab shows the Laya column under a Jev call, never under a Laya call', async () => {
  const { Questions } = plugin()
  assert.equal(typeof Questions, 'function', 'the call cards can be rendered')
  const t = await calls()
  const row = shadowRow({ callId: t.jev.callId, phase: 'intent', jev: { kind: ['choice', 'task', 0.7], depth: ['choice', 'everyday', 0.7], alsoWork: ['noul', 0.8, 0.8], readOnly: ['noul', 0.3, 0.7] }, laya: { kind: ['choice', 'question', 0.6], depth: ['choice', 'everyday', 0.55], alsoWork: ['noul', 0.7, 0.7], readOnly: ['noul', 0.2, 0.8] } })
  const shadow = { rows: new Map([[row.callId, row]]), waiting: true }
  const [jevCard, layaCard] = expand(Questions({ calls: [{ trace: t.jev }, { trace: t.laya }], shadow })).children
  assert.ok(textOf(jevCard).includes('Laya shadow: 4 of 4 questions answered, 3 agree (75%). Laya decides nothing in Jev Auto.'), textOf(jevCard))
  assert.ok(textOf(jevCard).includes('Request id: req_7Hq2'))
  const laya = nodes(jevCard).filter((n) => n.props.className === 'why shadow').map(textOf)
  assert.deepEqual(laya, ['Laya: question (60.0%)differs', 'Laya: everyday (55.0%)agrees', 'Laya: 70.0%agrees', 'Laya: 20.0%agrees'])
  assert.ok(!textOf(layaCard).includes('Laya shadow'), 'a Laya call is compared with nothing')
  assert.ok(textOf(layaCard).includes('Request id: none (local)'))
  assert.equal(nodes(layaCard).filter((n) => n.props.className === 'why shadow').length, 0)
})

/**
 * A stand-in React that keeps state across renders for the one component mounted, as
 * laya-card.test.js has it; the components it renders are called in place, their hooks taken as the
 * mounted one's, and it renders again on the next microtask after a state change, as React batches it.
 */
function statefulReact() {
  let current = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const slot = () => { const v = current; return [v, v.i++] }
  const React = {
    createElement,
    Fragment: 'fragment',
    useState: (init) => {
      const [v, k] = slot()
      if (!(k in v.slots)) v.slots[k] = typeof init === 'function' ? init() : init
      return [v.slots[k], (x) => { const next = typeof x === 'function' ? x(v.slots[k]) : x; if (!Object.is(next, v.slots[k])) { v.slots[k] = next; v.schedule() } }]
    },
    useEffect: (fn, deps) => {
      const [v, k] = slot()
      const prev = v.slots[k]
      if (prev && same(prev.deps, deps)) return
      v.slots[k] = { deps, cleanup: null }
      v.effects.push(() => { prev?.cleanup?.(); v.slots[k].cleanup = fn() ?? null })
    },
    useCallback: (f, deps) => {
      const [v, k] = slot()
      if (v.slots[k] && same(v.slots[k].deps, deps)) return v.slots[k].f
      v.slots[k] = { f, deps }
      return f
    },
    useRef: (init) => { const [v, k] = slot(); if (!(k in v.slots)) v.slots[k] = { current: init }; return v.slots[k] },
  }
  const mount = (Component, props) => {
    const view = { slots: [], i: 0, effects: [], queued: false, tree: null }
    view.render = () => {
      view.queued = false; view.i = 0; view.effects = []
      // The components in the tree are called with the mounted one's hooks, in the same order each time.
      current = view
      view.tree = expand(Component(props))
      current = null
      for (const run of view.effects) run()
    }
    view.schedule = () => { if (!view.queued) { view.queued = true; queueMicrotask(view.render) } }
    view.unmount = () => { for (const x of view.slots) x?.cleanup?.() }
    view.render()
    return view
  }
  return { React, mount }
}

/**
 * The Decisions tab as the inspector runs it, behind GET /jev-router/laya/shadow answering
 * `page.rows`, with the timers it sets recorded rather than run: `page.wait()` runs the ones due
 * and lets what they cause settle, and `page.gets` counts the reads.
 */
async function decisionsPage(runs) {
  const page = { rows: [], gets: [], timers: new Map() }
  let busy = 0
  let id = 0
  const fetch = async (path) => {
    busy++
    try {
      page.gets.push(path)
      const text = JSON.stringify(path.startsWith('/jev-router/laya/shadow?') ? { rows: page.rows } : { error: 'not found' })
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const setTimeout = (f, ms) => { page.timers.set(++id, { f, ms }); return id }
  const clearTimeout = (t) => { page.timers.delete(t) }
  const { React, mount } = statefulReact()
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', client)(window, fetch, setTimeout, clearTimeout)
  const { Decisions } = registration.factory((x) => { if (x === 'react') return React; throw new Error(`unexpected require: ${x}`) }).__test
  const view = mount(Decisions, { runs })
  page.settle = async () => {
    for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r))
  }
  page.wait = async () => {
    const due = [...page.timers.values()]
    page.timers.clear()
    for (const t of due) t.f()
    await page.settle()
  }
  page.render = async () => { view.render(); await page.settle() }
  page.pending = () => [...page.timers.values()].map((t) => t.ms)
  page.text = () => textOf(view.tree)
  page.close = () => view.unmount()
  await page.settle()
  return page
}

/**
 * The work board as the chat shows it, behind GET /jev-router/tasks answering `tasks`, with every
 * POST recorded and the timers it sets held rather than run. With `tab`, the inspector's Background
 * tab is mounted instead and handed `tasks` directly, as the inspector hands it the ones it polls.
 */
async function workBoardPage(tasks, { tab = false } = {}) {
  // `answers` holds what a POST to a path answers, Stop's `stopResult` otherwise.
  const page = { posts: [], answers: {} }
  let busy = 0
  page.stopResult = 'requested'
  const fetch = async (path, init) => {
    busy++
    try {
      if (init?.method === 'POST') page.posts.push([path, JSON.parse(init.body)])
      const body = path === '/jev-router/tasks' ? { tasks } : page.answers[path] ?? { result: page.stopResult }
      return { ok: true, status: 200, json: async () => body }
    } finally { busy-- }
  }
  const hold = () => 0
  // The timers the board sets are kept, not run: page.poll() runs them, as the list's next poll.
  const timers = []
  const later = (fn) => { timers.push(fn); return timers.length }
  const document = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } }
  const { React, mount } = statefulReact()
  let registration
  // The confirmation listens for Escape on the window.
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'document', client)(window, fetch, later, hold, hold, hold, document)
  const { WorkBoard, Tasks } = registration.factory((x) => { if (x === 'react') return React; throw new Error(`unexpected require: ${x}`) }).__test
  assert.equal(typeof WorkBoard, 'function', 'the work board can be rendered')
  const view = tab ? mount(Tasks, { sessionId: 's1', runs: [], jobs: [], entries: [], tasks }) : mount(WorkBoard, { session: { sessionId: 's1' } })
  page.settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  page.buttons = () => nodes(view.tree).filter((n) => n.type === 'button')
  page.button = (label) => page.buttons().find((b) => b.props['aria-label'] === label || textOf(b) === label)
  page.click = async (label) => { page.button(label).props.onClick(); await page.settle() }
  page.text = () => textOf(view.tree)
  page.tree = () => view.tree
  page.render = async () => { view.render(); await page.settle() }
  page.poll = async () => { for (const fn of timers.splice(0)) fn(); await page.settle() }
  await page.settle()
  return page
}

test('the work board: a waiting row shows why and how long, its time in line, and is removed from the line on its own', async () => {
  const now = Date.now()
  const tasks = [
    { jobId: 'jev-1', sessionId: 's1', state: 'running', taskName: 'help me do a sample', startedAt: now - 60_000, agent: 'claude', position: 0 },
    { jobId: 'jev-2', sessionId: 's1', state: 'queued', taskName: 'realistic 1k to 1million', startedAt: null, queuedAt: now - 30_000, position: 2,
      waiting: { why: 'workspace', place: 2, ahead: 0, slotsAhead: 0, overCap: false, since: now - 30_000, placeText: '2nd in line', reason: 'Waiting: another task is running in this workspace',
        estimate: { lowMs: 240_000, highMs: 480_000, n: 5, text: 'Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review.' },
        text: 'Waiting: another task is running in this workspace. Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort with no planned review.' } },
  ]
  const page = await workBoardPage(tasks)
  const text = page.text()
  assert.match(text, /Waiting: another task is running in this workspace\. Starts in about 4 to 8 min, estimated from 5 past runs of claude at medium effort/)
  assert.match(text, /in line 3\d\.\d s/)
  assert.doesNotMatch(text, /starting/, 'a waiting row no longer reads "starting"')
  assert.ok(page.button('Stop help me do a sample'), 'a running row has its own Stop')
  assert.ok(page.button('Remove realistic 1k to 1million'), 'a waiting row has its own Remove')
  assert.equal(page.button('Stop all 2 tasks in this session: 1 running, 1 waiting').props.className, 'kzh-wb-stop')
  // Remove asks first, in words for a task that never started, and stops that one task only.
  await page.click('Remove realistic 1k to 1million')
  assert.match(page.text(), /Remove this task from the line\?"realistic 1k to 1million" has not started, so nothing in the workspace has changed/)
  assert.deepEqual(page.posts, [], 'nothing is sent before it is confirmed')
  await page.click('Remove task')
  assert.deepEqual(page.posts, [['/jev-router/tasks/stop', { jobId: 'jev-2', onlyIfWaiting: true }]], 'Remove stops it only while it still waits')
  // Cancel in the confirmation sends nothing.
  await page.click('Stop help me do a sample')
  await page.click('Cancel')
  assert.equal(page.posts.length, 1)
  // It started between the last poll and the click: the server stops nothing, and the board says why.
  page.stopResult = 'started'
  await page.click('Remove realistic 1k to 1million')
  await page.click('Remove task')
  assert.match(page.text(), /"realistic 1k to 1million" started before it could be removed, so it was not stopped\. Use Stop on its row to stop it\./)
})

// The waiting line, second pass: a dialog never changes what its button does, and Stop all covers
// what it named.
{
  const now = Date.now()
  const waitingRow = (over = {}) => ({ jobId: 'jev-2', sessionId: 's1', state: 'queued', taskName: 'realistic 1k to 1million', startedAt: null, queuedAt: now - 30_000, position: 2,
    waiting: { why: 'workspace', place: 2, ahead: 0, slotsAhead: 0, overCap: false, since: now - 30_000, placeText: '2nd in line', reason: 'Waiting: another task is running in this workspace', estimate: null, text: 'Waiting: another task is running in this workspace.' }, ...over })

  test('a Remove dialog whose task starts meanwhile closes and says it was not removed, rather than turning into Stop', async () => {
    const tasks = [
      { jobId: 'jev-1', sessionId: 's1', state: 'running', taskName: 'help me do a sample', startedAt: now - 60_000, agent: 'claude', position: 0 },
      waitingRow(),
    ]
    const page = await workBoardPage(tasks)
    await page.click('Remove realistic 1k to 1million')
    assert.match(page.text(), /Remove this task from the line\?/)
    Object.assign(tasks[1], { state: 'running', startedAt: now, waiting: null })
    await page.render()
    assert.doesNotMatch(page.text(), /Stop this task\?/, 'nobody pressed Stop: the dialog is not reworded into it')
    assert.equal(page.button('Stop task'), undefined)
    assert.match(page.text(), /"realistic 1k to 1million" started while you were confirming, so it was not removed\. Use Stop on its row to stop it\./)
    assert.deepEqual(page.posts, [])
  })

  test('Stop all stops the tasks it named when it opened, never one queued after', async () => {
    const tasks = [
      { jobId: 'jev-1', sessionId: 's1', state: 'running', taskName: 'first', startedAt: now - 60_000, agent: 'claude', position: 0 },
      waitingRow({ taskName: 'second' }),
    ]
    const page = await workBoardPage(tasks)
    await page.click('Stop all')
    assert.match(page.text(), /Stop all 2 tasks\?/)
    tasks.push(waitingRow({ jobId: 'jev-3', taskName: 'third, queued after it opened', position: 3 }))
    await page.poll()
    assert.match(page.text(), /third, queued after it opened/, 'the board has read the new task')
    assert.match(page.text(), /Stop all 2 tasks\?/, 'the dialog still covers what it named')
    await page.click('Stop 2')
    assert.deepEqual(page.posts.map(([, b]) => b.jobId).sort(), ['jev-1', 'jev-2'])
  })

  test('the Background tab shows why a task waits in its row, not only behind the disclosure', () => {
    const [item] = plugin().taskItems({ sessionId: 's1', runs: [], jobs: [], entries: [], tasks: [waitingRow()], open: new Set(), now })
    assert.equal(item.wait, 'Waiting: another task is running in this workspace.')
    const src = client.slice(client.indexOf('function Tasks('), client.indexOf('function WorkBoard('))
    const summary = src.slice(src.indexOf("h('summary'"), src.indexOf("h('div', { style: { marginTop: 6 } }, it.body)"))
    assert.match(summary, /it\.wait/, 'rendered inside the summary, beside the reason')
  })

  test('the Background tab removes a waiting task from the line as the work board does, only while it still waits', async () => {
    const page = await workBoardPage([waitingRow()], { tab: true })
    assert.ok(page.button('Remove realistic 1k to 1million'), 'a waiting row has Remove, not Stop')
    await page.click('Remove realistic 1k to 1million')
    assert.match(page.text(), /Remove this task from the line\?"realistic 1k to 1million" has not started/)
    await page.click('Remove task')
    assert.deepEqual(page.posts, [['/jev-router/tasks/stop', { jobId: 'jev-2', onlyIfWaiting: true }]])
    // It started between the last poll and the click: the tab says why nothing was stopped.
    page.stopResult = 'started'
    await page.click('Remove realistic 1k to 1million')
    await page.click('Remove task')
    assert.match(page.text(), /"realistic 1k to 1million" started before it could be removed, so it was not stopped\./)
  })

  test('a confirmation names its body for a screen reader', async () => {
    const page = await workBoardPage([waitingRow()])
    await page.click('Remove realistic 1k to 1million')
    const dialog = nodes(page.tree()).find((n) => n.props?.role === 'dialog')
    assert.equal(dialog?.props['aria-describedby'], 'jevi-confirm-b')
    assert.ok(nodes(dialog).some((n) => n.props?.id === 'jevi-confirm-b' && /has not started/.test(textOf(n))), 'the body it names is the words about what goes')
  })
}

// Send now and Steer for waiting work (docs/live-agent-view.md Feature 5): the buttons each row offers,
// and their dialogs, which never do what nobody read.
{
  const now = Date.now()
  const SLOT = { sendNow: 'slot', holder: null, heldBy: null, ahead: [], chatAhead: 0, held: 1, max: 1, local: null, forcedLocal: false }
  const running = (over = {}) => ({ jobId: 'jev-1', key: 'k1', sessionId: 's1', workspace: 'C:\\work\\kz-harness', state: 'running', taskName: 'fix the parser', startedAt: now - 60_000, agent: 'claude', position: 0, controls: { sendNow: null }, ...over })
  const queued = (over = {}) => ({ jobId: 'jev-2', key: 'k2', sessionId: 's1', workspace: 'C:\\work\\elsewhere', state: 'queued', taskName: 'tidy the docs', startedAt: null, queuedAt: now - 30_000, position: 1,
    waiting: { why: 'cap', place: 1, ahead: 0, since: now - 30_000, placeText: 'next for a free slot', text: 'Waiting for a free slot: the resource budget caps how many tasks run at once.' }, controls: SLOT, ...over })

  test('the work board: a waiting row offers Send now, Steer and Remove, a running row Steer and Stop, each named by its task', async () => {
    const page = await workBoardPage([running(), queued()])
    assert.ok(page.button('Send jev-2 now'), 'a waiting row is sent now from its row')
    assert.equal(textOf(page.button('Send jev-2 now')), 'Send now')
    assert.equal(textOf(page.button('Steer jev-2')), 'Steer…')
    assert.ok(page.button('Remove tidy the docs'))
    assert.ok(page.button('Steer jev-1'), 'a running row is steered too')
    assert.equal(page.button('Send jev-1 now'), undefined, 'but there is nothing to send now')
    assert.ok(page.button('Stop fix the parser'))
    const tab = await workBoardPage([running(), queued()], { tab: true })
    assert.deepEqual(['Send jev-2 now', 'Steer jev-2', 'Steer jev-1'].map((l) => !!tab.button(l)), [true, true, true], 'and the Tasks tab offers the same')
  })

  test('Send now on a task waiting for a slot asks first in the words of the line, then starts it; a race the server refuses says why, and the task stays in line', async () => {
    const tasks = [running(), queued()]
    const page = await workBoardPage(tasks)
    assert.ok(page.button('Send jev-2 now'), 'a waiting row is sent now from its row')
    await page.click('Send jev-2 now')
    assert.match(page.text(), /Start jev-2 now\?It runs beside 1 other task, over your limit of 1 task at once \(Settings, Resource budget\), so the next task to end frees no slot\./)
    assert.deepEqual(page.posts, [], 'nothing is sent before it is confirmed')
    page.answers['/jev-router/tasks/start-now'] = { result: 'started', holder: null, words: 'jev-2 started, over your limit of 1 task at once: the next task to end frees no slot.' }
    await page.click('Start now')
    assert.deepEqual(page.posts, [['/jev-router/tasks/start-now', { key: 'k2' }]])
    assert.doesNotMatch(page.text(), /Start jev-2 now\?/, 'the dialog closed')
    // Refused after a race: a writer took the folder first.
    page.answers['/jev-router/tasks/start-now'] = { result: 'workspace-busy', holder: 'jev-3', words: 'jev-2 could not start now: jev-3 is changing elsewhere, and two tasks never write one folder at once. It stays in line; Run next puts it first.' }
    await page.click('Send jev-2 now')
    await page.click('Start now')
    assert.match(page.text(), /jev-2 could not start now: jev-3 is changing elsewhere, and two tasks never write one folder at once\. It stays in line; Run next puts it first\./)
  })

  test('a Send now dialog closes with \'jev-2 has already started.\' when its task starts while it is open', async () => {
    const tasks = [running(), queued()]
    const page = await workBoardPage(tasks)
    assert.ok(page.button('Send jev-2 now'), 'a waiting row is sent now from its row')
    await page.click('Send jev-2 now')
    assert.match(page.text(), /Start jev-2 now\?/)
    Object.assign(tasks[1], { state: 'routing', startedAt: now, waiting: null, controls: { sendNow: null } })
    await page.poll()
    assert.doesNotMatch(page.text(), /Start jev-2 now\?/)
    assert.equal(page.button('Start now'), undefined)
    assert.match(page.text(), /jev-2 has already started\./)
    assert.deepEqual(page.posts, [])
  })

  test('Send now behind a writer offers Put first in line, or Stop it and start this, which asks again and then stops the writer for it', async () => {
    const behind = queued({ jobId: 'jev-3', key: 'k3', workspace: 'C:\\work\\kz-harness', position: 3, waiting: { why: 'workspace', place: 3, ahead: 1, text: 'Waiting: another task is running in this workspace.' }, controls: { ...SLOT, sendNow: 'workspace', holder: 'jev-1', heldBy: 'task', ahead: ['jev-2'] } })
    const page = await workBoardPage([running(), behind])
    assert.ok(page.button('Send jev-3 now'), 'a waiting row is sent now from its row')
    await page.click('Send jev-3 now')
    assert.match(page.text(), /jev-1 is changing kz-harnessOnly one task changes a folder at a time\. You can put jev-3 first in line, or stop jev-1 now \(what it changed so far stays in the folder\) and start jev-3\./)
    assert.equal(page.button('Start now'), undefined, 'it cannot start now, so it is not offered')
    await page.click('Put first in line')
    assert.deepEqual(page.posts, [['/jev-router/tasks/reorder', { workspace: 'C:\\work\\kz-harness', order: ['jev-3'] }]])
    await page.click('Send jev-3 now')
    await page.click('Stop jev-1 and start this')
    assert.match(page.text(), /Stop jev-1\?Work it already did stays in kz-harness\. jev-3 starts as soon as it has stopped\./)
    assert.equal(page.posts.length, 1, 'asked twice before anything stops')
    page.answers['/jev-router/tasks/start-now'] = { result: 'stopping', holder: 'jev-1', words: 'Stopping jev-1; jev-3 starts as soon as it has stopped.' }
    await page.click('Stop jev-1')
    assert.deepEqual(page.posts[1], ['/jev-router/tasks/start-now', { key: 'k3', stop: 'jev-1' }])
    // Behind a run from the chat, only Put first in line.
    const chat = queued({ jobId: 'jev-4', key: 'k4', controls: { ...SLOT, sendNow: 'chat', heldBy: 'chat' } })
    const other = await workBoardPage([chat])
    await other.click('Send jev-4 now')
    assert.match(other.text(), /A run started from the chat is using elsewhere; jev-4 can go first in line after it\./)
    const dialog = nodes(other.tree()).find((n) => n.props?.role === 'dialog')
    assert.deepEqual(nodes(dialog).filter((n) => n.type === 'button').map(textOf), ['Cancel', 'Put first in line'], 'a run from the chat is not stopped from here')
  })

  test('Steer on a waiting task adds the words; one that started meanwhile keeps them and offers a follow-up, or a fresh start that asks first', async () => {
    const tasks = [running(), queued()]
    const page = await workBoardPage(tasks)
    assert.ok(page.button('Steer jev-2'), 'a waiting row is steered from its row')
    await page.click('Steer jev-2')
    assert.match(page.text(), /Steer jev-2Your words are added to the task before it starts\. It keeps its place in line\./)
    const box = () => nodes(page.tree()).find((n) => n.type === 'textarea')
    assert.equal(box().props.placeholder, 'What should it do differently?')
    assert.equal(page.button('Add to task').props.disabled, true, 'nothing to add yet')
    box().props.onChange({ target: { value: 'also update the README' } })
    await page.settle()
    page.answers['/jev-router/tasks/steer'] = { result: 'added', state: 'added', words: 'Added to jev-2 before it starts. Jev chooses the agent with it.' }
    await page.click('Add to task')
    assert.deepEqual(page.posts, [['/jev-router/tasks/steer', { key: 'k2', text: 'also update the README', how: 'amend' }]])
    assert.equal(box(), undefined, 'the dialog closed')
    // It starts while the person types: the words stay, and the dialog offers what can be done now.
    await page.click('Steer jev-2')
    box().props.onChange({ target: { value: 'and the changelog' } })
    Object.assign(tasks[1], { state: 'running', startedAt: now, waiting: null, controls: { sendNow: null } })
    await page.poll()
    assert.equal(box().props.value, 'and the changelog')
    // Since slice 8 a task at work takes words mid-run, so they now go to the running agent.
    assert.match(page.text(), /jev-2 started while you were typing, so your words were not added\. Steer it again: they now go to the running agent\./)
    assert.equal(page.button('Add to task'), undefined)
    await page.click('Stop and start again')
    assert.match(page.text(), /Stop jev-2 and start again\?Stop jev-2 and start again with your message\? What it changed so far stays in elsewhere\./)
    page.answers['/jev-router/tasks/steer'] = { result: 'restarting', state: null, jobId: 'jev-5', words: 'Stopping jev-2. jev-5 starts again with your message, first in line in elsewhere.' }
    await page.click('Stop and start again')
    assert.deepEqual(page.posts.at(-1), ['/jev-router/tasks/steer', { key: 'k2', text: 'and the changelog', how: 'restart' }])
    await page.click('Steer jev-2')
    box().props.onChange({ target: { value: 'add a test' } })
    await page.settle()
    page.answers['/jev-router/tasks/steer'] = { result: 'queued', state: null, jobId: 'jev-6', words: 'Queued jev-6 as a follow-up to jev-2, first in line in elsewhere.' }
    await page.click('Follow-up after it')
    assert.deepEqual(page.posts.at(-1), ['/jev-router/tasks/steer', { key: 'k2', text: 'add a test', how: 'follow-up' }])
  })

  test('TaskQueue Send now renders only while a turn runs, for a prompt not already steering, and calls updateQueue(id, { kind: \'steer\' })', async () => {
    const document = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} }
    const { React, mount } = statefulReact()
    let registration
    const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
    const hold = () => 0
    new Function('window', 'setTimeout', 'clearTimeout', 'document', client)(window, hold, hold, document)
    const { TaskQueue } = registration.factory((x) => { if (x === 'react') return React; throw new Error(`unexpected require: ${x}`) }).__test
    assert.equal(typeof TaskQueue, 'function', 'the task queue can be rendered')
    const updates = []
    let snap = { running: false, queue: [{ id: 'q1', placement: 'queue', message: { content: [{ type: 'text', text: 'then run the tests' }] } }, { id: 'q2', placement: 'steering', message: { content: [{ type: 'text', text: 'use pnpm' }] } }] }
    const face = { getSnapshot: () => snap, subscribe: () => () => {}, updateQueue: async (id, action) => { updates.push([id, action]); return { accepted: true } } }
    const view = mount(TaskQueue, { face })
    const buttons = () => nodes(view.tree).filter((n) => n.type === 'button')
    assert.equal(buttons().filter((b) => textOf(b) === 'Send now').length, 0, 'no turn runs, so nothing can be given to one')
    snap = { ...snap, running: true }
    view.render()
    const send = buttons().filter((b) => textOf(b) === 'Send now')
    assert.deepEqual(send.map((b) => b.props['aria-label']), ['Send task 1 now'], 'only the prompt waiting for the next turn, not one already steering')
    assert.equal(send[0].props.title, 'Give this to the current turn at its next step instead of waiting for the turn to end')
    send[0].props.onClick()
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    assert.deepEqual(updates, [['q1', { kind: 'steer' }]])
    view.unmount()
  })
}

test('the Laya column is read once for a run no row can come for, polled every 5 s while one can, and no more once every call has its row or the wait is over', async () => {
  const t = await calls()
  const now = Date.now()
  const trace = (callId) => ({ ...t.jev, callId })
  // A finished Jev Auto run with two Jev calls, which ended 19 s ago.
  const run = ({ id = 'run-1', ended = 19_000, shadow, extra = [] } = {}) => ({
    id, task: 'Fix the failing test', startedAt: now - ended - 30_000, events: [
      { type: 'start', at: now - ended - 30_000 },
      { type: 'jev', at: now - ended - 29_000, trace: trace('c1') },
      { type: 'routed', at: now - ended - 28_000, routing: { mode: 'jev', decider: 'jev', primaryAgent: 'claude' }, ...(shadow ? { shadow } : {}) },
      { type: 'jev', at: now - ended - 1000, trace: trace('c2') },
      { type: 'final', at: now - ended, status: 'accepted' },
      ...extra,
    ],
  })
  const row = (callId) => ({ callId, runId: 'run-1', status: 'skipped', reason: 'not_running' })

  // Laya not installed, or the comparisons off: nothing took the run, so it is read once.
  const none = await decisionsPage([run()])
  assert.deepEqual(none.gets, ['/jev-router/laya/shadow?runId=run-1'])
  assert.deepEqual(none.pending(), [], 'and nothing is left to read it again')
  await none.wait()
  assert.equal(none.gets.length, 1)
  assert.ok(!none.text().includes('waiting for Laya'))
  none.close()

  // The shadow took it: read every 5 s until each Jev call has its row, and not once more.
  const took = await decisionsPage([run({ shadow: 'answering' })])
  assert.equal(took.gets.length, 1)
  assert.deepEqual(took.pending(), [5000])
  assert.ok(took.text().includes('Laya shadow: waiting for Laya.'))
  took.rows = [row('c1')]
  await took.wait()
  assert.equal(took.gets.length, 2)
  assert.deepEqual(took.pending(), [5000], 'one call still has no row')
  took.rows = [row('c1'), row('c2')]
  await took.wait()
  assert.equal(took.gets.length, 3)
  assert.deepEqual(took.pending(), [], 'every call has its row')
  await took.wait()
  assert.equal(took.gets.length, 3)
  took.close()

  // Past the wait a row can land in, it is read once, however late a row of the run landed in its log.
  const late = await decisionsPage([run({ shadow: 'answering', ended: 12 * 60_000, extra: [{ type: 'shadow', at: now - 60_000, row: row('c1') }] })])
  assert.equal(late.gets.length, 1)
  assert.deepEqual(late.pending(), [])
  late.close()

  // While the run goes on, a row may yet come, so it is read every 5 s; once it has ended with
  // nothing taken, the reading stops.
  const going = run()
  going.events.pop()
  const live = await decisionsPage([going])
  assert.deepEqual(live.pending(), [5000])
  await live.wait()
  assert.equal(live.gets.length, 2)
  going.events.push({ type: 'final', at: Date.now(), status: 'accepted' })
  await live.render()
  assert.deepEqual(live.pending(), [])
  await live.wait()
  assert.equal(live.gets.length, 2)
  live.close()
})

test('a shadow row that lands after the run has ended does not lengthen it: the Total tile and the Background list give the run\'s own time', async () => {
  const { summarize, Stats, taskItems } = plugin()
  const t = await calls()
  const t0 = 1_000_000
  const run = {
    id: 'r1', task: 't', startedAt: t0, events: [
      { type: 'start', at: t0 },
      { type: 'jev', at: t0 + 1000, trace: t.jev },
      { type: 'routed', at: t0 + 1500, routing: { mode: 'jev', decider: 'jev', primaryAgent: 'claude' } },
      { type: 'jev', at: t0 + 29_000, trace: t.jev },
      { type: 'final', at: t0 + 30_000, status: 'accepted' },
      // The review's shadow row, 95 s after the run ended, on the CPU (5.3).
      { type: 'shadow', at: t0 + 125_000, row: { callId: t.jev.callId } },
    ],
  }
  const s = summarize(run)
  assert.equal(s.total, 30_000)
  const tiles = nodes(expand(Stats({ s }))).filter((n) => n.props.className === 'stat').map((n) => [textOf(n.children[0]), textOf(n.children[1])])
  assert.deepEqual(tiles.find(([label]) => label === 'Total'), ['Total', '30.0 s'])
  const [item] = taskItems({ sessionId: 's', runs: [run], jobs: [], entries: [], tasks: [], open: new Set(), now: t0 + 130_000 })
  assert.match(item.meta, / · 30\.0 s$/)
})

test('the Background list shows a run\'s own lines, never a word for each of Laya\'s shadow rows in the same log', () => {
  const { taskItems } = plugin()
  assert.equal(typeof taskItems, 'function', 'the Background list can be built')
  const t0 = 1_000_000
  const run = {
    id: 'r1', task: 'fix the flaky test', startedAt: t0, events: [
      { type: 'start', at: t0, text: 'Task received' },
      { type: 'routed', at: t0 + 950, text: 'Routed to claude (jev)', routing: { mode: 'jev', decider: 'jev', primaryAgent: 'claude' }, shadow: 'answering' },
      { type: 'final', at: t0 + 30_000, text: 'Final: accepted', status: 'accepted' },
      { type: 'shadow', at: t0 + 32_000, row: { callId: 'c1', status: 'answered' } },
      { type: 'shadow', at: t0 + 33_000, row: { callId: 'c2', status: 'skipped', reason: 'queue_full' } },
    ],
  }
  const [item] = taskItems({ sessionId: 's', runs: [run], jobs: [], entries: [], tasks: [], open: new Set(), now: t0 + 40_000 })
  assert.equal(textOf(expand(item.body)), 'Task received\nRouted to claude (jev)\nFinal: accepted')
})

test('the decider tile counts the time of the calls that failed too, and says how many failed', async () => {
  const { summarize, Stats } = plugin()
  const t = await calls()
  const t0 = 1_000_000
  const late = { type: 'decider-error', at: t0 + 121_000, error: { phase: 'route', callId: 'c2', provider: 'laya', ms: 120_000, error: { class: 'Error', code: 'LAYA_TIMEOUT', status: null, message: 'timed out after 120 s', questions: 20, device: 'cpu' } } }
  const run = { id: 'r1', task: 't', startedAt: t0, events: [{ type: 'start', at: t0 }, { type: 'jev', at: t0 + 1000, trace: t.laya }, late, { type: 'final', at: t0 + 180_000, status: 'accepted' }] }
  const s = summarize(run)
  const tiles = nodes(expand(Stats({ s }))).filter((n) => n.props.className === 'stat').map((n) => n.children.map(textOf))
  const sec = Math.round((t.laya.ms + 120_000) / 1000)
  assert.deepEqual(tiles[0], ['Laya', `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}`, '1 call failed'])
  // With every call answered, the tile is as it was.
  const answered = nodes(expand(Stats({ s: summarize({ ...run, events: run.events.filter((e) => e !== late) }) }))).filter((n) => n.props.className === 'stat')[0]
  assert.equal(answered.children.filter(Boolean).length, 2, textOf(answered))
  assert.doesNotMatch(textOf(answered), /failed/)
})

test('Laya\'s pick of a tool parameter, recorded by its option\'s index, is shown as the option it names', () => {
  const { shadowCell } = display()
  const row = { status: 'answered', jev: { questions: { 'fmt.style': { type: 'choice', answer: '#1' } } }, laya: { questions: { 'fmt.style': { type: 'choice', answer: '#1', confidence: 0.9, informative: true } } } }
  assert.deepEqual(shadowCell('fmt.style', row, { keys: ['a', 'b'] }), { text: 'b (90.0%)', mark: 'agrees', flat: false })
  // As the Decisions card hands it the question's own option keys.
  const { Questions } = plugin()
  const q = { name: 'fmt.style', type: 'choice', used: true, answer: 'b', options: { a: 'plain', b: 'bold' }, probabilities: { a: 0.1, b: 0.9 }, question: 'Which style?' }
  const trace = { phase: 'route', ms: 800, provider: 'jev', callId: 'c1', questions: [q], model: 'jev-1.13.0' }
  const tree = expand(Questions({ calls: [{ trace }], shadow: { rows: new Map([['c1', row]]), waiting: false } }))
  const laya = nodes(tree).find((n) => n.props?.className === 'why shadow')
  assert.equal(textOf(laya), 'Laya: b (90.0%)agrees')
})

test('a run Jev routed over the local agents alone (Jev Auto · Local) names Jev as who picked, live and stored', () => {
  const { HistoryRunDetail, WhatHappened, summarize } = plugin()
  for (const [name, f] of Object.entries({ HistoryRunDetail, WhatHappened, summarize })) assert.equal(typeof f, 'function', `${name} can be rendered`)
  const routing = { mode: 'local', decider: 'jev', primaryAgent: 'qwen-local', agentConfidence: 0.7, taskType: 'debugging', taskTypeConfidence: 0.8 }
  const live = textOf(expand(WhatHappened({ s: summarize({ id: 'r1', task: 't', startedAt: 1, events: [{ type: 'routed', at: 2, routing }, { type: 'final', at: 3, status: 'accepted' }] }) })))
  assert.match(live, /Jev picked qwen-local \(confidence 70\.0%\)/)
  assert.doesNotMatch(live, /unavailable/)
  assert.match(textOf(expand(HistoryRunDetail({ record: { routing, attempts: [], assessments: [] } }))), /^Stored run recordJev picked qwen-local \(confidence 70\.0%\)/)
})

test('a flat tool pick and its arguments are kept as answered, as the routing rules keep them; the rules fill the route\'s profile, strategy and second opinion, the review\'s agent picks and the intent\'s depth', () => {
  const { answerPills } = display()
  const pill = (name, type = 'choice') => answerPills({ name, type, probabilities: { a: 0.5, b: 0.5 }, informative: false }).map(([, text]) => text)
  for (const [name, type] of [['handler', 'choice'], ['fmt.style', 'choice'], ['fmt.fits', 'noul'], ['needsPerson', 'noul'], ['disposition', 'choice'], ['kind', 'choice']]) {
    assert.deepEqual(pill(name, type), ['too flat, kept as answered'], name)
  }
  for (const [name, type] of [['taskType', 'choice'], ['skill', 'choice'], ['strategy', 'choice'], ['capability', 'choice'], ['risk', 'score'], ['complexity', 'score'], ['req.planning', 'score'], ['minimumCapability', 'choice'], ['secondOpinion', 'noul'], ['reviewAgent', 'choice'], ['retryAgent', 'choice'], ['depth', 'choice']]) {
    assert.deepEqual(pill(name, type), ['too flat, filled by rules'], name)
  }
})

test('a stored run names who picked the agent and how sure it was, as the live run does', () => {
  const { HistoryRunDetail, WhatHappened, summarize } = plugin()
  for (const [name, f] of Object.entries({ HistoryRunDetail, WhatHappened, summarize })) assert.equal(typeof f, 'function', `${name} can be rendered`)
  const routing = { mode: 'jev', decider: 'laya', primaryAgent: 'claude', agentConfidence: 0.41 }
  const stored = (R) => textOf(expand(HistoryRunDetail({ record: { routing: R, attempts: [], assessments: [] } })))
  const live = (R) => textOf(expand(WhatHappened({ s: summarize({ id: 'r1', task: 't', startedAt: 1, events: [{ type: 'routed', at: 2, routing: R }] }) })))
  assert.match(stored(routing), /^Stored run recordLaya picked claude \(confidence 41\.0%\)/)
  assert.match(live(routing), /Laya picked claude \(confidence 41\.0%\)/)
  // Jev's run, and a Laya run offline over the local agents, say it the same way.
  assert.match(stored({ ...routing, decider: 'jev' }), /^Stored run recordJev picked claude \(confidence 41\.0%\)/)
  assert.match(stored({ ...routing, mode: 'local', primaryAgent: 'qwen-local' }), /^Stored run recordLaya picked qwen-local \(confidence 41\.0%\)/)
  // A record with no confidence says none rather than a dash.
  assert.doesNotMatch(stored({ ...routing, agentConfidence: undefined }), /confidence/)
})

test('a second-opinion yes held under the low risk band says so where the inspector shows the figure', () => {
  const { WhatHappened, summarize } = plugin()
  const routing = (heldBy) => ({ mode: 'jev', primaryAgent: 'claude', agentConfidence: 0.5, taskType: 'implementation', taskTypeConfidence: 0.76, complexity: 0.325, risk: 0.013, needsSecondOpinion: 0.67, needsHumanReview: 0.86, needsTests: 0.69, decision: { domains: { second_opinion: { label: 'yes', ...(heldBy ? { heldBy } : {}) } } } })
  const shown = (R) => textOf(expand(WhatHappened({ s: summarize({ id: 'r1', task: 't', startedAt: 1, events: [{ type: 'routed', at: 2, routing: R }] }) })))
  assert.match(shown(routing('risk')), /Second opinion67\.0% \(held: low risk\)/)
  assert.doesNotMatch(shown(routing()), /held/)
})

test('a run Laya decided is named Laya wherever the inspector names who decided: 2 Laya calls, Laya picked, the Stats tile', () => {
  const { RoutingDecision, WhatHappened, HistoryRunDetail, Stats, summarize } = plugin()
  for (const [name, f] of Object.entries({ RoutingDecision, WhatHappened, HistoryRunDetail, Stats, summarize })) assert.equal(typeof f, 'function', `${name} can be rendered`)
  const domains = { task_classification: { authority: 'laya', maturity: null, reason: '' }, resource_selection: { authority: 'code', maturity: null } }
  const routing = { mode: 'jev', decider: 'laya', model: 'laya-english/0.3.20@1a2b3c4', primaryAgent: 'claude', agentConfidence: 0.41, strategy: 'STANDARD_DIRECT', decision: { domains, jevCalls: 2, decider: 'laya', candidates: [] } }
  const s = summarize({ id: 'r1', task: 't', startedAt: 1, events: [{ type: 'start', at: 1 }, { type: 'routed', at: 2, routing }] })
  const badge = (R) => textOf(nodes(expand(RoutingDecision({ s: { routed: { routing: R } } }))).find((n) => n.type === 'span' && /\bbadge\b/.test(n.props.className)))
  assert.equal(badge(routing), '2 Laya calls')
  assert.equal(badge({ ...routing, decision: { ...routing.decision, jevCalls: 1 } }), '1 Laya call')
  assert.equal(badge({ ...routing, decision: { ...routing.decision, jevCalls: 0 } }), 'no Laya call')
  // Jev's run reads as it always did, a record from before `decider` was kept included.
  const { decider, ...jevDecision } = routing.decision
  assert.equal(decider, 'laya')
  assert.equal(badge({ ...routing, decider: undefined, decision: jevDecision }), '2 Jev calls')
  // The domain Laya answered is marked Laya, as the local router and the routing rules are marked,
  // and no rung of the local ladder is printed for it.
  const who = nodes(expand(RoutingDecision({ s: { routed: { routing } } }))).filter((n) => n.type === 'span' && n.props.className?.startsWith('pill')).map(textOf)
  assert.deepEqual(who.slice(0, 2), ['Laya', 'routing rules'])
  // What the code did, the stored run, and the Stats tile.
  assert.match(textOf(expand(WhatHappened({ s }))), /Laya picked claude \(confidence 41\.0%\)/)
  assert.match(textOf(expand(WhatHappened({ s: summarize({ id: 'r2', task: 't', startedAt: 1, events: [{ type: 'routed', at: 2, routing: { ...routing, decider: undefined, decision: jevDecision } }] }) }))), /Jev picked claude/)
  assert.match(textOf(expand(HistoryRunDetail({ record: { routing, attempts: [], assessments: [] } }))), /^Stored run recordLaya picked claude/)
  // Offline, Laya still decides, over the local agents; when its decision engine threw, it says Laya was unavailable.
  assert.match(textOf(expand(HistoryRunDetail({ record: { routing: { ...routing, mode: 'local', primaryAgent: 'qwen-local' }, attempts: [], assessments: [] } }))), /Laya picked qwen-local/)
  assert.match(textOf(expand(WhatHappened({ s: summarize({ id: 'r3', task: 't', startedAt: 1, events: [{ type: 'routed', at: 2, routing: { ...routing, mode: 'fallback', reason: 'timed out after 42 s' } }] }) }))), /Laya unavailable \(timed out after 42 s\); default agent claude/)
  const tiles = nodes(expand(Stats({ s }))).filter((n) => n.props.className === 'stat').map((n) => textOf(n.children[0]))
  assert.equal(tiles[0], 'Laya')
  // The background list names the run by who decided it; a queued task waits for whoever decides it, as its record says.
  const { taskRowModel, taskItems } = plugin()
  const listed = taskItems({ sessionId: 's', runs: [{ id: 'r1', task: 't', startedAt: 1, events: [{ type: 'start', at: 1 }, { type: 'routed', at: 2, routing }] }, { id: 'r0', task: 'old', startedAt: 0, events: [{ type: 'start', at: 0 }] }], jobs: [], entries: [], tasks: [], open: new Set(), now: 3 })
  assert.deepEqual(listed.map((r) => [r.key, r.kind]).sort(), [['rr0', 'Jev'], ['rr1', 'Laya']])
  assert.match(taskRowModel({ jobId: 'job-1', state: 'queued', position: 1, decider: 'laya' }, 0).meta, /^next up · Laya picks/)
  assert.match(taskRowModel({ jobId: 'job-2', state: 'queued', position: 1 }, 0).meta, /^next up · Jev picks/)
})

test('the Usage tab says what Laya did, at $0 and apart from what Jev saved', async () => {
  const { SavingsCard } = plugin()
  assert.equal(typeof SavingsCard, 'function', 'the savings card can be rendered')
  const { computeSavings } = await import('../usage.js')
  const now = Date.parse('2026-09-24T12:00:00.000Z')
  const ts = '2026-09-24T11:00:00.000Z'
  const usage = [
    { ts, agent: 'laya', role: 'route', tokens: { input: 400, output: 0 }, costUsd: 0, ms: 950 },
    { ts, agent: 'laya', role: 'review', tokens: { input: 350, output: 0 }, costUsd: 0, ms: 600 },
    { ts, agent: 'jev', role: 'route', tokens: { input: 1200, output: 30 }, costUsd: 0.0000504, ms: 800 },
  ]
  const savings = computeSavings(usage, [], {}, now)
  const lines = nodes(expand(SavingsCard({ savings }))).filter((n) => n.props.className === 'why').map(textOf)
  assert.ok(lines.includes('Laya: 2 decisions on this PC, $0 (Laya counted 750 tokens; not billed).'), lines.join('\n'))
  assert.ok(lines.some((l) => l.startsWith('Jev cost $0.0001 vs LLM')), 'and Jev\'s own line counts Jev alone')
  const none = nodes(expand(SavingsCard({ savings: computeSavings(usage.slice(2), [], {}, now) }))).map(textOf)
  assert.ok(!none.some((l) => l.startsWith('Laya:')), 'no Laya line where Laya decided nothing')
})

test('a DeepSeek key made active since launch is shown as waiting for a restart beside the key in use', () => {
  const { UsageCard } = plugin()
  assert.equal(typeof UsageCard, 'function')
  const a = { id: 'deepseek', kind: 'api', keyProvider: 'deepseek', state: 'stopped', account: { label: 'a', pendingKey: 'b' }, balance: { amount: 0.1, currency: 'USD' }, limits: { minBalance: 5, handoffAtBalance: 10 }, windows: [] }
  const text = nodes(expand(UsageCard({ a, keys: [], links: {}, onSaved: () => {} }))).filter((n) => n.props?.className === 'why').map(textOf)
  assert.ok(text.includes(' · a, b after Restart harness'), text.join('\n'))
})

test('Settings says to restart while the server says a restart would move a provider onto another key, and not otherwise', () => {
  const { RestartLine } = plugin()
  assert.equal(typeof RestartLine, 'function')
  assert.equal(textOf(expand(RestartLine({ pending: ['deepseek'] }))), 'Restart the harness to apply the deepseek key change (Kz-harness → Restart harness)')
  assert.equal(RestartLine({ pending: [] }), null)
  assert.equal(RestartLine({}), null)
})
