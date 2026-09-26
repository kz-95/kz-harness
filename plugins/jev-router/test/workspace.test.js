// Process handling the router relies on: a task text never runs as a command,
// and abort kills the whole tree even when a grandchild holds the pipe open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedSince, ensureHandoffIgnored, run, runChecks, snapshot } from '../workspace.js'

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

test('runChecks runs its scripts with the environment it is given, so a check that runs an agent\'s code can be kept from KzH\'s keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-checks-env-'))
  const show = "console.log('seen=' + (process.env.KZH_CHECK_SEEN ?? 'unset') + ' key=' + (process.env.KZH_TEST_SECRET_KEY ?? 'none'))"
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'env-check', private: true, scripts: { test: `node -e "${show}"` } }))
  process.env.KZH_TEST_SECRET_KEY = 'in-kzh-only'
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'KZH_TEST_SECRET_KEY'))
    const [given] = await runChecks(dir, { scripts: ['test'], timeoutMs: 60_000, outputChars: 500, env: { ...env, KZH_CHECK_SEEN: 'given' } })
    assert.equal(given.passed, true, given.output)
    assert.match(given.output, /seen=given key=none/, 'the environment given, and nothing of KzH\'s beside it')
    // With none given, the checks run in KzH's own, as they always have.
    const [own] = await runChecks(dir, { scripts: ['test'], timeoutMs: 60_000, outputChars: 500 })
    assert.match(own.output, /seen=unset key=in-kzh-only/)
  } finally {
    delete process.env.KZH_TEST_SECRET_KEY
  }
})

test('run() says when its own time limit ended the command, and not when the caller stopped it', async () => {
  const slow = 'node -e "setTimeout(() => {}, 20000)"'
  const timed = await run(slow, [], { shell: true, timeoutMs: 300 })
  assert.equal(timed.timedOut, true)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const stopped = await run(slow, [], { shell: true, timeoutMs: 60_000, signal: ac.signal })
  assert.equal(stopped.timedOut, undefined, 'a stop is not a time limit')
  const quick = await run('node -e "0"', [], { shell: true })
  assert.equal(quick.timedOut, undefined)
})

test('a time limit ends every process the command started, also one that would spin for good, so a hanging check leaves nothing running', async () => {
  const spin = "const c = require('child_process').spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }); console.log('grandchild ' + c.pid); setInterval(() => {}, 1000)"
  const r = await run(process.execPath, ['-e', spin], { timeoutMs: 1500 })
  const pid = Number(/grandchild (\d+)/.exec(r.output)?.[1])
  assert.ok(pid > 0, r.output)
  // Gone, or a zombie waiting to be reaped, which runs nothing.
  const alive = () => {
    try { process.kill(pid, 0) } catch { return false }
    try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
  }
  try {
    assert.equal(r.timedOut, true)
    const deadline = Date.now() + 5000
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(alive(), false, 'the process the command started is gone')
  } finally {
    // Where it survived, this test does not leave it spinning.
    if (alive()) process.kill(pid, 'SIGKILL')
  }
})
