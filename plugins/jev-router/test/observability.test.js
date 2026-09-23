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
import { line } from '../adapter.js'

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
  assert.match(allLocal, /local router decided/)
  assert.match(allLocal, /no Jev call/)
  const taught = line({ type: 'decision', decision: { domains: { task_classification: { authority: 'jev' } }, jevCalls: 2, candidates: [{}] } })
  assert.match(taught, /Jev decided/)
  assert.match(taught, /2 Jev calls/)
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
  // Rendered on the live run view and on a stored run, and "Jev picked" names Jev's own pick.
  assert.equal((client.match(/\.\.\.moveNotes\(R\)\.map/g) ?? []).length, 2)
  assert.match(client, /Jev picked \$\{movesOf\(R\)\[0\]\?\.from \?\? R\.primaryAgent\}/)
})
