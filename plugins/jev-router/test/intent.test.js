// The message intent under Jev Auto (intent.js): a message is sorted through the intent domain, which
// records it as a sample with Jev's answer as the teacher's, and whose local classifier, once it has
// earned a rung, may decide only that a message is a task. The domain here is the real controller
// over a real store, loaded at the rung a test needs from a classifier trained on intentFeatures.
// That offline mode and Laya Auto record nothing is held through index.js itself, in
// test/laya-integration.test.js, where Jev, Laya and the network are faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calibrate, saveArtifact, trainMulticlass } from '../classifier.js'
import { STATE_VERSION, createDomainController } from '../domains.js'
import { intentFeatures } from '../features.js'
import { classifyIntent } from '../intent.js'
import { resolvePolicy } from '../routing-policy.js'
import { createTrainingStore } from '../training.js'

const NOW = Date.parse('2026-10-01T09:00:00.000Z')
const THINGS = ['parser', 'login form', 'retry loop', 'cache', 'date picker', 'config loader', 'router', 'logger', 'upload button', 'search box']
const FILES = ['src/parser.js', 'app/main.js', 'lib/cache.ts', 'server/routes.py', 'web/index.html']
/** Messages that ask for work in the project, and messages that ask something, by template. */
const tasks = () => THINGS.flatMap((t, i) => [`fix the ${t} in ${FILES[i % FILES.length]}`, `add a test for the ${t}`, `refactor the ${t} to read its settings once`, `rename the ${t} in ${FILES[(i + 2) % FILES.length]} and update the callers`])
const questions = () => THINGS.flatMap((t, i) => [`why does the ${t} fail on an empty input?`, `what is the ${t} for?`, `how does ${FILES[i % FILES.length]} handle the ${t}?`, `can you explain the ${t}?`])

/**
 * The intent domain's controller over a store of its own, at `maturity`, with a classifier trained
 * on the messages above when it should have one, as a domain that earned the rung has.
 */
function intentDomain({ maturity = 'JEV_PRIMARY', trained = maturity !== 'JEV_PRIMARY' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-intent-'))
  const store = createTrainingStore({ file: join(root, 'routing-samples.jsonl') })
  const artifactsDir = join(root, 'classifiers')
  const stateFile = join(root, 'domains', 'intent.state.json')
  if (trained) {
    const samples = [...tasks().map((m) => ({ features: intentFeatures(m), label: 'task' })), ...questions().map((m) => ({ features: intentFeatures(m), label: 'question' }))]
    const fitted = trainMulticlass({ samples, domain: 'intent', options: { epochs: 300, learningRate: 0.3 }, now: () => NOW })
    saveArtifact(join(artifactsDir, 'intent.json'), calibrate(fitted, samples))
  }
  mkdirSync(join(root, 'domains'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ stateVersion: STATE_VERSION, domain: 'intent', riskClass: 'LOW', kind: 'multiclass', maturity, since: new Date(NOW).toISOString() }))
  const domain = createDomainController({ domain: 'intent', policy: resolvePolicy(), store, artifactsDir, stateFile, now: () => NOW })
  domain.load()
  return { domain, store, file: join(root, 'routing-samples.jsonl') }
}

/** Jev's intent call as jev.js answers it, counting its calls. */
function jevSays(answer) {
  const jev = { calls: 0, ask: async () => { jev.calls++; return answer } }
  return jev
}

test('under Jev Auto one sample is recorded with Jev\'s kind as the teacher label and its id returned', async () => {
  const { domain, store, file } = intentDomain()
  const answer = { kind: 'question', confidence: 0.92, depth: 'deep', depthConfidence: 0.7, alsoWork: 0.1, readOnly: 0.3, uninformative: [] }
  const jev = jevSays(answer)
  const message = 'why does the MARKER_PELICAN parser fail on an empty input?'
  const got = await classifyIntent({ domain, message, ask: jev.ask })
  assert.equal(jev.calls, 1, 'one call, as there always was')
  const rows = await store.list({ domain: 'intent' })
  assert.equal(rows.length, 1)
  assert.deepEqual(got, { ...answer, intentSample: rows[0].id }, 'Jev\'s answer whole, and the sample it was recorded as')
  assert.deepEqual([rows[0].authority, rows[0].teacher.label, rows[0].teacher.confidence, rows[0].local], ['jev', 'question', 0.92, null])
  assert.deepEqual(rows[0].input.features, intentFeatures(message), 'read off the words alone')
  assert.equal(readFileSync(file, 'utf8').includes('MARKER_PELICAN'), false, 'and no word of the message is stored')
})

test('a sample says whether a picture came with the message, from the modalities it is handed, and none came when it is handed none', async () => {
  const { domain, store } = intentDomain()
  const message = 'what is this?'
  await classifyIntent({ domain, message, modalities: ['text', 'image'], ask: jevSays({ kind: 'question', confidence: 0.9 }).ask })
  await classifyIntent({ domain, message, ask: jevSays({ kind: 'question', confidence: 0.9 }).ask })
  const rows = await store.list({ domain: 'intent' })
  assert.deepEqual(rows.map((r) => [r.input.features.numeric.has_image, r.input.features.categorical.modality]), [[1, 'text+image'], [0, 'text']])
  assert.deepEqual(rows[0].input.features, intentFeatures(message, { modalities: ['text', 'image'] }), 'the features of the words and the picture')
})

