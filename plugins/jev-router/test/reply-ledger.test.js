// The reply ledger and its predictor of the pick, in shadow (reply-ledger.js, docs/live-agent-view.md
// Feature 3): rows that hold no text, each reply's guess scored once the router picks, a record kept
// per decider against the quick and likely gates, and a predictor trained on what the router ran,
// masked to the agents available now. Rows are synthetic; no real task text is anywhere near this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_ROWS, REPLY_DOMAIN, REPLY_GATES, createReplyLedger, ledgerSummary, likelyGate, predictReply, quickGate, replyFeatures, replyGates, replyLabel,
  trackRecord, trainInWorker, trainPredictor,
} from '../reply-ledger.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'kz-ledger-'))
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const AGENTS = ['claude', 'codex', 'deepseek']
/** A scored row: a guess, and whether what ran matched it. */
const scored = (decider, match, i = 0) => ({ key: `${decider}-${i}`, decider, predicted: { agent: 'claude', level: 'high', confidence: 0.9, trusted: true }, ran: { agent: 'claude', level: 'high' }, match })

/**
 * 200 rows in three patterns, interleaved: a failing test to fix (Claude at high seven times in ten,
 * else Codex at medium), docs to write (DeepSeek at low three times in four, else Claude at medium),
 * and the same failing test sent at Extra High from the model menu (Claude at xhigh four times in
 * five, else Codex at xhigh). The words of the first and the third are alike: only the menu tells
 * them apart.
 */
function synthetic(n = 200) {
  const things = ['parser', 'cache', 'router', 'logger', 'date picker', 'config loader', 'upload button', 'search box']
  const rows = []
  for (let i = 0; i < n; i++) {
    const pattern = i % 3
    const thing = things[(i * 7) % things.length]
    const k = Math.floor(i / 3)
    const [text, level, ran] = pattern === 0
      ? [`fix the failing ${thing} test`, 'auto', k % 10 < 7 ? ['claude', 'high'] : ['codex', 'medium']]
      : pattern === 1
        ? [`write the docs for the ${thing}`, 'auto', k % 4 < 3 ? ['deepseek', 'low'] : ['claude', 'medium']]
        : [`fix the failing ${thing} test`, 'xhigh', k % 5 < 4 ? ['claude', 'xhigh'] : ['codex', 'xhigh']]
    rows.push({ key: `t${i}`, decider: 'jev', forced: false, features: replyFeatures({ text, available: AGENTS, mode: 'auto', level }), ran: { agent: ran[0], level: ran[1] } })
  }
  return rows
}
const featuresOf = (text, level = 'auto') => replyFeatures({ text, available: AGENTS, mode: 'auto', level })
/**
 * `n` rows in two patterns, alternating: a failing test to fix, which the router runs on Claude at
 * high four times in five and on Codex at medium otherwise, and docs to write, always Claude at high;
 * so Codex at medium is a rare pick overall.
 */
function skewed(n) {
  const things = ['parser', 'cache', 'router', 'logger', 'date picker', 'config loader', 'upload button', 'search box']
  return Array.from({ length: n }, (_, i) => {
    const thing = things[(i * 7) % things.length]
    const [text, ran] = i % 2 === 0 ? [`fix the failing ${thing} test`, Math.floor(i / 2) % 5 < 4 ? ['claude', 'high'] : ['codex', 'medium']] : [`write the docs for the ${thing}`, ['claude', 'high']]
    return { key: `t${i}`, decider: 'jev', forced: false, features: featuresOf(text), ran: { agent: ran[0], level: ran[1] } }
  })
}

