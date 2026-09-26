// Runs one case of createIndex() in a process of its own, so a slow answer can be killed at its
// time limit: node run.mjs <workspace> <case>. Prints one JSON line, { ok, why, ms }, where `ms` is
// the time of the timed case's index, the setup of the case left out.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [workspace, which] = process.argv.slice(2)
const { createIndex } = await import(pathToFileURL(join(workspace, 'src', 'search.js')).href)

const fail = (why) => { process.stdout.write(JSON.stringify({ ok: false, why })); process.exit(0) }
let ms = 0

if (which === 'small') {
  const text = "The cat's toy, the CAT and the cats: 'cat' (cat) cat! Don't stop. Route 66 or route 66b? A1 a1 x-ray X-RAY café caf. o'cat"
  const index = createIndex(text)
  const expected = {
    cat: 3, CAT: 3, "cat's": 1, cats: 1, "'cat'": 1, the: 3, "don't": 1, dont: 0, '66': 1, '66b': 1, a1: 2, x: 2, ray: 2, 'x-ray': 0,
    caf: 2, "o'cat": 1, missing: 0, '': 0, ' cat': 0, 'cat!': 0, '.': 0,
  }
  for (const [word, n] of Object.entries(expected)) {
    const got = index.count(word)
    if (got !== n) fail(`count(${JSON.stringify(word)}) gave ${got}, not ${n}`)
  }
  for (const odd of [undefined, null, 7]) {
    const got = index.count(odd)
    if (got !== 0) fail(`count(${String(odd)}) gave ${got}, not 0`)
  }
} else if (which === 'separate') {
  const a = createIndex('red red blue')
  const b = createIndex('blue green')
  if (a.count('red') !== 2 || b.count('red') !== 0 || b.count('blue') !== 1 || a.count('green') !== 0) fail('two indexes over two texts answered for each other')
} else if (which === 'large') {
  // About 2 MB of words from a fixed list, in a fixed order, counted as they are written, and
  // 20,000 calls about it. The time is the index's: building it and answering every call.
  let seed = 1
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const vocabulary = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}${i % 7 === 0 ? "'s" : ''}`)
  const counts = new Map()
  const parts = []
  let size = 0
  while (size < 2_000_000) {
    const w = vocabulary[Math.floor(random() * vocabulary.length)]
    const r = random()
    const word = r < 0.1 ? w.toUpperCase() : w
    const sep = r < 0.05 ? '. ' : r > 0.95 ? ', ' : ' '
    parts.push(word, sep)
    counts.set(w, (counts.get(w) ?? 0) + 1)
    size += word.length + sep.length
  }
  const text = parts.join('')
  const queries = Array.from({ length: 20_000 }, (_, i) => (i % 10 === 9 ? `absent${i}` : vocabulary[Math.floor(random() * vocabulary.length)]))
  const asked = queries.map((q, i) => (i % 3 === 0 ? q.toUpperCase() : q))
  const answers = new Array(asked.length)
  const started = performance.now()
  const index = createIndex(text)
  for (let i = 0; i < asked.length; i++) answers[i] = index.count(asked[i])
  ms = performance.now() - started
  for (const [i, q] of queries.entries()) {
    if (answers[i] !== (counts.get(q) ?? 0)) fail(`count(${JSON.stringify(asked[i])}) gave ${answers[i]}, not ${counts.get(q) ?? 0}`)
  }
}
process.stdout.write(JSON.stringify({ ok: true, ms }))
