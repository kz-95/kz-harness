// The desktop helpers of docs/laya-auto.md 9.5, run as the owner runs them, each on a data folder
// and a harness of its own: scripts/laya-integrity-check.mjs (step 12), which exits non-zero on any
// violation of what a Laya-decided run may touch, and scripts/laya-export.mjs (step 13), the one
// file brought back, which must never carry a task's text or a key planted in history.jsonl.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'))
/** One helper, as `node scripts/<name> ...` runs it. */
const run = (name, args, cwd = tmpdir()) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, name), ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

const JEV_RUN = 'aaaaaaaa-1111-4111-8111-111111111111'
const LAYA_RUN = 'bbbbbbbb-2222-4222-8222-222222222222'
const TS = new Date().toISOString()
// Text the person typed, and keys pasted into it: none of it may leave the PC in the export.
const MARKER = 'MARKER_7f3e_TASK_TEXT'
const KEYS = ['tsk_live9Q2wE4rT6yU8iO0pA', 'sk-proj-Zx8Cv6Bn4Mm2Lk0Jh9Gf', 'hf_AbCdEfGhIjKlMnOpQrStUvWx']

/** A run's record as router.js writes it to history.jsonl, with text wherever a record holds it. */
function record(runId, decider, over = {}) {
  return {
    ts: TS, runId, sessionId: `session ${MARKER}`, workspace: `C:\\HarnessProjects\\${MARKER}`,
    task: `Fix the parser ${MARKER} with the key ${KEYS[0]}`,
    context: { gitRepo: true, branch: `feature/${MARKER}`, uncommittedFiles: [`src/${MARKER}.ts`], scripts: ['test'] },
    routing: {
      mode: 'jev', decider, model: decider === 'laya' ? 'laya-english/0.3.20@1a2b3c4' : 'jev-1.13.0', primaryAgent: 'deepseek', agentConfidence: 1,
      taskType: 'debugging', taskTypeConfidence: 0.8, complexity: 0.4, risk: 0.3, handler: 'agent', strategy: 'CHEAP_DIRECT',
      fallbackReason: `Jev said ${MARKER}`, toolArgs: { style: `${MARKER}_option` },
      profile: { taskType: 'debugging', requirements: { coding: 0.8 }, skills: { primary: 'debugging', supporting: [] }, note: MARKER },
      decision: {
        decider, jevCalls: 2, strategies: ['CHEAP_DIRECT'], judgments: { secondOpinion: 0.2 },
        domains: { task_classification: { authority: decider, maturity: null, label: 'debugging', confidence: 0.8, reason: `because ${MARKER}`, ood: { flag: false, reasons: [`unseen_category:${MARKER}`] } } },
        candidates: [{ id: 'deepseek', description: MARKER }],
      },
      deciderErrors: decider === 'laya' ? [{ phase: 'review', reason: `Laya failed on ${MARKER}` }] : [],
    },
    plan: { strategy: 'CHEAP_DIRECT', notes: [MARKER] },
    attempts: [{ agent: 'deepseek', role: 'primary', stopReason: 'completed', durationMs: 900, changedFiles: [`src/${MARKER}.ts`], answerExcerpt: `Fixed ${MARKER} ${KEYS[1]}`, checks: [{ name: 'test', output: MARKER }] }],
    assessments: [{ mode: decider, verdict: 'accept', action: 'accept', quality: 0.9, why: `quality ${MARKER}` }],
    finalStatus: 'accepted', statusReason: MARKER,
    ...over,
  }
}

const sample = (id, runId, domain, over = {}) => ({ id, ts: TS, runId, domain, input: { features: { numeric: { h12: 0.69 } } }, teacher: null, authority: 'laya', provider: { id: 'laya', label: 'debugging', confidence: 0.6, informative: true }, ...over })
const jevSample = (id, runId, domain) => ({ id, ts: TS, runId, domain, input: { features: { numeric: { h12: 0.69 } } }, teacher: { label: 'debugging', confidence: 0.8 }, authority: 'jev' })
const evidenceRow = (runId, dimension, over = {}) => ({ ts: TS, subject: { provider: 'deepseek', model: 'deepseek-flash' }, dimension, score: 1, source: 'objective_deterministic', confidence: 0.9, n: 1, runId, ...over })
const usageRow = (agent, runId, phase, costUsd) => ({ ts: TS, agent, runId, phase, ms: 300, model: agent === 'laya' ? 'laya-english/0.3.20@1a2b3c4' : 'jev-1.13.0', tokens: { input: 100, output: 0 }, costUsd })

