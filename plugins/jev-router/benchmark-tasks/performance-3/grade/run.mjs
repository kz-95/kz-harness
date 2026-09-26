// Runs countPaths() on one grid in a process of its own, so a slow answer can be killed at its
// time limit: node run.mjs <workspace> <case>. Prints one JSON line, { ok, why, ms }, where `ms` is
// the time countPaths() took.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [workspace, which] = process.argv.slice(2)
const { countPaths } = await import(pathToFileURL(join(workspace, 'src', 'paths.js')).href)

/** A grid of `rows` by `cols`, blocked where `blocked(r, c)` says. */
const grid = (rows, cols, blocked = () => false) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (blocked(r, c) ? '#' : '.')).join(''))
/** n choose k, exactly. */
function choose(n, k) {
  let x = 1n
  for (let i = 1n; i <= BigInt(k); i++) x = (x * (BigInt(n) - BigInt(k) + i)) / i
  return x
}
// The answers, worked out here the slow-but-sure way for the small grids and by the closed form
// or a table for the large ones.
function table(g) {
  const cols = g[0].length
  let row = new Array(cols).fill(0n)
  g.forEach((line, r) => {
    const next = new Array(cols).fill(0n)
    for (let c = 0; c < cols; c++) {
      if (line[c] === '#') continue
      next[c] = r === 0 && c === 0 ? 1n : row[c] + (c > 0 ? next[c - 1] : 0n)
    }
    row = next
  })
  return row[cols - 1]
}

const CASES = {
  'blocked-start': [['#..', '...', '...'], 0n],
  'one-cell': [['.'], 1n],
  'blocked-end': [['..', '.#'], 0n],
  'small-obstacles': (() => { const g = ['....', '.#..', '...#', '#...']; return [g, table(g)] })(),
  'wall-with-a-gap': (() => { const g = grid(24, 30, (r, c) => c === 15 && r !== 11); return [g, table(g)] })(),
  'scattered-20': (() => { const g = grid(20, 20, (r, c) => (r * 7 + c * 13) % 11 === 0 && (r + c) % 38 !== 0); return [g, table(g)] })(),
  'open-60': [grid(60, 60), choose(118, 59)],
  'dotted-60': (() => { const g = grid(60, 60, (r, c) => r % 5 === 2 && c % 5 === 3); return [g, table(g)] })(),
}

const [g, expected] = CASES[which]
const started = performance.now()
const got = countPaths(g)
const ms = performance.now() - started
if (got !== expected) {
  process.stdout.write(JSON.stringify({ ok: false, why: `${g.length} by ${g[0].length}: gave ${typeof got === 'bigint' ? `${got}n` : `${String(got)} (${typeof got})`}, not ${expected}n` }))
} else process.stdout.write(JSON.stringify({ ok: true, ms }))
