import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

test('--level WARN prints warnings and errors only', () => {
  const out = execFileSync(process.execPath, ['src/cli.js', 'data/app.txt', '--level', 'WARN'], { encoding: 'utf8' })
  const levels = out.trim().split('\n').map((line) => line.split(/\s+/)[1])
  assert.deepEqual([...new Set(levels)].sort(), ['ERROR', 'WARN'])
})