test('at LOCAL_ONLY a confident local \'task\' makes no jev.intent call and returns {kind:\'task\', decidedBy:\'local\', readOnly:null}', async () => {
  const { domain, store } = intentDomain({ maturity: 'LOCAL_ONLY' })
  const jev = jevSays({ kind: 'question', confidence: 0.99 })
  const got = await classifyIntent({ domain, message: 'fix the cache in src/parser.js', ask: jev.ask })
  assert.equal(jev.calls, 0, 'no call to Jev')
  const [row] = await store.list({ domain: 'intent' })
  assert.deepEqual(got, { kind: 'task', decidedBy: 'local', readOnly: null, intentSample: row.id }, 'a task that runs as work that writes: nothing judged it reads only')
  assert.deepEqual([row.authority, row.local.label, row.teacher], ['local', 'task', null])
  assert.ok(row.local.confidence >= resolvePolicy().gates.LOW.confidenceThreshold, 'confident enough to decide')
})

test('where no task can run the local classifier decides nothing: a confident local \'task\' still asks Jev once, Jev\'s answer is used, and the local answer is recorded beside it', async () => {
  const { domain, store } = intentDomain({ maturity: 'LOCAL_ONLY' })
  const answer = { kind: 'question', confidence: 0.97, depth: 'everyday', alsoWork: 0.05, readOnly: 0.2, uninformative: [] }
  const jev = jevSays(answer)
  const got = await classifyIntent({ domain, message: 'fix the cache in src/parser.js', ask: jev.ask, localMayDecide: false })
  const [row] = await store.list({ domain: 'intent' })
  assert.equal(row.local?.label, 'task', 'the setting: the classifier says task')
  assert.ok(row.local.confidence >= resolvePolicy().gates.LOW.confidenceThreshold && !row.local.ood, 'as sure as a task it decides where one can run')
  assert.equal(jev.calls, 1, 'Jev is asked, once')
  assert.deepEqual(got, { ...answer, intentSample: row.id }, 'and its answer is the one used')
  assert.deepEqual([row.authority, row.teacher.label], ['jev', 'question'], 'the sample keeps both, Jev deciding')
  // With Jev down there, the message is a task by the fallback, as before there was a domain, never by the classifier.
  const down = await classifyIntent({ domain, message: 'fix the cache in src/parser.js', ask: async () => { throw new Error('503 Service Unavailable') }, localMayDecide: false })
  assert.equal(down.kind, 'task')
  assert.equal(down.decidedBy, undefined, 'the fallback, not the classifier')
})

test('a local \'question\' still asks Jev', async () => {
  const { domain, store } = intentDomain({ maturity: 'LOCAL_ONLY' })
  const answer = { kind: 'question', confidence: 0.9, depth: 'everyday', alsoWork: 0.05, readOnly: 0.1, uninformative: [] }
  const jev = jevSays(answer)
  const got = await classifyIntent({ domain, message: 'what is the router for?', ask: jev.ask })
  const [row] = await store.list({ domain: 'intent' })
  assert.equal(row.local?.label, 'question', 'the setting: the classifier says question')
  assert.ok(row.local.confidence >= resolvePolicy().gates.LOW.confidenceThreshold && !row.local.ood, 'as sure as a task it would have decided')
  assert.equal(jev.calls, 1, 'Jev is asked')
  assert.deepEqual(got, { ...answer, intentSample: row.id }, 'and its answer is the one used')
  assert.deepEqual([row.authority, row.teacher.label], ['jev', 'question'])
  // With Jev down, the local classifier answers only for a task: this message is one, the safe side.
  const down = await classifyIntent({ domain, message: 'what is the router for?', ask: async () => { throw new Error('503 Service Unavailable') } })
  assert.equal(down.kind, 'task')
  assert.equal(down.decidedBy, undefined, 'the fallback, not the classifier')
})

test('whatever a domain lets its local classifier decide, a local decision is a task: the second lock behind the domain\'s own', async () => {
  // A domain whose own lock (localLabels) failed, and let a local answer other than task decide.
  for (const label of ['question', 'other']) {
    const jev = jevSays({ kind: 'question', confidence: 0.99 })
    const domain = { decide: async () => ({ authority: 'local', label, probabilities: { [label]: 1 }, confidence: 0.99, sampleId: `s-${label}` }) }
    const got = await classifyIntent({ domain, message: 'what is the router for?', ask: jev.ask })
    assert.deepEqual(got, { kind: 'task', decidedBy: 'local', readOnly: null, intentSample: `s-${label}` }, `a local ${label} still runs as a task, as work that writes`)
    assert.equal(jev.calls, 0, 'and Jev is not asked')
  }
})

test('without an intent domain the message is sorted as it always was, and nothing is recorded', async () => {
  const answer = { kind: 'question', confidence: 0.8, depth: 'everyday' }
  assert.deepEqual(await classifyIntent({ domain: null, message: 'what is the router for?', ask: jevSays(answer).ask }), answer)
  assert.deepEqual(await classifyIntent({ domain: null, message: 'what is the router for?', ask: async () => { throw new Error('timed out') } }), { kind: 'task' }, 'a Jev that fails makes it a task')
  assert.deepEqual(await classifyIntent({ domain: null, message: 'what is the router for?', ask: null }), { kind: 'task' })
  // With a domain and a Jev that fails, the sample is recorded with no teacher, and the message is a task.
  const { domain, store } = intentDomain()
  const failed = await classifyIntent({ domain, message: 'what is the router for?', ask: async () => { throw new Error('timed out') } })
  const [row] = await store.list({ domain: 'intent' })
  assert.deepEqual(failed, { kind: 'task', intentSample: row.id })
  assert.deepEqual([row.authority, row.teacher], ['fallback', null])
})