/** A data folder as one Jev Auto run and one Laya Auto run leave it, each as the plugin writes it. */
function world(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-laya-desktop-'))
  const data = join(root, 'jev-router')
  const harness = join(root, 'harness')
  const files = {
    'history.jsonl': [record(JEV_RUN, 'jev'), record(LAYA_RUN, 'laya')],
    'routing-samples.jsonl': [jevSample('s1', JEV_RUN, 'task_classification'), jevSample('s2', JEV_RUN, 'outcome_disposition')],
    'laya-samples.jsonl': [sample('l1', LAYA_RUN, 'task_classification'), sample('l2', LAYA_RUN, 'outcome_disposition')],
    'capability-evidence.jsonl': [evidenceRow(JEV_RUN, 'debugging', { taskType: 'debugging' }), evidenceRow(JEV_RUN, 'reliability'), evidenceRow(LAYA_RUN, 'reliability')],
    'usage.jsonl': [
      usageRow('jev', 'intent', 'intent', 0.0000042), usageRow('jev', JEV_RUN, 'route', 0.0000042), usageRow('jev', JEV_RUN, 'review', 0.0000042),
      usageRow('laya', 'intent', 'intent', 0), usageRow('laya', LAYA_RUN, 'route', 0), usageRow('laya', LAYA_RUN, 'review', 0),
      { ts: TS, agent: 'deepseek', role: 'primary', stopReason: 'completed', durationMs: 900, runId: JEV_RUN },
      { ts: TS, agent: 'chat', role: 'direct-answer', durationMs: 2000, decider: 'laya' },
    ],
    'laya-shadow.jsonl': [{ id: 'r1', ts: TS, runId: JEV_RUN, phase: 'route', status: 'answered', jev: { model: 'jev-1.13.0', host: 'api.typesafe.ai' }, laya: { questions: { taskType: { type: 'choice', answer: 'debugging', p: [0.6] } } } }],
    'laya-standing.jsonl': [{ ts: TS, identity: 'laya-0.3.20|english|1a2b3c4d5e6f|adapter-1', domain: 'task_classification', laya: { answered: 1 } }],
    ...over,
  }
  mkdirSync(data, { recursive: true })
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(data, name), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + (rows.length ? '\n' : ''))
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
  put('jev-router/laya.json', JSON.stringify({ shadow: true, device: 'auto', note: `set with ${KEYS[2]}` }))
  put('harness/engine/laya/installed.json', JSON.stringify({ laya: '0.3.20', torch: '2.14.0+cu128', cuda: true, gpu: 'NVIDIA GeForce RTX 3050 Laptop GPU' }))
  put('harness/models/laya/weights.json', JSON.stringify({ repo: 'convaiinnovations/laya', commit: '1a2b3c4d5e6f'.padEnd(40, '0') }))
  // 600 lines, the first 100 of them marked, and a bearer key on the last.
  put('jev-router/laya/laya-serve.log', [...Array.from({ length: 600 }, (_, i) => (i < 100 ? `early ${MARKER} line ${i}` : `INFO: 127.0.0.1 "POST /v1/systemone HTTP/1.1" 200 line ${i}`)), `Authorization: Bearer ${KEYS[0]}`].join('\n') + '\n')
  return { root, data, harness }
}

// ---------------------------------------------------------------- step 12, the integrity check

test('the integrity check passes a PC whose Laya-decided runs touched nothing of Jev\'s, and says what it read', (t) => {
  const w = world()
  t.after(() => rmSync(w.root, { recursive: true, force: true }))
  const r = run('laya-integrity-check.mjs', ['--data', w.data])
  assert.equal(r.status, 0, `${r.out}${r.err}`)
  assert.match(r.out, /: 1 Laya-decided run, 1 other run\n/)
  for (const line of [
    'ok    no Laya-decided run in routing-samples.jsonl, the store Jev teaches from (2 Jev samples, 2 Laya samples)',
    'ok    no capability evidence but reliability from Laya-decided runs (1 evidence row from Laya-decided runs)',
    'ok    no Jev call in a Laya-decided run, and every Laya call at $0.00 (3 Laya calls)',
    'ok    no shadow row of a Laya-decided run (1 shadow row)',
  ]) assert.ok(r.out.includes(line), `${line}\n${r.out}`)
  assert.match(r.out, /^ok {4}"Saved by Jev" and Jev's spend unchanged by Laya's rows/m)
  assert.match(r.out, /All 5 checks passed\.\n$/)
})

