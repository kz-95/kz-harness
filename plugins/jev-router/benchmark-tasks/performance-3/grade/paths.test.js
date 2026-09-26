// Every call of countPaths() runs in a child process with a time limit: its plain recursion on a
// 20 by 20 grid never ends, and a synchronous loop cannot be interrupted in this process.
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

for (const [name, which] of [
  ['a blocked start has 0n paths', 'blocked-start'],
  ['one open cell has 1n', 'one-cell'],
  ['a blocked end has 0n', 'blocked-end'],
  ['a small grid with obstacles', 'small-obstacles'],
  ['24 by 30 with a wall and one gap in it', 'wall-with-a-gap'],
  ['20 by 20 with scattered obstacles', 'scattered-20'],
  ['60 by 60 open is 118 choose 59', 'open-60'],
  ['60 by 60 with a pattern of obstacles', 'dotted-60'],
]) {
  test(`${name}, in under 2 seconds`, () => {
    const r = run(which, { timed: true })
    assert.ok(r.ok, r.why)
  })
}