test('rows hold no text', async () => {
  const dir = tmp()
  const file = join(dir, 'reply-ledger.jsonl')
  const ledger = createReplyLedger({ file, now: () => NOW })
  const features = replyFeatures({ text: 'MARKER_OSPREY fix the login in src/secret-billing.js', available: AGENTS, mode: 'auto', level: 'high', modalities: ['text', 'image'] })
  await ledger.note('key-1', { sessionId: 's1', jobId: 'jev-4', decider: 'jev', mode: 'auto', forced: false, features, predicted: null })
  await ledger.note('key-1', { said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'routed', ms: 2400 } })
  await ledger.routed('key-1', { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1', runId: 'run-1' })
  await ledger.flushed()
  const raw = readFileSync(file, 'utf8')
  for (const word of ['MARKER_OSPREY', 'osprey', 'secret-billing', 'login']) assert.equal(raw.toLowerCase().includes(word.toLowerCase()), false, `${word} is not on disk`)
  // What a row does hold: ids, agents, models, efforts, times, and numbers named after hashes and the pool.
  const [row] = await ledger.rows()
  assert.deepEqual(Object.keys(row).sort(), ['ask', 'decider', 'features', 'forced', 'jobId', 'key', 'match', 'mode', 'predicted', 'ran', 'said', 'sessionId', 'ts', 'verdict'])
  assert.deepEqual(Object.keys(row.features.numeric).filter((k) => !/^(h\d+|[a-z_]+|avail:[\w-]+|mode:\w+|level:\w+|decider:\w+|modal:image)$/.test(k)), [], 'every column a hashed bucket, a shape signal or a pool token')
  assert.equal(row.features.numeric['modal:image'], 1)
  assert.equal(row.features.numeric['avail:codex'], 1)
})

test('scoring at routed: a guess is right when the agent and the level the router ran are the ones it named', async () => {
  const ledger = createReplyLedger({ file: join(tmp(), 'reply-ledger.jsonl'), now: () => NOW })
  const guess = { agent: 'claude', level: 'high', confidence: 0.93, trusted: true }
  const ran = (agent, level) => ({ agent, level, effort: level, model: null, runId: `run-${agent}` })
  await ledger.note('k1', { decider: 'jev', predicted: guess })
  assert.equal((await ledger.routed('k1', ran('claude', 'high'))).match, true)
  await ledger.note('k2', { decider: 'jev', predicted: guess })
  assert.equal((await ledger.routed('k2', ran('claude', 'xhigh'))).match, false, 'another level is a miss')
  await ledger.note('k3', { decider: 'jev', predicted: guess })
  assert.equal((await ledger.routed('k3', ran('codex', 'high'))).match, false, 'and so is another agent')
  // The guess is noted in the background as the task is queued, so the pick can land first.
  await ledger.routed('k4', ran('claude', 'high'))
  assert.equal((await ledger.note('k4', { decider: 'jev', predicted: guess })).match, true, 'scored whichever is noted first')
  assert.equal((await ledger.routed('k5', ran('claude', 'high'))).match, null, 'no guess, nothing scored')
  // A read pass handed back is routed again; the first pick is the one the reply was measured against.
  const again = await ledger.routed('k1', ran('codex', 'medium'))
  assert.deepEqual([again.ran.agent, again.match], ['claude', true])
  assert.deepEqual(await ledger.trackRecord('jev', 50), { decider: 'jev', of: 50, n: 4, right: 2 })
})

test('separate windows per decider: Jev\'s record and Laya\'s are each their own', () => {
  const rows = []
  for (let i = 0; i < 60; i++) rows.push(scored('jev', true, i), scored('laya', false, i))
  rows.push({ key: 'unscored', decider: 'jev', predicted: null, ran: { agent: 'claude', level: 'high' }, match: null })
  assert.deepEqual(trackRecord(rows, 'jev', 50), { decider: 'jev', of: 50, n: 50, right: 50 })
  assert.deepEqual(trackRecord(rows, 'laya', 50), { decider: 'laya', of: 50, n: 50, right: 0 })
  assert.equal(quickGate(rows, 'jev'), true)
  assert.equal(quickGate(rows, 'laya'), false, 'Laya\'s misses never count against Jev, nor Jev\'s hits for Laya')
  // A row from before there was a decider on it was Jev's.
  assert.equal(trackRecord([{ match: true }], 'jev', 50).right, 1)
})

test('quickGate is false at 44 of 50 and true at 45; likelyGate is false at 15 of 20 and true at 16', () => {
  const last = (n, right, decider = 'jev') => Array.from({ length: n }, (_, i) => scored(decider, i < right, i))
  assert.equal(quickGate(last(50, 44), 'jev'), false)
  assert.equal(quickGate(last(50, 45), 'jev'), true)
  assert.equal(likelyGate(last(20, 15), 'jev'), false)
  assert.equal(likelyGate(last(20, 16), 'jev'), true)
  assert.equal(quickGate(last(49, 49), 'jev'), false, 'fewer than 50 scored is no record yet')
  // Only the last 50 count: a good start does not carry a bad week.
  assert.equal(quickGate([...last(50, 50), ...last(50, 44)], 'jev'), false)
  assert.deepEqual(REPLY_GATES, { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } })
  // `config.replies` sets them, and nothing that could not mean anything.
  const own = replyGates({ quick: { right: 40 } })
  assert.deepEqual(own, { quick: { right: 40, of: 50 }, likely: { right: 16, of: 20 } })
  assert.equal(quickGate(last(50, 41), 'jev', own), true)
  assert.throws(() => replyGates({ likely: { right: 21, of: 20 } }), /^Error: replies\.likely: right and of are whole numbers from 1, right no more than of$/)
  assert.throws(() => replyGates({ quick: { of: 0 } }), /replies\.quick/)
})

test('the predictor trained on 200 synthetic rows predicts the majority label per feature pattern', () => {
  const artifact = trainPredictor(synthetic(200), { now: () => NOW })
  assert.equal(artifact.domain, REPLY_DOMAIN)
  assert.deepEqual(artifact.classes, ['claude|high', 'claude|medium', 'claude|xhigh', 'codex|medium', 'codex|xhigh', 'deepseek|low'], 'labelled agent|level, from what ran')
  const guess = (text, level) => predictReply(artifact, featuresOf(text, level), { available: AGENTS })
  // Messages it never saw, each like one pattern.
  assert.deepEqual(guess('fix the failing retry loop test'), { agent: 'claude', level: 'high', confidence: guess('fix the failing retry loop test').confidence, trusted: true })
  assert.deepEqual([guess('write the docs for the retry loop').agent, guess('write the docs for the retry loop').level], ['deepseek', 'low'])
  assert.deepEqual([guess('fix the failing retry loop test', 'xhigh').agent, guess('fix the failing retry loop test', 'xhigh').level], ['claude', 'xhigh'], 'the menu\'s effort tells two alike messages apart')
  assert.ok(guess('fix the failing retry loop test').confidence > 0.5, 'the majority, by a margin')
  assert.throws(() => trainPredictor(synthetic(MIN_ROWS - 1)), new RegExp(`${MIN_ROWS - 1} labelled rows, ${MIN_ROWS} needed`))
  // Forced rows teach it nothing: the agent was picked by hand, not by the router.
  assert.throws(() => trainPredictor(synthetic(200).map((r) => ({ ...r, forced: true }))), /0 labelled rows/)
  assert.equal(replyLabel({ agent: 'qwen-local', level: null }), 'qwen-local|none')
})

