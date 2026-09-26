// Runs one case of dedupe() in a process of its own, so a slow answer can be killed at its time
// limit: node run.mjs <workspace> <case>. Prints one JSON line, { ok, why, ms }, where `ms` is the time
// the calls of dedupe() took, the setup of the case left out.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [workspace, which] = process.argv.slice(2)
const { dedupe } = await import(pathToFileURL(join(workspace, 'src', 'dedupe.js')).href)
const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
const show = (xs) => `[${xs.map((x) => (Object.is(x, -0) ? '-0' : typeof x === 'object' && x ? `object ${x.n}` : typeof x === 'string' ? JSON.stringify(x) : String(x))).join(', ')}]`

const CASES = {
  numbers() {
    return [[[3, 1, 3, 2, 1, 2, 3], [3, 1, 2]], [[], []], [[5], [5]]]
  },
  nan() {
    return [[[NaN, 1, NaN, 2, NaN], [NaN, 1, 2]]]
  },
  zeros() {
    // The first of 0 and -0 is kept, whichever it is.
    return [[[0, -0, 0], [0]], [[-0, 0, 1, -0], [-0, 1]], [['0', 0, -0, '0'], ['0', 0]]]
  },
  objects() {
    const a = { n: 1 }
    const b = { n: 1 }
    return [[[a, b, a, b, a], [a, b]], [[a, 'a', a, null, undefined, null, undefined], [a, 'a', null, undefined]]]
  },
  large() {
    const list = Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 100_000)
    const seen = new Set()
    const expected = list.filter((x) => !seen.has(x) && seen.add(x))
    return [[list, expected]]
  },
}

let ms = 0
for (const [input, expected] of CASES[which]()) {
  const started = performance.now()
  const got = dedupe(input)
  ms += performance.now() - started
  if (!Array.isArray(got) || !same(got, expected)) {
    process.stdout.write(JSON.stringify({ ok: false, why: `dedupe(${input.length > 20 ? `${input.length} values` : show(input)}) gave ${Array.isArray(got) ? (got.length > 20 ? `${got.length} values` : show(got)) : String(got)}, not ${expected.length > 20 ? `${expected.length} values` : show(expected)}` }))
    process.exit(0)
  }
}
process.stdout.write(JSON.stringify({ ok: true, ms }))
