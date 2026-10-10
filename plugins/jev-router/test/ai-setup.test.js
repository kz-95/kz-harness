// docs/AI_SETUP.md is written for a coding agent that sets up or diagnoses KzH on the owner's PC,
// and it lists every route of the plugin's HTTP handler with what it takes and what it answers.
// These tests keep it in step with index.js: every path index.js serves under /jev-router must have
// a row in the doc's route tables, opened by `METHOD /path` wherever index.js says the method (a
// route named only in a sentence has no row saying what it takes), and the doc must name no route
// index.js does not serve. The routes are read from index.js line by line, as a grep reads them:
// each `url.pathname === '...'`, and under each `const op = url.pathname.slice('<prefix>'.length)`
// every `op === '...'`, `op !== '...'` and key of a map of ops (Laya's install jobs). A path's method
// is the one `req.method === '...'` on its own line, else the one of the `if` block it sits in, or of
// the `if (req.method !== '...') return` above it. What a line opens lasts while the lines below it
// are indented deeper than the `if`, or as deep as the `const op` or the guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const DOC = new URL('../../../docs/AI_SETUP.md', import.meta.url)

/** The doc's text, or '' while there is none, so a missing doc fails as every route missing from it. */
function readDoc() {
  try { return readFileSync(DOC, 'utf8') } catch (err) { if (err.code === 'ENOENT') return ''; throw err }
}

const indent = (line) => line.length - line.trimStart().length

/**
 * The routes `source` serves: `paths`, every path under /jev-router it answers on, and `pairs`,
 * `METHOD /path` for each path whose method the source says.
 */
function routesOf(source) {
  const paths = new Set()
  const pairs = new Set()
  const open = [] // what a line sits in, innermost last: a sub-router { prefix, depth } or a method { method, depth }
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    while (open.length && indent(line) < open.at(-1).depth) open.pop()
    const sub = /const op = url\.pathname\.slice\('([^']+)'\.length\)/.exec(line)
    if (sub) { open.push({ prefix: sub[1], depth: indent(line) }); continue }
    const found = [...line.matchAll(/url\.pathname === '(\/jev-router[^']*)'/g)].map((m) => m[1])
    const prefix = open.findLast((o) => o.prefix)?.prefix
    if (prefix) {
      for (const m of line.matchAll(/\bop [!=]== '([^']*)'/g)) found.push(prefix + m[1])
      const key = /^\s*'([^']+)':\s*(?:async\s*)?\(/.exec(line)
      if (key) found.push(prefix + key[1])
    }
    const methods = [...new Set([...line.matchAll(/req\.method === '([A-Z]+)'/g)].map((m) => m[1]))]
    // Two methods on one line say nothing of either path's.
    const method = methods.length ? (methods.length === 1 ? methods[0] : null) : open.findLast((o) => o.method)?.method
    for (const path of found) {
      paths.add(path)
      if (method) pairs.add(`${method} ${path}`)
    }
    if (methods.length === 1 && /^\s*(?:\}\s*)?(?:else )?if \(.*\{\s*$/.test(line)) open.push({ method: methods[0], depth: indent(line) + 1 })
    const guard = /if \(req\.method !== '([A-Z]+)'\) return\b/.exec(line)
    if (guard) open.push({ method: guard[1], depth: indent(line) })
  }
  return { paths, pairs }
}

/**
 * The routes `text` gives a table row of their own: each `METHOD /path` that is a row's whole first
 * cell, a query after the path aside, so a route named in a sentence or a symptom is not among them.
 */
const rowsOf = (text) => new Set([...text.matchAll(/^\| `((?:GET|POST|PUT|PATCH|DELETE) \/jev-router[^`\s?]*)(?:\?[^`]*)?` \|/gm)].map((m) => m[1]))

test('docs/AI_SETUP.md has a row for every route index.js serves, with its method', () => {
  const { paths, pairs } = routesOf(SOURCE)
  // index.js is read as its handler is written today, and each of these is found by another of the
  // ways above: a route taken out on purpose comes off this list.
  assert.ok(paths.has('/jev-router/keys/activate'), 'the reading of index.js finds a path whose method it cannot tell')
  for (const pair of [
    'GET /jev-router/setup', 'DELETE /jev-router/keys', 'POST /jev-router/logout', 'POST /jev-router/tasks/steer',
    'GET /jev-router/benchmark', 'POST /jev-router/benchmark/plan', 'GET /jev-router/laya', 'GET /jev-router/laya/log',
    'POST /jev-router/laya/remove', 'POST /jev-router/laya/weights/apply', 'POST /jev-router/local/benchmark/cancel',
  ]) {
    assert.ok(pairs.has(pair), `the reading of index.js finds ${pair}`)
  }
  // The ground rules name the routes that download, delete or rate, and the symptoms table names routes to read: neither is a row.
  assert.equal(rowsOf('Ask first (`POST /jev-router/laya/install`).\n| `GET /jev-router/setup` shows `loggedIn: false` | Sign in. |').size, 0, 'a route named in a sentence or a symptom is not its row')
  const rows = rowsOf(readDoc())
  const rowPaths = new Set([...rows].map((row) => row.slice(row.indexOf(' ') + 1)))
  assert.deepEqual([...paths].filter((path) => !rowPaths.has(path)), [], 'every path index.js serves has a row in docs/AI_SETUP.md')
  assert.deepEqual([...pairs].filter((pair) => !rows.has(pair)), [], 'each as `METHOD /path` wherever index.js says its method')
})

test('docs/AI_SETUP.md names no route that index.js does not serve', () => {
  const { paths } = routesOf(SOURCE)
  const listed = [...readDoc().matchAll(/`(?:GET|POST|PUT|PATCH|DELETE) (\/jev-router[^`\s?]*)/g)].map((m) => m[1])
  assert.ok(listed.length > 0, 'docs/AI_SETUP.md lists the routes as `METHOD /path`')
  assert.deepEqual([...new Set(listed)].filter((path) => !paths.has(path)), [], 'every route the doc lists is one index.js serves')
})