test('masking drops an unavailable agent and marks the answer untrusted when the unmasked top differs', () => {
  const artifact = trainPredictor(synthetic(200), { now: () => NOW })
  const features = featuresOf('fix the failing retry loop test')
  const open = predictReply(artifact, features, { available: AGENTS })
  assert.deepEqual([open.agent, open.level, open.trusted], ['claude', 'high', true])
  const masked = predictReply(artifact, features, { available: ['codex', 'deepseek'] })
  assert.equal(masked.agent === 'claude', false, 'Claude is out of reach, so never the guess')
  assert.deepEqual([masked.agent, masked.trusted], ['codex', false], 'the best of what is left, which the predictor did not favour')
  assert.ok(masked.confidence < open.confidence, 'at its own probability, not one scaled up to the agents left')
  assert.equal(predictReply(artifact, features, { available: [] }), null, 'nothing available, no guess')
  assert.equal(predictReply(null, features, { available: AGENTS }), null, 'no predictor, no guess')
})

test('the predictor learns from the newest 500 labelled rows, the oldest four fifths fitted and the newest fifth calibrated, in the order they came, and never balanced, so a pick that is rare stays rare', () => {
  // Every labelled row while there are 500 or fewer: four fifths fitted, the newest fifth calibrated.
  const few = trainPredictor(synthetic(200), { now: () => NOW })
  assert.deepEqual([few.extras.rows, few.sampleCount, few.calibration.n, few.extras.trainedThrough], [200, 160, 40, 't199'])
  // Of more, the newest 500 only.
  const many = trainPredictor(synthetic(700), { now: () => NOW })
  assert.deepEqual([many.extras.rows, many.sampleCount, many.calibration.n, many.extras.trainedThrough], [500, 400, 100, 't699'])
  // In the order they came: a pick only the rows before the newest 500 made is not learned, and nor is
  // one only the newest fifth made, which is calibrated on and never fitted.
  const rows = synthetic(600).map((r, i) => (i < 100 ? { ...r, ran: { agent: 'kimi', level: 'low' } } : i >= 580 ? { ...r, ran: { agent: 'claude', level: 'max' } } : r))
  const ordered = trainPredictor(rows, { now: () => NOW })
  assert.deepEqual(ordered.classes.filter((c) => c === 'kimi|low' || c === 'claude|max'), [], ordered.classes.join(', '))
  // Never balanced: it is asked what the router most likely picks, so Codex at medium, a rare pick,
  // is not weighted up to rival Claude at high for a failing test.
  assert.equal(many.options.balance, false)
  const guess = predictReply(trainPredictor(skewed(200), { now: () => NOW }), featuresOf('fix the failing retry loop test'), { available: AGENTS })
  assert.deepEqual([guess.agent, guess.level], ['claude', 'high'])
  assert.ok(guess.confidence > 0.8, `as sure as four times in five makes it, where balanced it is about even (${guess.confidence})`)
})

test('the ledger retrains in the background after every 25 new labelled rows once it has 60, one retrain at a time, and keeps the predictor for the next start', async () => {
  const dir = tmp()
  const modelFile = join(dir, 'reply-model.json')
  const asked = []
  let release
  const train = (rows, o) => { asked.push(rows.length); return new Promise((r) => { release = () => r(trainPredictor(rows, o)) }) }
  const ledger = createReplyLedger({ file: join(dir, 'reply-ledger.jsonl'), modelFile, now: () => NOW, train })
  const rows = synthetic(150)
  for (const r of rows.slice(0, 59)) await ledger.note(r.key, r)
  await ledger.note('by-hand', { ...rows[59], key: 'by-hand', forced: true })
  assert.deepEqual(asked, [], 'fewer than 60 labelled rows: a row whose agent was picked by hand is not one')
  await ledger.note(rows[59].key, rows[59])
  assert.deepEqual(asked, [60], 'the sixtieth starts the first')
  for (const r of rows.slice(60, 100)) await ledger.note(r.key, r)
  assert.deepEqual(asked, [60], 'one at a time: forty more while it trains start none')
  assert.equal(await ledger.predict(featuresOf('fix the failing retry loop test'), AGENTS), null, 'and nothing guesses until it is done')
  release()
  await ledger.flushed()
  assert.ok(existsSync(modelFile), 'kept beside the ledger')
  assert.equal((await ledger.predict(featuresOf('fix the failing retry loop test'), AGENTS))?.agent, 'claude')
  await ledger.note(rows[100].key, rows[100])
  assert.deepEqual(asked, [60, 101], 'the first row after it starts the next, with the forty it did not see')
  release()
  await ledger.flushed()
  for (const r of rows.slice(101, 125)) await ledger.note(r.key, r)
  assert.deepEqual(asked, [60, 101], 'twenty-four new rows are not enough')
  await ledger.note(rows[125].key, rows[125])
  assert.deepEqual(asked, [60, 101, 126], 'the twenty-fifth is')
  release()
  await ledger.flushed()
  // A new start loads it, and counts from the row it was trained through.
  const again = createReplyLedger({ file: join(dir, 'reply-ledger.jsonl'), modelFile, now: () => NOW, train })
  assert.equal((await again.predict(featuresOf('write the docs for the retry loop'), AGENTS))?.agent, 'deepseek')
  for (const r of rows.slice(126, 150)) await again.note(r.key, r)
  assert.deepEqual(asked, [60, 101, 126], 'the rows the loaded one was trained through are not new')
  assert.equal((await again.summary()).prediction.trained.rows, 126)
})

