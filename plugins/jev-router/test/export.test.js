// Exporting a chat as Markdown: the multi-frame zstd log DSH writes, and the
// Markdown it turns into.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { exportSession, fileNameFor, findSession, parseEvents, redactSecrets, toMarkdown, unzstd } from '../export.js'

/** DSH appends each batch of lines as its own zstd frame; a file is frames back to back. */
const log = (...batches) => Buffer.concat(batches.map((rows) => zstdCompressSync(Buffer.from(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`))))

const EVENTS = [
  [{ type: 'session', version: 3, id: 'abc-123', createdAt: Date.UTC(2026, 0, 2, 9, 5), cwd: 'C:\\Work\\app' }],
  [{ type: 'user/message', seq: 1, time: Date.UTC(2026, 0, 2, 9, 6), data: { content: [{ type: 'text', text: 'fix the parser' }] } }],
  [
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' } } } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"src/parse.js"}' } },
    { type: 'tool/result', seq: 4, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'line one\nline two' }] }] } } },
    { type: 'assistant/message', seq: 5, time: Date.UTC(2026, 0, 2, 9, 7), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }, { type: 'tool-call', id: 'c1', name: 'read' }] } } },
    { type: 'session/title', seq: 6, data: { title: 'Fix the parser' } },
  ],
]

test('unzstd reads every frame, not just the first', () => {
  const buf = log(...EVENTS)
  const events = parseEvents(buf)
  assert.equal(events.length, 7, 'all three frames came back')
  assert.equal(events[0].type, 'session')
  assert.equal(events.at(-1).type, 'session/title')
  // A single frame still works, and junk after the last frame is dropped, not thrown.
  assert.equal(parseEvents(log(EVENTS[0])).length, 1)
  assert.equal(parseEvents(Buffer.concat([buf, Buffer.from('trailing junk')])).length, 7)
  assert.equal(unzstd(Buffer.from('not zstd at all')).length, 0)
})

test('a broken line is skipped, not fatal', () => {
  const buf = Buffer.concat([log(EVENTS[0]), zstdCompressSync(Buffer.from('{ not json\n{"type":"user/message","data":{"content":[{"type":"text","text":"hi"}]}}\n'))])
  const events = parseEvents(buf)
  assert.deepEqual(events.map((e) => e.type), ['session', 'user/message'])
})

test('toMarkdown: heading, facts, both voices, tool folded away', () => {
  const md = toMarkdown(parseEvents(log(...EVENTS)), { now: Date.UTC(2026, 0, 3, 10) })
  assert.match(md, /^# Fix the parser\n/)
  assert.match(md, /\*\*Workspace:\*\* `C:\\Work\\app`/)
  assert.match(md, /\*\*Model:\*\* `deepseek\/deepseek-flash` \(effort high\)/)
  assert.match(md, /\*\*Exported:\*\* 2026-01-03 10:00 UTC/)
  assert.match(md, /## You · 2026-01-02 09:06\n\nfix the parser/)
  assert.match(md, /## Assistant · 2026-01-02 09:07\n\nFixed it\./)
  assert.match(md, /<details><summary>Tool: <code>read<\/code><\/summary>/)
  assert.match(md, /src\/parse\.js/)
  assert.match(md, /line one\nline two/)
  assert.ok(md.endsWith('\n'))
})

test('toMarkdown: tools can be left out, and long output is clipped', () => {
  const events = parseEvents(log(...EVENTS))
  const plain = toMarkdown(events, { tools: false })
  assert.equal(plain.includes('<details>'), false)
  assert.match(plain, /Fixed it\./, 'the conversation itself stays')

  const long = [{ type: 'tool/call', data: { callId: 'c', name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(9000) }] }] } } }]
  const md = toMarkdown(long, { maxToolChars: 100 })
  assert.match(md, /… 8900 more characters/)
})

test('toMarkdown: output containing a code fence does not end the block early', () => {
  const events = [{ type: 'tool/call', data: { callId: 'c', name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '```js\nconst a = 1\n```' }] }] } } }]
  const md = toMarkdown(events)
  assert.match(md, /````\n```js/, 'the wrapping fence is longer than the one inside')
})

test('toMarkdown: an empty log still produces a document', () => {
  const md = toMarkdown([], { now: Date.UTC(2026, 0, 3, 10) })
  assert.match(md, /^# Chat\n/)
  assert.match(md, /\*\*Exported:\*\*/)
})

test('fileNameFor: safe, dated, never empty', () => {
  assert.equal(fileNameFor('Fix the parser', Date.UTC(2026, 0, 2)), 'fix-the-parser-2026-01-02.md')
  assert.equal(fileNameFor('  ../../etc/passwd  ', Date.UTC(2026, 0, 2)), 'etc-passwd-2026-01-02.md')
  assert.equal(fileNameFor('', Date.UTC(2026, 0, 2)), 'chat-2026-01-02.md')
  assert.equal(fileNameFor(null, Date.UTC(2026, 0, 2)), 'chat-2026-01-02.md')
  assert.equal(fileNameFor('!!!', Date.UTC(2026, 0, 2)), 'chat-2026-01-02.md')
})

test('findSession: matches both stored layouts and refuses a path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kz-sessions-'))
  mkdirSync(join(root, '--C-Work-app--', 'session-abc-123'), { recursive: true })
  mkdirSync(join(root, '--C-Other--', 'def-456'), { recursive: true })
  assert.match(await findSession(root, 'abc-123'), /session-abc-123/)
  assert.match(await findSession(root, 'def-456'), /def-456/)
  assert.equal(await findSession(root, 'nope-000'), null)
  for (const bad of ['../../etc', 'a/b', '', 'x'.repeat(81), null]) {
    await assert.rejects(findSession(root, bad), /session: a session id/, JSON.stringify(bad))
  }
})

