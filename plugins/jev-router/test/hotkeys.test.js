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
  assert.equal(await workspaceDir(dir.toUpperCase(), [dir]), join(dir.toUpperCase()))
  await assert.rejects(workspaceDir(dir, []), /not a DSH project/)
  await assert.rejects(workspaceDir(file, [file]), /does not exist/)
  await assert.rejects(workspaceDir(join(dir, 'gone'), [join(dir, 'gone')]), /does not exist/)
  await assert.rejects(workspaceDir(undefined, [dir]), /cwd/)
})