test('a retrain runs in a worker thread off the event loop, and gives the predictor it would give here', async () => {
  const rows = synthetic(90)
  const ticks = []
  const timer = setInterval(() => ticks.push(Date.now()), 5)
  try {
    const artifact = await trainInWorker(rows, { now: () => NOW })
    assert.deepEqual(artifact, trainPredictor(rows, { now: () => NOW }), 'the same artifact, trained elsewhere')
  } finally { clearInterval(timer) }
  assert.ok(ticks.length > 3, 'the event loop kept running while it trained')
  const stopped = new AbortController()
  const going = trainInWorker(rows, { now: () => NOW, signal: stopped.signal })
  stopped.abort()
  await assert.rejects(going, /exited/, 'a retrain under way ends with the plugin')
  await assert.rejects(trainInWorker(rows.slice(0, 10), { now: () => NOW }), /10 labelled rows, 60 needed/)
})

test('the file holds one task per line once it grows a slack past the cap, and a truncated last line is skipped', async () => {
  const dir = tmp()
  const file = join(dir, 'reply-ledger.jsonl')
  const ledger = createReplyLedger({ file, now: () => NOW, cap: 5, slack: 4 })
  for (let i = 0; i < 8; i++) {
    await ledger.note(`k${i}`, { jobId: `jev-${i}`, decider: 'jev' })
    await ledger.note(`k${i}`, { said: { agent: null, effort: null, model: null, how: 'waited', ms: 10 } })
  }
  await ledger.flushed()
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(lines.length < 16, `rewritten as it grew (${lines.length} lines)`)
  assert.deepEqual((await ledger.rows()).map((r) => r.key), ['k3', 'k4', 'k5', 'k6', 'k7'], 'the newest five tasks are kept')
  appendFileSync(file, '{"key":"k8","jobId":"jev-')
  const again = createReplyLedger({ file, now: () => NOW, cap: 5, slack: 4 })
  assert.deepEqual((await again.rows()).map((r) => [r.key, r.said?.how]), [['k3', 'waited'], ['k4', 'waited'], ['k5', 'waited'], ['k6', 'waited'], ['k7', 'waited']], 'each task as its newest line has it')
})

const fsp = createRequire(import.meta.url)('node:fs/promises')
const fs = createRequire(import.meta.url)('node:fs')
const wt = createRequire(import.meta.url)('node:worker_threads')
/**
 * Run `fn` with `name` of node:fs/promises (or of `mod`, node:fs, which classifier.js saves the
 * predictor through) replaced by `fake(real)`, as every module that imports it sees it:
 * syncBuiltinESMExports carries the swap over to the named imports reply-ledger.js holds.
 */
async function swapped(name, fake, fn, mod = fsp) {
  const real = mod[name]
  mod[name] = fake(real)
  syncBuiltinESMExports()
  try { return await fn() } finally {
    mod[name] = real
    syncBuiltinESMExports()
  }
}
const refusal = (code) => Object.assign(new Error(`${code}: refused by the test`), { code })
const keysIn = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).key)
const waited = { said: { agent: null, effort: null, model: null, how: 'waited', ms: 10 } }

test('a file the ledger could not read is never rewritten, since the copy would hold only what it knows: its rows stay, and the next start that reads it has them all', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  const writer = createReplyLedger({ file, now: () => NOW })
  for (let i = 0; i < 6; i++) await writer.note(`old${i}`, { jobId: `jev-${i}`, decider: 'jev' })
  await writer.flushed()
  const logs = []
  // One refusal, of the first read after a start, as a scanner or a backup holding the file on Windows gives.
  let refused = 0
  await swapped('readFile', (real) => async (path, ...rest) => {
    if (path === file && !refused++) throw refusal('EBUSY')
    return real(path, ...rest)
  }, async () => {
    // A slack past the cap after four tasks, so a ledger that rewrote what it knows would do it then.
    const ledger = createReplyLedger({ file, now: () => NOW, cap: 4, slack: 4, log: (m) => logs.push(m) })
    for (let i = 0; i < 6; i++) {
      await ledger.note(`new${i}`, { jobId: `jev-${10 + i}`, decider: 'jev' })
      await ledger.note(`new${i}`, waited)
    }
    await ledger.flushed()
  })
  const old = ['old0', 'old1', 'old2', 'old3', 'old4', 'old5']
  const noted = ['new0', 'new1', 'new2', 'new3', 'new4', 'new5']
  assert.deepEqual([...new Set(keysIn(file))], [...old, ...noted], 'every row it could not read is still there, and every row noted since')
  assert.equal(keysIn(file).length, 18, 'appended, and never rewritten')
  assert.ok(logs.some((m) => m.startsWith('reply ledger not read: EBUSY')), logs.join('; '))
  assert.deepEqual(logs.filter((m) => m.startsWith('reply ledger not compacted')), [])
  const again = createReplyLedger({ file, now: () => NOW })
  assert.deepEqual((await again.rows()).map((r) => r.key), [...old, ...noted], 'the next start reads the history and the rows noted since')
})

