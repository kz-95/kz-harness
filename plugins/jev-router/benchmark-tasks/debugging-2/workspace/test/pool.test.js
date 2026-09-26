import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAll } from '../src/pool.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('runs every job and reports each result in order', { timeout: 2000 }, async () => {
  const jobs = [async () => { await wait(20); return 'a' }, async () => 'b', async () => 'c']
  assert.deepEqual(await runAll(jobs, 2), [
    { status: 'fulfilled', value: 'a' },
    { status: 'fulfilled', value: 'b' },
    { status: 'fulfilled', value: 'c' },
  ])
})

test('failing jobs followed by others', { timeout: 2000 }, async () => {
  const boom = new Error('boom')
  const jobs = [async () => { throw boom }, async () => { throw boom }, async () => 'c', async () => 'd']
  const results = await runAll(jobs, 2)
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'fulfilled', 'fulfilled'])
})
