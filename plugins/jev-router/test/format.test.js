// Message transfer: the report body of a finished background result is rewritten into prose by
// the local model before it is posted. Everything here runs on fakes: no model, no network, no
// llama-server. The point of the module is that a rewrite failure can never lose a result, so
// most of these tests are about the ways a model answer goes wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFormatter, estimateTokens, splitParts, stitchParts } from '../format.js'
import { createDelivery } from '../delivery.js'
import { createLanes, createTasks } from '../tasks.js'

const tick = () => new Promise((r) => setImmediate(r))

/** A stream that answers each call with one text block and records what it was asked. */
function countingStream(text = (n) => `rewritten part ${n}`) {
  const calls = []
  const stream = (opts) => {
    calls.push(opts)
    const n = calls.length
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: text(n) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  stream.calls = calls
  return stream
}

/** The shape a missing local engine really gives: one failure finish and no text. */
function failingStream() {
  const calls = []
  const stream = (opts) => {
    calls.push(opts)
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_ENGINE', message: 'no engine' } } }
    })()
  }
  stream.calls = calls
  return stream
}

test('estimateTokens grows with the text', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  let prev = 0
  for (let n = 1; n <= 50; n++) {
    const got = estimateTokens('word '.repeat(n))
    assert.ok(got >= prev, `the estimate dropped at ${n} words`)
    prev = got
  }
})

test('splitParts keeps every character, in order, inside the budget', () => {
  const text = `alpha line one\nbeta line two is longer\n${'g'.repeat(140)}\nomega\n`
  for (const budget of [3, 10, 25]) {
    const parts = splitParts(text, budget)
    assert.ok(parts.length > 1, `expected a split at budget ${budget}`)
    assert.equal(parts.join(''), text, `text changed at budget ${budget}`)
    for (const p of parts) assert.ok(estimateTokens(p) <= budget, `a part of ${estimateTokens(p)} tokens is over budget ${budget}`)
  }
})

test('stitchParts joins non-empty answers with a blank line', () => {
  assert.equal(stitchParts(['a', 'b']), 'a\n\nb')
  assert.equal(stitchParts([' a ', '', '   ', 'b']), 'a\n\nb')
  assert.equal(stitchParts([]), '')
})

test('with no local model the report is posted exactly as written', async () => {
  const stream = countingStream()
  const format = createFormatter({ stream, chatModel: async () => null, contextOf: () => 16384 })
  const raw = 'The report text.'
  assert.equal(await format({ jobId: 'j1' }, raw), raw)
  assert.equal(stream.calls.length, 0, 'the model is never asked')
})

test('a stream that throws leaves the raw report in place', async () => {
  const logs = []
  const stream = () => { throw new Error('llm is gone') }
  const format = createFormatter({ stream, chatModel: async () => 'gemma', contextOf: () => 16384, log: (m) => logs.push(m) })
  assert.equal(await format({ jobId: 'j2' }, 'raw body'), 'raw body')
  assert.match(logs.join(' '), /j2 posted as written/)
})

test('a failure finish with no text leaves the raw report in place', async () => {
  const stream = failingStream()
  const format = createFormatter({ stream, chatModel: async () => 'gemma', contextOf: () => 16384 })
  assert.equal(await format({ jobId: 'j3' }, 'raw body'), 'raw body')
  assert.equal(stream.calls.length, 1, 'it was tried once, then given up on')
})

test('an empty answer leaves the raw report in place', async () => {
  const stream = countingStream(() => '')
  const format = createFormatter({ stream, chatModel: async () => 'gemma', contextOf: () => 16384 })
  assert.equal(await format({ jobId: 'j4' }, 'raw body'), 'raw body')
})

test('a report that fits makes exactly one call and returns the rewrite', async () => {
  const stream = countingStream(() => 'Clean prose.')
  const format = createFormatter({ stream, chatModel: async () => 'gemma', contextOf: () => 16384, reserveTokens: 2048 })
  assert.equal(await format({ jobId: 'j5', taskName: 'a thing', state: 'completed' }, 'Short raw body.'), 'Clean prose.')
  assert.equal(stream.calls.length, 1)
})