test('a rewrite that fails, as the rename does while a reader holds the file on Windows, is tried again once another slack of lines is appended, not on every write', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  const logs = []
  let holding = true
  let renames = 0
  await swapped('rename', (real) => async (from, to) => {
    renames++
    if (holding) throw refusal('EPERM')
    return real(from, to)
  }, async () => {
    const ledger = createReplyLedger({ file, now: () => NOW, cap: 4, slack: 4, log: (m) => logs.push(m) })
    const failed = () => logs.filter((m) => m.startsWith('reply ledger not compacted: EPERM')).length
    for (let i = 0; i < 4; i++) {
      await ledger.note(`k${i}`, { jobId: `jev-${i}`, decider: 'jev' })
      await ledger.note(`k${i}`, waited)
    }
    assert.deepEqual([failed(), renames], [1, 7], 'the eighth line, a slack past four tasks, tries once, its rename refused all seven times')
    for (let i = 4; i < 7; i++) await ledger.note(`k${i}`, { jobId: `jev-${i}`, decider: 'jev' })
    assert.deepEqual([failed(), renames], [1, 7], 'three lines more try nothing')
    await ledger.note('k7', { jobId: 'jev-7', decider: 'jev' })
    assert.deepEqual([failed(), renames], [2, 14], 'the fourth, a slack on, tries again')
    holding = false
    for (let i = 8; i < 12; i++) await ledger.note(`k${i}`, { jobId: `jev-${i}`, decider: 'jev' })
    await ledger.flushed()
    assert.deepEqual([failed(), renames], [2, 15], 'and a slack on again, with nothing holding the file, the rewrite goes through')
  })
  assert.deepEqual(keysIn(file), ['k8', 'k9', 'k10', 'k11'], 'one line a task, the newest four')
  assert.equal(existsSync(`${file}.tmp`), false, 'the copy renamed over it')
})

test('a predictor the disk refuses to save, as a rename over reply-model.json is refused while a reader holds it on Windows, is used all the same: it guesses, the card counts it trained, and the log says it was not saved, never that it was not trained', async () => {
  const train = async (rows, o) => trainPredictor(rows, o)
  const dir = tmp()
  const modelFile = join(dir, 'reply-model.json')
  const logs = []
  let refused = 0
  await swapped('renameSync', (real) => (from, to) => {
    if (to === modelFile) { refused++; throw refusal('EPERM') }
    return real(from, to)
  }, async () => {
    const ledger = createReplyLedger({ file: join(dir, 'reply-ledger.jsonl'), modelFile, now: () => NOW, log: (m) => logs.push(m), train })
    for (const r of synthetic(60)) await ledger.note(r.key, r)
    await ledger.flushed()
    assert.equal(refused, 7, 'tried seven times over a moment, as the ledger\'s own rename is')
    assert.equal((await ledger.predict(featuresOf('fix the failing retry loop test'), AGENTS))?.agent, 'claude', 'the predictor it trained guesses')
    assert.equal((await ledger.summary()).prediction.trained?.rows, 60, 'and the card counts it trained')
  }, fs)
  assert.equal(existsSync(modelFile), false, 'nothing was saved')
  assert.ok(logs.some((m) => m.startsWith('reply predictor not saved: EPERM')), logs.join('; '))
  assert.deepEqual(logs.filter((m) => m.includes('not trained')), [])
  // A start after it has nothing to load, and trains one again as it reads the ledger, on the sixty
  // there; the task routed for next is the first of the twenty-five the retrain after it waits for.
  const asked = []
  const again = createReplyLedger({ file: join(dir, 'reply-ledger.jsonl'), modelFile, now: () => NOW, train: (rows, o) => { asked.push(rows.length); return train(rows, o) } })
  await again.note('one-more', { ...synthetic(61)[60], key: 'one-more' })
  await again.flushed()
  assert.deepEqual(asked, [60])
  assert.ok(existsSync(modelFile), 'and saves it, with nothing holding the file now')
  // A reader that lets go within the moment: the third try goes through, and nothing is logged.
  const held = tmp()
  const heldModel = join(held, 'reply-model.json')
  const quiet = []
  let holding = 2
  await swapped('renameSync', (real) => (from, to) => {
    if (to === heldModel && holding-- > 0) throw refusal('EBUSY')
    return real(from, to)
  }, async () => {
    const ledger = createReplyLedger({ file: join(held, 'reply-ledger.jsonl'), modelFile: heldModel, now: () => NOW, log: (m) => quiet.push(m), train })
    for (const r of synthetic(60)) await ledger.note(r.key, r)
    await ledger.flushed()
  }, fs)
  assert.ok(existsSync(heldModel), 'saved on the third try')
  assert.deepEqual(quiet, [])
})

test('a start whose ledger has rows enough and no predictor trained through them, as after reply-model.json was deleted, trains one as it reads the ledger, and says so while it trains; with learning off it trains nothing', async () => {
  const dir = tmp()
  const file = join(dir, 'reply-ledger.jsonl')
  appendFileSync(file, synthetic(70).map((r) => `${JSON.stringify(r)}\n`).join(''))
  // A retrain held until the test lets it go, so what the card is told meanwhile can be read.
  const asked = []
  let release
  const train = (rows, o) => { asked.push(rows.length); return new Promise((r) => { release = () => r(trainPredictor(rows, o)) }) }
  const ledger = createReplyLedger({ file, modelFile: join(dir, 'reply-model.json'), now: () => NOW, train })
  const meanwhile = (await ledger.summary()).prediction
  assert.deepEqual(asked, [70], 'the seventy tasks routing picked for, as it read them, with no task routed since')
  assert.deepEqual([meanwhile.trained, meanwhile.training, meanwhile.labelled, meanwhile.retrainEvery], [null, true, 70, 25], 'the card is told it is training')
  release()
  await ledger.flushed()
  const after = (await ledger.summary()).prediction
  assert.deepEqual([after.trained?.rows, after.training], [70, false])
  assert.equal((await ledger.predict(featuresOf('fix the failing retry loop test'), AGENTS))?.agent, 'claude')
  // With learning off nothing is noted, and nothing is trained from what the ledger holds either.
  const off = tmp()
  appendFileSync(join(off, 'reply-ledger.jsonl'), synthetic(70).map((r) => `${JSON.stringify(r)}\n`).join(''))
  const idle = createReplyLedger({ file: join(off, 'reply-ledger.jsonl'), modelFile: join(off, 'reply-model.json'), now: () => NOW, train, learns: () => false })
  assert.deepEqual([(await idle.summary()).prediction.training, (await idle.summary()).prediction.labelled], [false, 70])
  await idle.flushed()
  assert.deepEqual(asked, [70], 'no retrain while learning is off')
  assert.equal(existsSync(join(off, 'reply-model.json')), false)
})

