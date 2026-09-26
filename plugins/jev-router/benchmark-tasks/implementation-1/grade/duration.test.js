import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { formatDuration } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'duration.js')).href)

const CASES = [
  [0, '0s'],
  [999, '0s'],
  [1000, '1s'],
  [59999, '59s'],
  [60000, '1m 00s'],
  [62000, '1m 02s'],
  [3600000, '1h 00m 00s'],
  [3723000, '1h 02m 03s'],
  [5400000, '1h 30m 00s'],
  [90000000, '25h 00m 00s'],
]
for (const [ms, text] of CASES) {
  test(`${ms} ms is ${text}`, () => {
    assert.equal(formatDuration(ms), text)
  })
}

for (const bad of [-1, NaN, Infinity, -Infinity]) {
  test(`${bad} throws a RangeError`, () => {
    assert.throws(() => formatDuration(bad), RangeError)
  })
}
