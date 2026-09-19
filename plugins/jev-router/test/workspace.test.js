// Process handling the router relies on: a task text never runs as a command,
// and abort kills the whole tree even when a grandchild holds the pipe open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedSince, ensureHandoffIgnored, run, snapshot } from '../workspace.js'

test('task text on stdin is data, not a command', async () => {
  const r = await run('node -e "process.stdin.pipe(process.stdout)"', [], { shell: true, input: 'hello & echo INJECTED %PATH%' })
  assert.equal(r.code, 0)
  assert.equal(r.output.trim(), 'hello & echo INJECTED %PATH%')
})

test('abort kills a shell child and its grandchild promptly', async () => {
  const ac = new AbortController()
  const started = Date.now()
  setTimeout(() => ac.abort(), 300)
  const grandchild = "require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' })"
  const r = await run(`node -e "${grandchild}"`, [], { shell: true, signal: ac.signal })
  assert.notEqual(r.code, 0)
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
})

test('.kz-harness/ is not an agent change and is excluded from git locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const before = await snapshot(dir)
  mkdirSync(join(dir, '.kz-harness'))
  writeFileSync(join(dir, '.kz-harness', 'handoff.md'), 'note')
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.deepEqual((await changedSince(dir, before)).files, ['a.txt'])
  await ensureHandoffIgnored(dir)
  await ensureHandoffIgnored(dir)
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split(/\r?\n/).filter((l) => l === '.kz-harness/').length, 1)
  await ensureHandoffIgnored(mkdtempSync(join(tmpdir(), 'jev-nogit-'))) // outside git: no-op, no throw
})
