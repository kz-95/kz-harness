// scripts/doc-queue.mjs: agents queue what the docs must say, one writer drains it, and a finished
// step's progress line is written with no model. Run on a small repository of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_URL = new URL('../../../scripts/doc-queue.mjs', import.meta.url)
const SCRIPT = fileURLToPath(SCRIPT_URL)
// import() takes a URL, never a path: a bare `C:\...` is read as the scheme `c:` and throws.
const { QUEUE, addNote, listNotes, logProgress, markDone, progressLine, withLock } = await import(SCRIPT_URL.href)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

const HANDOFF = '# KzH handoff\n\nIntro.\n\n## State\n\n```\nbranch x\n```\n\n## Where this was left\n\nText.\n'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-docqueue-'))
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'handoff.md'), HANDOFF)
  writeFileSync(join(dir, 'docs', 'laya-auto.md'), '# Laya Auto\n')
  writeFileSync(join(dir, 'README.md'), '# KzH\n')
  execFileSync('git', ['init', '-q'], { cwd: dir, env })
  return dir
}
const at = (iso) => () => new Date(iso)

test('a note is queued with its doc checked, and a note that breaks the docs\' rules is refused', () => {
  const dir = repo()
  const n = addNote(dir, { doc: 'docs/laya-auto.md', section: '9.4', fact: 'The gate held the slot for 44.8 s.', evidence: 'e2e step 5', by: 'e2e' }, { now: at('2026-09-25T16:00:00Z') })
  assert.match(n.id, /^[0-9a-z]+-[0-9a-f]{6}$/)
  assert.deepEqual(listNotes(dir), [{ id: n.id, ts: '2026-09-25T16:00:00.000Z', doc: 'docs/laya-auto.md', section: '9.4', fact: 'The gate held the slot for 44.8 s.', evidence: 'e2e step 5', by: 'e2e' }])
  addNote(dir, { doc: 'README.md', fact: 'README is a doc too.' })
  assert.equal(listNotes(dir).length, 2)
  assert.throws(() => addNote(dir, { doc: 'docs/laya-auto.md', fact: 'A dash \u2014 here' }), /em dash or en dash/)
  assert.throws(() => addNote(dir, { doc: 'docs/missing.md', fact: 'x' }), /does not exist/)
  assert.throws(() => addNote(dir, { doc: 'plugins/jev-router/index.js', fact: 'x' }), /README\.md or a Markdown file under docs/)
  assert.throws(() => addNote(dir, { doc: '../outside.md', fact: 'x' }), /README\.md or a Markdown file under docs/)
  assert.throws(() => addNote(dir, { doc: 'docs/laya-auto.md', fact: '   ' }), /fact is required/)
  assert.equal(listNotes(dir).length, 2, 'a refused note is never queued')
})

test('notes queued by many processes at once all arrive whole', async () => {
  const dir = repo()
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, 'add', '--doc', 'docs/handoff.md', '--fact', `note ${i} ${'x'.repeat(300)}`, '--by', `agent-${i}`], { cwd: dir, env })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })))
  const notes = listNotes(dir)
  assert.equal(notes.length, 12)
  assert.deepEqual(notes.map((n) => n.by).sort(), Array.from({ length: 12 }, (_, i) => `agent-${i}`).sort())
})

test('done removes only the notes named, and an unknown id removes nothing', () => {
  const dir = repo()
  const a = addNote(dir, { doc: 'docs/handoff.md', fact: 'one' })
  const b = addNote(dir, { doc: 'docs/handoff.md', fact: 'two' })
  const c = addNote(dir, { doc: 'docs/handoff.md', fact: 'three' })
  assert.throws(() => markDone(dir, [a.id, 'nope']), /not queued: nope/)
  assert.equal(listNotes(dir).length, 3)
  assert.deepEqual(markDone(dir, [a.id, c.id]), { removed: 2, left: 1 })
  assert.deepEqual(listNotes(dir).map((n) => n.id), [b.id])
  assert.ok(!existsSync(join(dir, '.doc-queue.lock')), 'the lock is released')
})

test('the progress log is made after State, newest first, and the rest of the handoff is untouched', () => {
  const dir = repo()
  logProgress(dir, { step: 'G1 provider-core', summary: 'Built the provider records.', commit: 'abcdef1234', tests: '851 850 0 1' }, { now: at('2026-09-25T09:00:00Z') })
  logProgress(dir, { step: 'fix batch 5', summary: 'Fixed four test findings', tests: '1188/1187/0/1' }, { now: at('2026-09-25T15:40:00Z') })
  const text = readFileSync(join(dir, 'docs', 'handoff.md'), 'utf8')
  assert.equal(text, [
    '# KzH handoff', '', 'Intro.', '', '## State', '', '```', 'branch x', '```', '',
    '## Progress log', '',
    'One line per finished workflow step, newest first, written by `scripts/doc-queue.mjs log` when the step ends.', '',
    '- 2026-09-25 15:40 UTC, fix batch 5: Fixed four test findings (1188 tests, 1187 pass, 0 fail, 1 skipped).',
    '- 2026-09-25 09:00 UTC, G1 provider-core: Built the provider records (commit abcdef1; 851 tests, 850 pass, 0 fail, 1 skipped).',
    '',
    '## Where this was left', '', 'Text.', '',
  ].join('\n'))
})

test('a progress line refuses what it cannot write truthfully', () => {
  assert.throws(() => progressLine({ step: 'x', summary: 'two\nlines' }), /one line/)
  assert.throws(() => progressLine({ step: 'x', summary: 'y', commit: 'not-a-sha' }), /commit must be a commit sha/)
  assert.throws(() => progressLine({ step: 'x', summary: 'y', tests: '10 9 1' }), /four whole numbers/)
  assert.throws(() => progressLine({ step: 'x', summary: 'an en dash \u2013 here' }), /em dash or en dash/)
  assert.throws(() => progressLine({ summary: 'y' }), /step is required/)
  assert.throws(() => progressLine({ step: 'x', summary: 'y', at: 'yesterday' }), /at must be an ISO time/)
  // A step written in after the fact keeps the time it ended.
  assert.equal(progressLine({ step: 'design', summary: 'Wrote it', at: '2026-09-24T18:10:00Z' }, { now: at('2026-09-25T16:00:00Z') }), '- 2026-09-24 18:10 UTC, design: Wrote it.')
})

test('a writer waits for the lock, and a lock a dead process left is taken back', () => {
  const dir = repo()
  mkdirSync(join(dir, '.doc-queue.lock'))
  assert.throws(() => withLock(dir, () => 'x', { waitMs: 100, staleMs: 60_000 }), /locked by another writer/)
  assert.equal(withLock(dir, () => 'taken', { waitMs: 100, staleMs: 0 }), 'taken', 'a stale lock does not block for ever')
  assert.ok(!existsSync(join(dir, '.doc-queue.lock')))
})

test('the queue file is a dotfile, which the repository never commits', () => {
  assert.equal(QUEUE, '.doc-queue.jsonl')
  const ignore = readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8')
  assert.match(ignore, /^\.\*$/m, '.gitignore ignores every dotfile')
})