test('exportSession: reads a stored chat; a chat with nothing saved is a 404', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kz-sessions-'))
  const dir = join(root, '--C-Work-app--', 'session-abc-123')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), log(...EVENTS))
  const r = await exportSession(root, 'abc-123')
  assert.equal(r.title, 'Fix the parser')
  assert.match(r.filename, /^fix-the-parser-\d{4}-\d{2}-\d{2}\.md$/)
  assert.match(r.markdown, /fix the parser/)
  await assert.rejects(exportSession(root, 'missing-1'), (e) => e.status === 404 && /nothing saved yet/.test(e.message))
})

test('an exported chat never carries a key out of the machine', () => {
  const secrets = 'sk-abcdefghij1234567890 tsk_abcdefghij1234 ghp_abcdefghij1234567890ab xoxb-1234567890-abc AIzaSyAabcdefghij1234567890 hf_abcdefghij1234567890ab'
  const events = [
    { type: 'session', id: 's', cwd: 'C:\Work', createdAt: 0 },
    { type: 'user/message', time: 0, data: { content: [{ type: 'text', text: `my key is ${secrets}` }] } },
    { type: 'tool/call', data: { callId: 'c', name: 'pwsh', arguments: '{"command":"echo sk-abcdefghij1234567890"}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef' }] }] } } },
  ]
  const md = toMarkdown(events)
  for (const s of secrets.split(' ')) assert.equal(md.includes(s), false, `leaked ${s.slice(0, 8)}`)
  assert.equal(md.includes('eyJhbGciOiJIUzI1NiJ9abcdef'), false, 'leaked a bearer token')
  assert.match(md, /sk-abc\.\.\.REDACTED/, 'enough of the prefix is left to recognise which key it was')
  assert.equal((md.match(/REDACTED/g) ?? []).length >= 7, true)
})

test('redaction leaves ordinary output alone', () => {
  const plain = 'commit 3f9a2b1c8d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80 in src/sk-parser.js, base64 aGVsbG8gd29ybGQgdGhpcyBpcyBmaW5l'
  assert.equal(redactSecrets(plain), plain)
})