test('the integrity check exits 1 and names each violation: a Laya run in the Jev store, evidence beyond reliability, a Jev call, a run "Saved by Jev" counts, a shadowed Laya run', (t) => {
  const tool = { ...record('cccccccc-3333-4333-8333-333333333333', undefined), attempts: [{ agent: 'lint', role: 'tool', stopReason: 'completed', durationMs: 100 }], finalStatus: 'accepted' }
  delete tool.routing.decider
  const w = world({
    'history.jsonl': [record(JEV_RUN, 'jev'), record(LAYA_RUN, 'laya'), tool],
    'routing-samples.jsonl': [jevSample('s1', JEV_RUN, 'task_classification'), jevSample('s9', LAYA_RUN, 'task_classification'), { ...jevSample('s8', JEV_RUN, 'skill_selection'), authority: 'laya' }],
    // A run Laya decided whose record lost its decider: found by its sample in Laya's store.
    'laya-samples.jsonl': [sample('l1', LAYA_RUN, 'task_classification'), sample('l3', tool.runId, 'task_classification'), { ...sample('l4', LAYA_RUN, 'skill_selection'), teacher: { label: 'debugging' } }],
    'capability-evidence.jsonl': [evidenceRow(LAYA_RUN, 'reliability'), evidenceRow(LAYA_RUN, 'debugging', { taskType: 'debugging' })],
    'usage.jsonl': [usageRow('jev', LAYA_RUN, 'review', 0.0000042), usageRow('laya', LAYA_RUN, 'route', 0.01)],
    'laya-shadow.jsonl': [{ id: 'r2', ts: TS, runId: LAYA_RUN, phase: 'review', status: 'answered' }],
  })
  t.after(() => rmSync(w.root, { recursive: true, force: true }))
  const r = run('laya-integrity-check.mjs', ['--data', w.data])
  assert.equal(r.status, 1, `${r.out}${r.err}`)
  assert.match(r.out, /: 2 Laya-decided runs, 1 other run\n/, 'the record without a decider is found by its Laya sample')
  for (const line of [
    'FAIL  no Laya-decided run in routing-samples.jsonl',
    '      routing-samples.jsonl holds a task_classification sample of the Laya-decided run bbbbbbbb (sample s9)',
    '      routing-samples.jsonl holds a Laya row: skill_selection sample s8 decided by Laya',
    '      laya-samples.jsonl holds a teacher\'s answer: skill_selection sample l4',
    'FAIL  no capability evidence but reliability from Laya-decided runs',
    '      capability-evidence.jsonl credits deepseek-flash with debugging for the task type debugging (objective_deterministic) from the Laya-decided run bbbbbbbb',
    'FAIL  no Jev call in a Laya-decided run, and every Laya call at $0.00',
    '      usage.jsonl has a Jev review in the Laya-decided run bbbbbbbb',
    '      usage.jsonl prices a Laya route at $0.01',
    'FAIL  "Saved by Jev" and Jev\'s spend unchanged by Laya\'s rows',
    '      "Saved by Jev" all: toolRuns is 1 with Laya\'s rows and 0 without them',
    'FAIL  no shadow row of a Laya-decided run',
    '      laya-shadow.jsonl has a review row of the Laya-decided run bbbbbbbb: a Laya Auto run has no shadow',
  ]) assert.ok(r.out.includes(line), `${line}\n${r.out}`)
  assert.match(r.out, /5 of 5 checks failed\.\n$/)
})

