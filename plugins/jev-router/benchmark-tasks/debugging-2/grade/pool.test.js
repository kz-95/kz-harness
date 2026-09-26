import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { runAll } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'pool.js')).href)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('five failures under a limit of 2 do not stall it', { timeout: 2000 }, async () => {
  const jobs = Array.from({ length: 8 }, (_, i) => async () => {
    await wait(5)
    if (i < 5) throw new Error(`job ${i} failed`)
    return i
  })
  const results = await runAll(jobs, 2)
  assert.equal(results.length, 8)
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
})

test('results come back in input order, however the jobs finish', { timeout: 2000 }, async () => {
  const boom = new Error('late failure')
  const jobs = [
    async () => { await wait(60); return 'slow' },
    async () => { await wait(5); throw boom },
    async () => 'quick',
    async () => { await wait(30); return 7 },
  ]
  assert.deepEqual(await runAll(jobs, 3), [
    { status: 'fulfilled', value: 'slow' },
    { status: 'rejected', reason: boom },
    { status: 'fulfilled', value: 'quick' },
    { status: 'fulfilled', value: 7 },
  ])
})

test('never more than limit jobs run at once, and limit do', { timeout: 2000 }, async () => {
  let now = 0
  let most = 0
  const jobs = Array.from({ length: 9 }, (_, i) => async () => {
    now++
    most = Math.max(most, now)
    await wait(10 + (i % 3) * 5)
    now--
    if (i % 4 === 0) throw new Error(`job ${i}`)
    return i
  })
  const results = await runAll(jobs, 3)
  assert.equal(results.length, 9)
  assert.equal(most, 3)
})

test('an empty list resolves to an empty list', { timeout: 2000 }, async () => {
  assert.deepEqual(await runAll([], 2), [])
})

test('a limit above the number of jobs runs them all at once', { timeout: 2000 }, async () => {
  let now = 0
  let most = 0
  const jobs = Array.from({ length: 3 }, (_, i) => async () => { now++; most = Math.max(most, now); await wait(10); now--; return i })
  assert.deepEqual((await runAll(jobs, 10)).map((r) => r.value), [0, 1, 2])
  assert.equal(most, 3)
})

test('it never rejects, even when every job does', { timeout: 2000 }, async () => {
  const jobs = Array.from({ length: 4 }, (_, i) => async () => { throw new Error(`job ${i}`) })
  const results = await runAll(jobs, 1)
  assert.deepEqual(results.map((r) => [r.status, r.reason.message]), [['rejected', 'job 0'], ['rejected', 'job 1'], ['rejected', 'job 2'], ['rejected', 'job 3']])
})
