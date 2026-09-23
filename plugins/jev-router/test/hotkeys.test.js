// Shortcuts page storage shape, and where the Terminal button may open a terminal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validHotkeys, workspaceDir } from '../index.js'

test('hotkeys: keeps valid bindings and ratio, rejects anything else', () => {
  const ok = { bindings: { 'left-sidebar': 'Ctrl+B', terminal: 'Ctrl+`', files: 'Ctrl+Alt+E', usage: '' }, rightbarRatio: 20 }
  assert.deepEqual(validHotkeys(ok), ok)
  assert.deepEqual(validHotkeys({}), { bindings: {} })
  for (const bad of [null, [], { bindings: [] }, { bindings: { x: 'Ctrl+b' } }, { bindings: { x: 'Shift+Ctrl+B' } }, { bindings: { x: 'Ctrl+' } },
    { bindings: { X: 'Ctrl+B' } }, { bindings: { x: 5 } }, { rightbarRatio: 60 }, { rightbarRatio: 14 }, { rightbarRatio: 20.5 }]) {
    assert.throws(() => validHotkeys(bad), undefined, JSON.stringify(bad))
  }
})

test('terminal: only an existing DSH project folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-term-'))
  const file = join(dir, 'f.txt')
  writeFileSync(file, '')
  // The case-insensitive match is a Windows fact; on a case-sensitive file system the
  // upper-cased folder does not exist, so the same assertion is made with the real name.
  const spelled = process.platform === 'win32' ? dir.toUpperCase() : dir
  assert.equal(await workspaceDir(spelled, [dir]), join(spelled))
  await assert.rejects(workspaceDir(dir, []), /not a harness project/)
  await assert.rejects(workspaceDir(file, [file]), /does not exist/)
  await assert.rejects(workspaceDir(join(dir, 'gone'), [join(dir, 'gone')]), /does not exist/)
  await assert.rejects(workspaceDir(undefined, [dir]), /cwd/)
})

test('writes need a JSON content type (cross-site forms are refused)', async () => {
  const { isJsonRequest } = await import('../index.js')
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), false)
  assert.equal(isJsonRequest({ headers: {} }), false)
})
