// Process handling the router relies on: a task text never runs as a command,
// and abort kills the whole tree even when a grandchild holds the pipe open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../workspace.js'

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