test('a predictor trained through a task the ledger no longer holds, as after reply-ledger.jsonl alone was deleted, is trained again once 60 tasks routing picked for are on record and after every 25 more, never kept for good', async () => {
  const dir = tmp()
  const file = join(dir, 'reply-ledger.jsonl')
  const modelFile = join(dir, 'reply-model.json')
  const asked = []
  let release
  const train = (rows, o) => { asked.push(rows.length); return new Promise((r) => { release = () => r(trainPredictor(rows, o)) }) }
  // Eighty tasks on record, and a predictor trained through the last of them as the ledger read them, saved.
  appendFileSync(file, synthetic(80).map((r, i) => `${JSON.stringify({ ...r, key: `old${i}` })}\n`).join(''))
  const before = createReplyLedger({ file, modelFile, now: () => NOW, train })
  await before.rows()
  release()
  await before.flushed()
  assert.deepEqual([asked, (await before.summary()).prediction.trained?.rows], [[80], 80], 'the setting: one trained through the eightieth')
  const saved = readFileSync(modelFile)
  // reply-ledger.jsonl deleted, which the README says may be done, and reply-model.json kept.
  rmSync(file)
  const ledger = createReplyLedger({ file, modelFile, now: () => NOW, train })
  assert.equal((await ledger.summary()).prediction.trained?.rows, 80, 'the predictor it found is in service')
  const rows = synthetic(85).map((r, i) => ({ ...r, key: `new${i}` }))
  for (const r of rows.slice(0, 59)) await ledger.note(r.key, r)
  assert.deepEqual(asked, [80], 'fifty-nine tasks are fewer than a predictor is trained on')
  await ledger.note(rows[59].key, rows[59])
  assert.deepEqual(asked, [80, 60], 'the sixtieth starts a retrain: every task on record is new to the predictor in service')
  release()
  await ledger.flushed()
  assert.equal((await ledger.summary()).prediction.trained?.rows, 60)
  for (const r of rows.slice(60, 84)) await ledger.note(r.key, r)
  assert.deepEqual(asked, [80, 60], 'twenty-four more are not enough')
  await ledger.note(rows[84].key, rows[84])
  assert.deepEqual(asked, [80, 60, 85], 'and the twenty-fifth is, as ever after')
  release()
  await ledger.flushed()
  assert.equal((await ledger.summary()).prediction.trained?.rows, 85)
  // A start beside that predictor with seventy such tasks on record, as when KzH was closed during the
  // retrain the sixtieth started, trains one as it reads them.
  const other = tmp()
  writeFileSync(join(other, 'reply-model.json'), saved)
  appendFileSync(join(other, 'reply-ledger.jsonl'), rows.slice(0, 70).map((r) => `${JSON.stringify(r)}\n`).join(''))
  const again = createReplyLedger({ file: join(other, 'reply-ledger.jsonl'), modelFile: join(other, 'reply-model.json'), now: () => NOW, train })
  assert.deepEqual([(await again.summary()).prediction.training, asked], [true, [80, 60, 85, 70]], 'training on the seventy as it read them')
  release()
  await again.flushed()
  assert.equal((await again.summary()).prediction.trained?.rows, 70)
})

test('a ledger given no way to train, as the plugin\'s is, retrains in a worker thread, and dispose ends a retrain under way: its worker exits, and nothing it trained is used or saved', async () => {
  // Every worker thread started, as reply-ledger.js sees the class (worker_threads, swapped as fs is above).
  const started = []
  await swapped('Worker', (Real) => class extends Real {
    constructor(...a) {
      super(...a)
      started.push(this)
      this.once('exit', () => { this.ended = true })
    }
  }, async () => {
    const dir = tmp()
    const modelFile = join(dir, 'reply-model.json')
    const ledger = createReplyLedger({ file: join(dir, 'reply-ledger.jsonl'), modelFile, now: () => NOW })
    for (const r of synthetic(60)) await ledger.note(r.key, r)
    await ledger.flushed()
    assert.equal(started.length, 1, 'the sixtieth labelled row started one worker')
    assert.equal((await ledger.summary()).prediction.trained?.rows, 60, 'which trained the predictor in service')
    assert.equal((await ledger.predict(featuresOf('fix the failing retry loop test'), AGENTS))?.agent, 'claude')
    assert.ok(existsSync(modelFile), 'and kept it for the next start')
    // The plugin closing while a retrain is under way: the sixtieth row's worker has only just started.
    const closing = tmp()
    const unsaved = join(closing, 'reply-model.json')
    const disposed = createReplyLedger({ file: join(closing, 'reply-ledger.jsonl'), modelFile: unsaved, now: () => NOW })
    for (const r of synthetic(60)) await disposed.note(r.key, r)
    disposed.dispose()
    await disposed.flushed()
    assert.deepEqual([started.length, started[1]?.ended], [2, true], 'its worker started, and has exited')
    assert.equal((await disposed.summary()).prediction.trained, null, 'nothing it trained is in service')
    assert.equal(await disposed.predict(featuresOf('fix the failing retry loop test'), AGENTS), null, 'so nothing guesses')
    assert.equal(existsSync(unsaved), false, 'and nothing was saved for the next start')
  }, wt)
})

