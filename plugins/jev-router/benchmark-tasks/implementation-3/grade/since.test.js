import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.BENCH_WORKSPACE
const NOW = '2026-09-20T12:00:00Z'
const ERROR = 'error: --since expects an ISO date-time or an age like 12h'

/** The tool, run as the prompt says, with LOG_NOW set unless `now` is null. */
function tool(args, { now = NOW } = {}) {
  const env = { ...process.env }
  delete env.LOG_NOW
  if (now !== null) env.LOG_NOW = now
  const r = spawnSync(process.execPath, ['src/cli.js', 'data/app.txt', ...args], { cwd: ws, env, encoding: 'utf8', timeout: 10_000 })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

// The lines the tool printed before, formatted as it always has: the time, the level padded to
// five characters, and the text.
const ENTRIES = readFileSync(join(ws, 'data', 'app.txt'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
  const [, time, level, text] = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line)
  return { time, level, text }
})
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']
const printed = ({ since = null, level = null } = {}) => ENTRIES
  .filter((e) => since === null || Date.parse(e.time) >= Date.parse(since))
  .filter((e) => level === null || LEVELS.indexOf(e.level) >= LEVELS.indexOf(level))
  .map((e) => `${e.time} ${e.level.padEnd(5)} ${e.text}\n`).join('')

function prints(args, expected, options) {
  const r = tool(args, options)
  assert.equal(r.err, '', `nothing on stderr for ${args.join(' ')}`)
  assert.equal(r.code, 0)
  assert.equal(r.out, expected)
}

test('an ISO date-time bound is inclusive', () => {
  prints(['--since', '2026-09-20T11:30:00Z'], printed({ since: '2026-09-20T11:30:00Z' }))
})

test('an ISO date-time a second later leaves out the line at the earlier second', () => {
  prints(['--since', '2026-09-20T11:59:01Z'], printed({ since: '2026-09-20T11:59:01Z' }))
})

test('90m counts back from LOG_NOW, inclusive', () => {
  prints(['--since', '90m'], printed({ since: '2026-09-20T10:30:00Z' }))
})

test('2h counts back from LOG_NOW', () => {
  prints(['--since', '2h'], printed({ since: '2026-09-20T10:00:00Z' }))
})

test('1d counts back from LOG_NOW', () => {
  prints(['--since', '1d'], printed({ since: '2026-09-19T12:00:00Z' }))
})

test('0m is the moment in LOG_NOW itself', () => {
  prints(['--since', '0m'], printed({ since: NOW }))
})

test('an age and the date-time it names print the same lines', () => {
  assert.equal(tool(['--since', '2h']).out, tool(['--since', '2026-09-20T10:00:00Z']).out)
})

test('--since works together with --level', () => {
  prints(['--since', '2026-09-20T00:00:00Z', '--level', 'WARN'], printed({ since: '2026-09-20T00:00:00Z', level: 'WARN' }))
})

for (const [name, args] of [['3w', ['--since', '3w']], ['abc', ['--since', 'abc']], ['12', ['--since', '12']], ['a missing value', ['--since']]]) {
  test(`--since with ${name} prints the exact error on stderr, nothing on stdout, and exits with 2`, () => {
    const r = tool(args)
    assert.equal(r.err.trim(), ERROR)
    assert.equal(r.out, '')
    assert.equal(r.code, 2)
  })
}

test('without LOG_NOW an age counts back from the current time', () => {
  prints(['--since', '1m'], '', { now: null })
  prints(['--since', '36500d'], printed(), { now: null })
})

test('--help lists --since beside the options it had', () => {
  const r = tool(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /--since/)
  assert.match(r.out, /--level/)
})

test('--level alone prints what it printed before', () => {
  prints(['--level', 'ERROR'], printed({ level: 'ERROR' }))
})

test('with no options every line is printed as before', () => {
  prints([], printed())
})
