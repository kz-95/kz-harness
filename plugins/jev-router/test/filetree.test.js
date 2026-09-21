// Left sidebar file tree: the pure parts. The DOM injection and the live render need a browser
// and are checked against the running app; the ordering, path joining, address building, the
// failure wording and the row cap are all DOM free, so they are covered here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// client.js is a classic browser script (see togglehints.test.js), so run its real body as a
// function of `window`, hand its factory a fake `react`, and read `__test`.
function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { fileTreeRows, orderTreeEntries, treeChildPath, fileAddressFor, treeFailureLine, fileTreeSearchLabels } = loadPlugin().__test

test('file tree: directories come first, then natural name order', () => {
  const entries = [
    { name: 'file10', type: 'file' },
    { name: 'zzz', type: 'directory' },
    { name: 'file2', type: 'file' },
    { name: 'aaa', type: 'directory' },
    { name: 'other', type: 'other' },
  ]
  assert.deepEqual(orderTreeEntries(entries).map((e) => e.name), ['aaa', 'zzz', 'file2', 'file10', 'other'])
  assert.deepEqual(orderTreeEntries(undefined), [])
})

test('file tree: a child path joins with one separator and drops trailing ones', () => {
  assert.equal(treeChildPath('C:\\Harness', 'src'), 'C:\\Harness/src')
  assert.equal(treeChildPath('C:/Harness/', 'src'), 'C:/Harness/src')
  assert.equal(treeChildPath('/a/b', 'c'), '/a/b/c')
})

test('file tree: the resource address is workspace-relative inside the root, absolute outside', () => {
  assert.equal(fileAddressFor('s1', 'C:/Harness', 'C:/Harness/src/a.ts'), 'dsh-resource://file/session/s1/src/a.ts')
  assert.equal(fileAddressFor('s1', 'C:/Harness', 'C:/Harness'), 'dsh-resource://file/session/s1/')
  assert.equal(fileAddressFor('s1', 'C:/Harness', 'D:/other/a.ts'), 'dsh-resource://file/session/s1/D:/other/a.ts')
  assert.equal(fileAddressFor('s1', undefined, 'relative/a.ts'), 'dsh-resource://file/session/s1/relative/a.ts')
  // Backslashes normalize, the colon of a drive stays literal, and other segments encode.
  assert.equal(fileAddressFor('s 1', 'C:\\Harness', 'C:\\Harness\\a b\\c.ts'), 'dsh-resource://file/session/s%201/a%20b/c.ts')
})

test('file tree: every shipped listing failure has honest words', () => {
  assert.match(treeFailureLine({ code: 'workspace-file/not-found' }), /gone/)
  assert.match(treeFailureLine({ code: 'workspace-file/outside-workspace' }), /outside the workspace/)
  assert.match(treeFailureLine({ code: 'workspace-file/not-directory' }), /not a directory/)
  assert.equal(treeFailureLine({ code: 'whatever', message: 'boom' }), 'Read failed: boom')
  assert.equal(treeFailureLine(undefined), 'Read failed: unknown error')
})

test('file tree: the search anchor labels cover both shipped languages', () => {
  assert.deepEqual([...fileTreeSearchLabels], ['Search sessions', '搜索会话'])
})

test('file tree: a loading root is one honest loading row', () => {
  const { rows } = fileTreeRows('C:/w', { 'C:/w': { status: 'loading' } }, ['C:/w'], 400)
  assert.deepEqual(rows.map((r) => r.note), ['loading'])
  assert.equal(rows[0].depth, 0)
})

test('file tree: ready levels render entries in order, and expanded directories recurse', () => {
  const levels = {
    'C:/w': { status: 'ready', entries: [{ name: 'b.ts', type: 'file' }, { name: 'src', type: 'directory' }] },
    'C:/w/src': { status: 'ready', entries: [{ name: 'a.ts', type: 'file' }] },
  }
  const closed = fileTreeRows('C:/w', levels, ['C:/w'], 400).rows
  assert.deepEqual(closed.map((r) => [r.kind, r.name]), [['directory', 'src'], ['file', 'b.ts']])
  assert.deepEqual(closed.map((r) => r.depth), [0, 0])
  const open = fileTreeRows('C:/w', levels, ['C:/w', 'C:/w/src'], 400).rows
  assert.deepEqual(open.map((r) => [r.kind, r.name, r.depth]), [['directory', 'src', 0], ['file', 'a.ts', 1], ['file', 'b.ts', 0]])
})

test('file tree: empty, failed and truncated levels each say so', () => {
  const empty = fileTreeRows('C:/w', { 'C:/w': { status: 'ready', entries: [] } }, ['C:/w'], 400).rows
  assert.deepEqual(empty.map((r) => r.note), ['empty'])
  const failed = fileTreeRows('C:/w', { 'C:/w': { status: 'error', message: 'Read failed: boom' } }, ['C:/w'], 400).rows
  assert.deepEqual(failed.map((r) => r.note), ['Read failed: boom'])
  const truncated = fileTreeRows('C:/w', { 'C:/w': { status: 'ready', entries: [{ name: 'a', type: 'file' }], truncated: true } }, ['C:/w'], 400).rows
  assert.deepEqual(truncated.map((r) => r.note ?? r.name), ['a', 'truncated'])
})

test('file tree: a level that is neither loaded nor expanded is never listed', () => {
  const levels = { 'C:/w': { status: 'ready', entries: [{ name: 'src', type: 'directory' }] } }
  const { rows } = fileTreeRows('C:/w', levels, ['C:/w'], 400)
  assert.deepEqual(rows.map((r) => r.name), ['src'])
})

test('file tree: the row cap stops a huge folder and says so', () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, type: 'file' }))
  const { rows, capped } = fileTreeRows('C:/w', { 'C:/w': { status: 'ready', entries } }, ['C:/w'], 50)
  assert.equal(capped, true)
  assert.equal(rows.at(-1).note, 'capped')
  assert.equal(rows.filter((r) => r.kind === 'file').length, 50, 'no more than the cap of entries is drawn')
  assert.ok(rows.length <= 51, 'only the capped note may follow the cap')
  const small = fileTreeRows('C:/w', { 'C:/w': { status: 'ready', entries: [{ name: 'a', type: 'file' }] } }, ['C:/w'], 50)
  assert.equal(small.capped, false)
})