test('a ledger disposed of, as the plugin closing or applied again leaves it, starts no retrain after, which nothing would end: rows a task of the old plugin still notes are kept and train nothing, and nor does a first read of rows enough', async () => {
  const dir = tmp()
  const file = join(dir, 'reply-ledger.jsonl')
  const modelFile = join(dir, 'reply-model.json')
  const asked = []
  const train = async (rows, o) => { asked.push(rows.length); return trainPredictor(rows, o) }
  const ledger = createReplyLedger({ file, modelFile, now: () => NOW, train })
  const rows = synthetic(110)
  for (const r of rows.slice(0, 60)) await ledger.note(r.key, r)
  await ledger.flushed()
  assert.deepEqual(asked, [60], 'the setting: the sixtieth trained one')
  const saved = readFileSync(modelFile, 'utf8')
  // The plugin applied again, as a setting changed, with tasks of the old one still running: their
  // rows come after.
  ledger.dispose()
  for (const r of rows.slice(60, 110)) await ledger.note(r.key, r)
  await ledger.flushed()
  assert.deepEqual(asked, [60], 'fifty more start none')
  assert.equal(readFileSync(modelFile, 'utf8'), saved, 'and nothing is saved to reply-model.json behind the plugin that replaced it')
  assert.equal((await ledger.rows()).length, 110, 'each is kept, as what ran')
  // Disposed of before its first read, of a file with rows enough and no predictor trained through them.
  const unread = createReplyLedger({ file, now: () => NOW, train })
  unread.dispose()
  assert.deepEqual([(await unread.summary()).prediction.training, asked], [false, [60]], 'nor does a first read start one')
  await unread.flushed()
  assert.deepEqual(asked, [60])
})

const ranOn = (agent) => ({ agent, level: 'high', effort: 'high', model: `${agent}-model`, runId: `run-${agent}` })

test('a ledger disposed of, as the plugin applied again leaves it, rewrites the file no more: a row a task of the old plugin still notes is appended, and the rows the plugin that replaced it noted there stay for the next start', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  // Five tasks, two lines each: a slack of six lines past them is one line away.
  const old = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  for (let i = 0; i < 5; i++) {
    await old.note(`old-${i}`, { jobId: `jev-${i + 1}`, decider: 'jev' })
    await old.note(`old-${i}`, waited)
  }
  await old.flushed()
  // The plugin applied again: its ledger reads the file and notes three tasks of its own.
  old.dispose()
  const fresh = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  for (let i = 0; i < 3; i++) await fresh.note(`new-${i}`, { jobId: `jev-${i + 6}`, decider: 'jev' })
  await fresh.flushed()
  // A task of the old plugin is routed: its row comes to the disposed ledger, the line that brings it
  // a slack past what it holds.
  await old.routed('old-4', ranOn('deepseek'))
  await old.flushed()
  assert.equal(keysIn(file).length, 14, 'its line is appended, and the file is not rewritten')
  const next = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  const rows = await next.rows()
  assert.deepEqual(rows.map((r) => r.key), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'new-0', 'new-1', 'new-2'], 'the next start reads every task, the new plugin\'s among them')
  assert.equal(rows.find((r) => r.key === 'old-4')?.ran?.agent, 'deepseek', 'and what the old plugin\'s task ran')
})

test('a ledger\'s dispose(), as the plugin closes or is applied again, resolves once every row noted before it is on disk, one still waiting for the ledger\'s first read of the file included', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  writeFileSync(file, `${JSON.stringify({ key: 'earlier', jobId: 'jev-1', decider: 'jev' })}\n`)
  const ledger = createReplyLedger({ file, now: () => NOW })
  // A task queued as the plugin closes: its row is the ledger's first, and waits for it to read the file.
  const noted = ledger.note('last', { jobId: 'jev-2', decider: 'jev' })
  await ledger.dispose()
  assert.deepEqual(keysIn(file), ['earlier', 'last'], 'its row is on disk once dispose() resolves')
  await noted
})

test('a rewrite keeps what another ledger appended to the file since this one read it, the newest line of each task winning: the ledger of the plugin applied again keeps what ran for a task the old plugin still ran, and holds it from then on', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  const old = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  for (let i = 0; i < 5; i++) await old.note(`old-${i}`, { jobId: `jev-${i + 1}`, decider: 'jev' })
  await old.flushed()
  // The plugin applied again: its ledger reads the five tasks before the old plugin's last is routed.
  old.dispose()
  const fresh = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  assert.equal((await fresh.rows()).find((r) => r.key === 'old-4')?.ran, null, 'the setting: read before it ran')
  await old.routed('old-4', ranOn('deepseek'))
  await old.flushed()
  // Three tasks of its own, three lines each: the ninth line is a slack past what it holds.
  for (let n = 0; n < 3; n++) for (let i = 0; i < 3; i++) await fresh.note(`new-${i}`, n ? waited : { jobId: `jev-${i + 6}`, decider: 'jev' })
  await fresh.flushed()
  assert.deepEqual(keysIn(file), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'new-0', 'new-1', 'new-2'], 'the setting: rewritten to one line a task')
  const onDisk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(onDisk.find((r) => r.key === 'old-4')?.ran?.agent, 'deepseek', 'the old plugin\'s task keeps what it ran')
  assert.deepEqual(onDisk.filter((r) => r.key.startsWith('new-')).map((r) => r.said?.how), ['waited', 'waited', 'waited'], 'and the new plugin\'s tasks their own newest lines')
  assert.equal((await fresh.rows()).find((r) => r.key === 'old-4')?.ran?.agent, 'deepseek', 'which the ledger now holds, as a start reading the file would')
})

