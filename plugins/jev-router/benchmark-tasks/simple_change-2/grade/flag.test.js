import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.BENCH_WORKSPACE
const WARNING = 'warning: --verbose is deprecated, use --debug'

function cli(...args) {
  const r = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: ws, encoding: 'utf8', timeout: 10_000 })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const debugLines = (out) => out.split('\n').filter((line) => line.startsWith('debug: '))

test('--debug turns the step lines on, and nothing is warned', () => {
  const r = cli('--debug', 'sample.txt')
  assert.equal(r.code, 0)
  assert.deepEqual(debugLines(r.out), ['debug: reading sample.txt', 'debug: 4 lines, 1 of them blank and not counted'])
  assert.match(r.out, /3 lines in sample\.txt/)
  assert.equal(r.err, '')
})

test('--verbose still turns them on, and warns exactly once on stderr', () => {
  const r = cli('--verbose', 'sample.txt')
  assert.equal(r.code, 0)
  assert.equal(debugLines(r.out).length, 2)
  assert.equal(r.err, `${WARNING}\n`)
})

test('--verbose given twice warns once', () => {
  const r = cli('--verbose', 'sample.txt', '--verbose')
  assert.equal(r.err, `${WARNING}\n`)
  assert.equal(debugLines(r.out).length, 2)
})

test('without either flag there are no step lines and no warning', () => {
  const r = cli('--blank', 'sample.txt')
  assert.equal(r.code, 0)
  assert.deepEqual(debugLines(r.out), [])
  assert.match(r.out, /4 lines in sample\.txt/)
  assert.equal(r.err, '')
})

test('--help lists --debug and not --verbose', () => {
  const r = cli('--help')
  assert.equal(r.code, 0)
  assert.match(r.out, /--debug/)
  assert.doesNotMatch(r.out, /--verbose/)
  assert.match(r.out, /--blank/)
})

test('an unknown option is still refused', () => {
  const r = cli('--loud', 'sample.txt')
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown option --loud/)
})

test('README.md names --debug and not --verbose', () => {
  const readme = readFileSync(join(ws, 'README.md'), 'utf8')
  assert.match(readme, /--debug/)
  assert.doesNotMatch(readme, /--verbose/)
})
