// Every call of dedupe() runs in a child process with a time limit: a synchronous loop cannot be
// interrupted in this process, and the list as it was would hold a core for minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('./run.mjs', import.meta.url))

/**
 * One case in a child process. A timed case measures the agent's own calls in the child, so the
 * start of a process and the case's own setup are not counted against its 2 seconds, and the child
 * is killed once it has had `killAfter` seconds; an untimed case has 10.
 */
function run(which, { timed = false, killAfter = timed ? 4 : 10 } = {}) {
  const r = spawnSync(process.execPath, [RUNNER, process.env.BENCH_WORKSPACE, which], { encoding: 'utf8', timeout: killAfter * 1000 })
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { ok: false, why: timed ? `took longer than 2 seconds: stopped after ${killAfter}` : `took longer than ${killAfter} seconds` }
  let out
  try { out = JSON.parse(r.stdout) } catch { return { ok: false, why: `the case did not finish: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}` } }
  if (out.ok && timed && !(out.ms < 2000)) return { ok: false, why: `took longer than 2 seconds: ${(out.ms / 1000).toFixed(1)}` }
  return out
}

for (const [name, which, timed] of [
  ['numbers keep their first place', 'numbers', false],
  ['NaN matches NaN', 'nan', false],
  ['0 and -0 match, and the first of them is kept', 'zeros', false],
  ['objects match only themselves', 'objects', false],
  ['200,000 values, half of them repeats, in under 2 seconds', 'large', true],
]) {
  test(name, () => {
    const r = run(which, { timed })
    assert.ok(r.ok, r.why)
  })
}