test('a line another ledger appends while this one rewrites the file goes to the file the rewrite leaves, not to the one it replaces', async () => {
  const file = join(tmp(), 'reply-ledger.jsonl')
  const old = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  for (let i = 0; i < 5; i++) await old.note(`old-${i}`, { jobId: `jev-${i + 1}`, decider: 'jev' })
  await old.flushed()
  old.dispose()
  const fresh = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  await fresh.rows()
  // The rename that ends the new ledger's rewrite is held until the test lets it go.
  let reached
  const renaming = new Promise((r) => { reached = r })
  let release
  const gate = new Promise((r) => { release = r })
  await swapped('rename', (real) => async (from, to) => {
    if (to === file) { reached(); await gate }
    return real(from, to)
  }, async () => {
    const filling = (async () => { for (let n = 0; n < 3; n++) for (let i = 0; i < 3; i++) await fresh.note(`new-${i}`, n ? waited : { jobId: `jev-${i + 6}`, decider: 'jev' }) })()
    await renaming
    // A task of the old plugin is routed as the new ledger's copy is about to replace the file.
    const late = old.routed('old-4', ranOn('kimi'))
    await new Promise((r) => setTimeout(r, 100))
    release()
    await Promise.all([filling, late])
    await Promise.all([fresh.flushed(), old.flushed()])
  })
  const next = createReplyLedger({ file, now: () => NOW, cap: 10, slack: 6 })
  assert.equal((await next.rows()).find((r) => r.key === 'old-4')?.ran?.agent, 'kimi', 'what the old plugin\'s task ran is in the file the next start reads')
})

test('the summary: how long the replies that waited for routing took this week, the record per decider against both gates, and the newest replies first', () => {
  const day = 86_400_000
  const row = (i, how, ms, over = {}) => ({ key: `k${i}`, jobId: `jev-${i}`, decider: 'jev', ts: new Date(NOW - (over.ago ?? 0)).toISOString(), forced: how === 'forced', features: { numeric: {}, categorical: {} }, said: { agent: 'claude', effort: 'high', model: null, how, ms }, ran: { agent: 'claude', level: 'high' }, ...over })
  const rows = [row(1, 'routed', 9000, { ago: 8 * day }), row(2, 'routed', 4000), row(3, 'waited', 50), row(4, 'routed', 2000), row(5, 'forced', 300), row(6, 'routed', 6000, { match: true, predicted: { agent: 'claude', level: 'high', confidence: 0.9, trusted: true } })]
  const s = ledgerSummary(rows, { now: NOW })
  assert.deepEqual(s.startReplies, { medianMs: 4000, n: 3, atBound: 0, days: 7 }, 'the routed replies of the last seven days: neither an older one, nor one that named no plan, nor your own pick')
  assert.deepEqual(s.prediction.records.jev.quick, { decider: 'jev', of: 50, n: 1, right: 1 })
  assert.deepEqual(s.prediction.records.laya.likely, { decider: 'laya', of: 20, n: 0, right: 0 })
  assert.equal(s.prediction.labelled, 5, 'the forced one teaches the predictor nothing')
  assert.deepEqual(s.recent.map((r) => r.jobId), ['jev-6', 'jev-5', 'jev-4', 'jev-3', 'jev-2', 'jev-1'], 'newest first')
  assert.deepEqual(ledgerSummary([], { now: NOW }).startReplies, { medianMs: null, n: 0, atBound: 0, days: 7 })
})

test('the summary\'s Recent replies are its newest ten replies, newest first, and a task with no reply yet is not one of them', () => {
  const row = (i, said = { agent: null, effort: null, model: null, how: 'waited', ms: 10 }) => ({ key: `k${i}`, jobId: `jev-${i}`, decider: 'jev', ts: new Date(NOW).toISOString(), forced: false, said })
  // Twelve replies, and a newer task whose reply has not gone out.
  const rows = [...Array.from({ length: 12 }, (_, i) => row(i + 1)), row(13, null)]
  assert.deepEqual(ledgerSummary(rows, { now: NOW }).recent.map((r) => r.jobId), ['jev-12', 'jev-11', 'jev-10', 'jev-9', 'jev-8', 'jev-7', 'jev-6', 'jev-5', 'jev-4', 'jev-3'])
})

test('a reply whose wait for the pick ran out is timed with the replies that named the pick, and counted apart, so the week\'s median leaves out none that waited for it', () => {
  const row = (i, how, ms) => ({ key: `k${i}`, jobId: `jev-${i}`, decider: 'jev', ts: new Date(NOW).toISOString(), forced: how === 'forced', said: { agent: how === 'routed' || how === 'forced' ? 'claude' : null, effort: null, model: null, how, ms } })
  // Routing slower than the wait all week: every reply went out when its wait ran out, and each is timed.
  assert.deepEqual(ledgerSummary([row(1, 'bound', 15_020), row(2, 'bound', 15_010), row(3, 'bound', 15_030)], { now: NOW }).startReplies, { medianMs: 15_020, n: 3, atBound: 3, days: 7 })
  // A mixed week: those that named the pick and those whose wait ran out, and none that did not wait for one.
  const mixed = [row(1, 'routed', 2000), row(2, 'bound', 15_000), row(3, 'routed', 4000), row(4, 'waited', 30), row(5, 'forced', 300), row(6, 'bound', 15_000)]
  assert.deepEqual(ledgerSummary(mixed, { now: NOW }).startReplies, { medianMs: 9500, n: 4, atBound: 2, days: 7 })
})