test('a report over the budget is split, rewritten in parts, and stitched', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kz-format-'))
  const stream = countingStream((n) => `rewritten part ${n}`)
  const format = createFormatter({ stream, chatModel: async () => 'gemma', contextOf: () => 700, reserveTokens: 100, log: () => {} })
  const raw = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n')
  const out = await format({ jobId: 'job-7', workspace, taskName: 'a thing', state: 'completed' }, raw)
  assert.ok(stream.calls.length > 1, 'the report was split across calls')
  assert.equal(out, Array.from({ length: stream.calls.length }, (_, i) => `rewritten part ${i + 1}`).join('\n\n'), 'the answers are stitched in order')
  const dir = join(workspace, '.kz-harness', 'format')
  assert.ok(existsSync(join(dir, 'job-7-part-1.md')), 'part 1 is written under the workspace')
  assert.ok(existsSync(join(dir, 'job-7-part-2.md')), 'part 2 is written too')
  assert.equal(readFileSync(join(dir, 'job-7-part-1.md'), 'utf8'), splitParts(raw, 600)[0], 'the file holds the part that was sent')
})

test('delivery rewrites only the body and keeps the head and the summary', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-format-delivery-')), 'tasks.jsonl')
  const jobs = { start: () => 'jev-1', read: () => ({}), kill: () => 'requested', wait: () => new Promise(() => {}) }
  const seen = []
  let delivery
  const tasks = createTasks({
    file,
    lanes: createLanes(),
    jobs: () => jobs,
    run: async () => 'RAW REPORT text',
    onSettled: (result, own) => { delivery.deliverWithRetry(result, own).catch(() => {}) },
  })
  delivery = createDelivery({
    tasks,
    log: () => {},
    format: async (r, body) => { seen.push({ jobId: r.jobId, body }); return 'REWRITTEN PROSE' },
  })
  const messages = []
  const own = { status: 'idle', whenIdle: async () => {}, session: { append: (_type, msg) => messages.push(msg) } }
  tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 40; i++) await tick()
  assert.equal(seen.length, 1, 'the formatter saw the body exactly once')
  assert.equal(seen[0].body, 'RAW REPORT text', 'only the body is handed over')
  const text = messages[0].content[0].text
  assert.match(text, /^\*\*Background task result\*\*\nTask: a thing\nTask ID: jev-1\nAgent: /)
  assert.match(text, /Status: Completed\n\nREWRITTEN PROSE$/)
  assert.doesNotMatch(text, /RAW REPORT text/)
  assert.equal(messages[0].source.summary, 'jev-1 · a thing · Completed', 'the browser still matches this')
})

test('delivery keeps a non-completed terminal reason raw and rewrites only the report', async () => {
  const seen = []
  const delivery = createDelivery({
    tasks: { delivering: () => true, undeliver: () => {} },
    log: () => {},
    format: async (r, body) => { seen.push({ jobId: r.jobId, body }); return 'REWRITTEN PROSE' },
  })
  const messages = []
  const own = { whenIdle: async () => {}, session: { append: (_type, msg) => messages.push(msg) } }
  const result = { jobId: 'jev-9', taskName: 'a thing', state: 'failed', terminalReason: 'the agent hit its usage limit', report: 'RAW REPORT text' }
  assert.equal(await delivery.deliver(result, own), true)
  assert.equal(seen.length, 1, 'the formatter saw the body once')
  assert.equal(seen[0].body, 'RAW REPORT text', 'only the report is handed over, never the terminal reason')
  const text = messages[0].content[0].text
  assert.match(text, /Status: Failed\n\n/)
  assert.match(text, /the agent hit its usage limit\n\nREWRITTEN PROSE$/, 'the reason stays raw and leads the rewritten report')
  assert.doesNotMatch(text, /RAW REPORT text/)
  assert.equal(messages[0].source.summary, 'jev-9 · a thing · Failed', 'the browser still matches this')
})

test('delivery keeps the whole non-completed body raw when the formatter fails', async () => {
  const delivery = createDelivery({
    tasks: { delivering: () => true, undeliver: () => {} },
    log: () => {},
    format: async () => { throw new Error('no local model') },
  })
  const messages = []
  const own = { whenIdle: async () => {}, session: { append: (_type, msg) => messages.push(msg) } }
  const result = { jobId: 'jev-10', taskName: 'a thing', state: 'stopped', terminalReason: 'stopped by the user', report: 'RAW REPORT text' }
  await delivery.deliver(result, own)
  assert.match(messages[0].content[0].text, /stopped by the user\n\nRAW REPORT text$/, 'reason and report both survive a formatter failure')
})
