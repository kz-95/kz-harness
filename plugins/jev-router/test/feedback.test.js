// Feedback storage: validation, append and read back, the per-message upsert, and the
// tolerance for a write that a crash cut off. No real user data: every row is a fixture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANSWER_TAGS, MAX_REASON, ROUTING_TAGS, TAGS, createFeedback, tagIsAnswerOnly, validFeedback } from '../feedback.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'jev-feedback-')), 'feedback.jsonl')
const body = (over = {}) => ({ sessionId: 'sess-1', messageId: 'msg-1', verdict: 'like', ...over })

test('validFeedback: a minimal like, and the optional fields kept only when given', () => {
  const r = validFeedback(body(), { now: () => '2026-09-21T00:00:00.000Z' })
  assert.deepEqual(r, { ts: '2026-09-21T00:00:00.000Z', sessionId: 'sess-1', messageId: 'msg-1', verdict: 'like', reason: '' })
  const full = validFeedback(body({ verdict: 'dislike', reason: '  should\nhave used  claude ', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' }))
  assert.equal(full.reason, 'should have used claude', 'free text is collapsed to one line')
  assert.equal(full.suggestedAgent, 'claude')
  assert.equal(full.provider, 'codex')
  assert.equal(full.model, 'gpt-5')
})

test('validFeedback: the tag is optional, and only the fixed list is accepted', () => {
  // Untagged keeps the exact record shape it had before tags existed.
  const bare = validFeedback(body())
  assert.equal('tag' in bare, false)
  const tagged = validFeedback(body({ verdict: 'dislike', tag: 'wrong agent' }))
  assert.equal(tagged.tag, 'wrong agent')
  assert.deepEqual([...TAGS], [...ROUTING_TAGS, ...ANSWER_TAGS])
  for (const t of TAGS) assert.equal(validFeedback(body({ tag: t })).tag, t, t)
  assert.equal(tagIsAnswerOnly('not enough detail'), true)
  assert.equal(tagIsAnswerOnly('too slow'), true)
  assert.equal(tagIsAnswerOnly('good answer'), true)
  for (const t of ROUTING_TAGS) assert.equal(tagIsAnswerOnly(t), false, t)
  assert.equal(tagIsAnswerOnly(undefined), false, 'untagged keeps the pre-tag behaviour')
})

test('validFeedback: malformed bodies are rejected, never stored', () => {
  const bad = [
    [null, /expected an object/],
    [body({ sessionId: '' }), /sessionId/],
    [body({ sessionId: 'has space' }), /sessionId/],
    [body({ messageId: '' }), /messageId/],
    [body({ verdict: 'meh' }), /verdict/],
    [body({ verdict: undefined }), /verdict/],
    [body({ verdict: 'clear', messageId: '' }), /messageId/],
    [body({ verdict: 'clear', sessionId: '' }), /sessionId/],
    [body({ reason: 'x'.repeat(MAX_REASON + 1) }), /reason/],
    [body({ tag: 'wrong reason' }), /tag/],
    [body({ tag: 'Wrong Agent' }), /tag/],
    [body({ tag: 7 }), /tag/],
    [body({ suggestedAgent: 'Not An Agent' }), /suggestedAgent/],
    [body({ suggestedAgent: 'auto' }), /suggestedAgent/],
    [body({ provider: 'has space' }), /provider/],
    [body({ model: 'bad model!' }), /model/],
  ]
  for (const [input, re] of bad) assert.throws(() => validFeedback(input), re, JSON.stringify(input))
})

test('validFeedback: a clear stores only its keys, ignoring any verdict attributes', () => {
  const r = validFeedback(
    body({ verdict: 'clear', reason: 'stale', tag: 'wrong agent', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' }),
    { now: () => '2026-09-21T00:00:00.000Z' },
  )
  assert.deepEqual(r, { ts: '2026-09-21T00:00:00.000Z', sessionId: 'sess-1', messageId: 'msg-1', verdict: 'clear' })
})

test('createFeedback: append then list, newest last, and a session filter', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  assert.deepEqual(await store.list(), [], 'no file yet is empty, not an error')
  await store.append(validFeedback(body({ messageId: 'm1', verdict: 'dislike' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  await store.append(validFeedback({ sessionId: 'sess-2', messageId: 'm9', verdict: 'like' }, { now: () => '2026-09-21T00:00:02.000Z' }))
  const all = await store.list()
  assert.deepEqual(all.map((r) => r.messageId), ['m1', 'm9'])
  assert.deepEqual((await store.list('sess-1')).map((r) => r.messageId), ['m1'])
  assert.deepEqual((await store.list('sess-2')).map((r) => r.messageId), ['m9'])
})

test('createFeedback: the same message replaces its earlier verdict, append-only on disk', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ verdict: 'dislike', reason: 'wrong agent' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  await store.append(validFeedback(body({ verdict: 'like', reason: 'changed my mind' }), { now: () => '2026-09-21T00:00:02.000Z' }))
  const list = await store.list('sess-1')
  assert.equal(list.length, 1, 'one row per message, not two')
  assert.equal(list[0].verdict, 'like')
  assert.equal(list[0].reason, 'changed my mind')
  // Both writes are still on disk: nothing was rewritten, so an interrupted write cannot lose the first.
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
})

test('createFeedback: a clear is an appended tombstone and drops the pair from reads', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ verdict: 'like' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  assert.deepEqual((await store.list('sess-1')).map((r) => r.verdict), ['like'])
  await store.append(validFeedback({ sessionId: 'sess-1', messageId: 'msg-1', verdict: 'clear' }, { now: () => '2026-09-21T00:00:02.000Z' }))
  assert.deepEqual(await store.list('sess-1'), [], 'the cleared pair is not read back')
  assert.deepEqual(await store.list(), [], 'nor under an unfiltered read')
  // The like is still on disk untouched: clearing appended, it did not rewrite or remove it.
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
})

test('createFeedback: the newest row wins, so a verdict after a clear comes back', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ messageId: 'm1', verdict: 'like' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  await store.append(validFeedback(body({ messageId: 'm2', verdict: 'dislike' }), { now: () => '2026-09-21T00:00:02.000Z' }))
  await store.append(validFeedback(body({ messageId: 'm1', verdict: 'clear' }), { now: () => '2026-09-21T00:00:03.000Z' }))
  assert.deepEqual((await store.list('sess-1')).map((r) => r.messageId), ['m2'], 'only the cleared message is dropped')
  await store.append(validFeedback(body({ messageId: 'm1', verdict: 'like', reason: 'it grew on me' }), { now: () => '2026-09-21T00:00:04.000Z' }))
  const back = await store.list('sess-1')
  assert.deepEqual(back.map((r) => r.messageId), ['m2', 'm1'], 'the clear is beaten by a newer row')
  assert.equal(back.find((r) => r.messageId === 'm1').verdict, 'like')
})

test('createFeedback: the tag obeys the same newest-wins upsert and tombstone rules', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ verdict: 'dislike', tag: 'wrong agent' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  assert.equal((await store.list('sess-1'))[0].tag, 'wrong agent')
  // A newer row wins whole: a replacement without a tag leaves the pair untagged, it does not merge.
  await store.append(validFeedback(body({ verdict: 'dislike', tag: 'too slow' }), { now: () => '2026-09-21T00:00:02.000Z' }))
  assert.equal((await store.list('sess-1'))[0].tag, 'too slow')
  await store.append(validFeedback(body({ verdict: 'like' }), { now: () => '2026-09-21T00:00:03.000Z' }))
  assert.equal('tag' in (await store.list('sess-1'))[0], false, 'the newest row had no tag')
  // The clear takes the tag with it: there is no verdict left for a tag to describe.
  await store.append(validFeedback(body({ verdict: 'dislike', tag: 'too slow' }), { now: () => '2026-09-21T00:00:04.000Z' }))
  await store.append(validFeedback({ sessionId: 'sess-1', messageId: 'msg-1', verdict: 'clear' }, { now: () => '2026-09-21T00:00:05.000Z' }))
  assert.deepEqual(await store.list('sess-1'), [], 'the pair and its tag are gone')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 5, 'still append-only on disk')
})

test('createFeedback: a crash mid-clear cannot lose the verdict it was clearing', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ verdict: 'like' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  appendFileSync(file, '{"sessionId":"sess-1","messageId":"msg-1","verdict":"cle') // the clear died mid-row
  const list = await store.list('sess-1')
  assert.equal(list.length, 1, 'the truncated tombstone is skipped, the like survives')
  assert.equal(list[0].verdict, 'like')
})

test('createFeedback: a truncated final line is skipped, the rows before it survive', async () => {
  const file = tmp()
  const store = createFeedback({ file })
  await store.append(validFeedback(body({ messageId: 'good' }), { now: () => '2026-09-21T00:00:01.000Z' }))
  appendFileSync(file, '{"sessionId":"sess-1","messageId":"cut') // the write died mid-line
  const list = await store.list()
  assert.deepEqual(list.map((r) => r.messageId), ['good'])
})

test('createFeedback: an unreadable file reads as empty rather than throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-feedback-bad-'))
  const file = join(dir, 'feedback.jsonl')
  writeFileSync(file, 'not json at all\n')
  assert.deepEqual(await createFeedback({ file }).list(), [])
})

test('validFeedback: the run the answer came from is kept when given, checked, and not stored on a clear', () => {
  const r = validFeedback(body({ runId: ' 0f8fad5b-d9cb-469f-a165-70867728950e ' }))
  assert.equal(r.runId, '0f8fad5b-d9cb-469f-a165-70867728950e', 'the exact link from the message to its run')
  assert.equal('runId' in validFeedback(body()), false, 'absent stays absent')
  assert.throws(() => validFeedback(body({ runId: 'no spaces allowed' })), /runId/)
  assert.throws(() => validFeedback(body({ runId: 'x'.repeat(81) })), /runId/)
  assert.equal('runId' in validFeedback(body({ verdict: 'clear', runId: 'run-1' })), false, 'a clear needs only its keys')
})