test('the integrity check says it proves nothing on a PC where Laya decided no run, and exits 2 with no data folder', (t) => {
  const w = world({ 'history.jsonl': [record(JEV_RUN, 'jev')], 'laya-samples.jsonl': [], 'capability-evidence.jsonl': [], 'usage.jsonl': [usageRow('jev', JEV_RUN, 'route', 0.0000042)], 'laya-shadow.jsonl': [] })
  t.after(() => rmSync(w.root, { recursive: true, force: true }))
  const r = run('laya-integrity-check.mjs', ['--data', w.data])
  assert.equal(r.status, 0, `${r.out}${r.err}`)
  assert.ok(r.out.includes('No run on this PC was decided by Laya, so this proves nothing about Laya Auto yet'), r.out)
  const none = run('laya-integrity-check.mjs', ['--data', join(w.root, 'nowhere')])
  assert.equal(none.status, 2)
  assert.match(none.err, /^laya-integrity-check: no jev-router data folder at .*nowhere\n$/)
})

// ---------------------------------------------------------------- step 13, the export

test('the export: one file of the shadow, both stores, the standings, the Laya files, the log\'s tail and each run\'s labels and numbers, and not one character of a task\'s text or a planted key', (t) => {
  const w = world()
  const out = join(w.root, 'out')
  t.after(() => rmSync(w.root, { recursive: true, force: true }))
  const r = run('laya-export.mjs', ['--data', w.data, '--harness', w.harness, '--out', out])
  assert.equal(r.status, 0, `${r.out}${r.err}`)
  const [name] = readdirSync(out)
  assert.match(name, /^laya-export-\d{4}-\d{2}-\d{2}\.json$/)
  assert.ok(r.out.startsWith(`Wrote ${join(out, name)} (`), r.out)
  for (const line of [
    '  laya-shadow.jsonl: 1 row', '  routing-samples.jsonl: 2 rows', '  laya-samples.jsonl: 2 rows', '  laya-standing.jsonl: 1 row',
    '  laya.json: as it is', '  installed.json: as it is', '  weights.json: as it is', '  laya-serve.log: the last 500 of its 601 lines',
    '  history.jsonl: 2 runs, each reduced to its id, time and final status',
  ]) assert.ok(r.out.includes(line), `${line}\n${r.out}`)
  assert.match(r.out, /Bring back this file only, never history\.jsonl or usage\.jsonl\.\n$/)

  const text = readFileSync(join(out, name), 'utf8')
  assert.ok(!text.includes(MARKER), 'no text the person typed, no path, no answer and no reason reaches the export')
  for (const k of KEYS) assert.ok(!text.includes(k), `the key ${k.slice(0, 4)} is not in it`)
  const b = JSON.parse(text)
  assert.equal(b.shadow.length, 1)
  assert.deepEqual([b.samples.jev.length, b.samples.laya.length, b.standing.length], [2, 2, 1])
  assert.deepEqual(b.files['installed.json'].gpu, 'NVIDIA GeForce RTX 3050 Laptop GPU')
  assert.equal(b.files['weights.json'].repo, 'convaiinnovations/laya')
  assert.equal(b.files['laya.json'].note, 'set with hf_AbC...REDACTED', 'a key in any file is redacted too')
  assert.equal(b.layaServeLog.length, 500, 'the newest 500 lines of the log')
  assert.equal(b.layaServeLog.at(-1), 'Authorization: Bearer ...REDACTED')
  const laya = b.runs.find((x) => x.runId === LAYA_RUN)
  assert.deepEqual(laya.attempts, [{ agent: 'deepseek', role: 'primary', stopReason: 'completed' }])
  assert.deepEqual(laya.assessments, [{ mode: 'laya', action: 'accept' }])
  assert.equal(laya.finalStatus, 'accepted')
  assert.deepEqual([laya.routing.decider, laya.routing.taskType, laya.routing.risk, laya.routing.model], ['laya', 'debugging', 0.3, 'laya-english/0.3.20@1a2b3c4'])
  assert.deepEqual(laya.routing.profile, { taskType: 'debugging', requirements: { coding: 0.8 }, skills: { primary: 'debugging', supporting: [] } })
  assert.deepEqual(laya.routing.decision.domains.task_classification, { authority: 'laya', maturity: null, label: 'debugging', confidence: 0.8, ood: { flag: false } })
  assert.deepEqual(laya.routing.deciderErrors, [{ phase: 'review' }])
  for (const gone of ['task', 'workspace', 'context', 'sessionId', 'plan', 'statusReason']) assert.equal(gone in laya, false, `${gone} is not copied`)
})
