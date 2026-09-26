import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { greet } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'index.js')).href)

test('the default greeting is Welcome', () => {
  assert.equal(greet('Ana'), 'Welcome, Ana!')
})

test('another greeting for one call still works', () => {
  assert.equal(greet('Bo', { greeting: 'Hi' }), 'Hi, Bo!')
})
