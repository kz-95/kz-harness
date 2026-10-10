// Whether the engine patch is in the Claude Code and Codex connectors (engine-patches.js,
// docs/live-agent-view.md Feature 1, slice 5): read from each installed file's marker, the reason it is
// off from the status file scripts/patch-agent-live.mjs writes, kept for a minute, and off whenever
// a file cannot be read.
import { patchKeyOf, patchState, readPatchState, connectorFile, PATCH_TTL_MS } from '../engine-patches.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const made = []
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const MARKER = '/* KZH_AGENT_LIVE 2: patched by Kz-harness scripts/patch-agent-live.mjs */'

/** An engine home whose web profile has the connectors `files` gives, by provider family, as their text. */
function home(files = {}, status = null) {
  const dshHome = mkdtempSync(join(tmpdir(), 'kz-engine-patches-'))
  made.push(dshHome)
  for (const [key, text] of Object.entries(files)) {
    mkdirSync(dirname(connectorFile(dshHome, key)), { recursive: true })
    writeFileSync(connectorFile(dshHome, key), text)
  }
  if (status) writeFileSync(join(dshHome, 'kzh-engine-patches.json'), JSON.stringify(status))
  return dshHome
}

test('each connector is on when it carries the marker, and off when it does not, apart from the other', () => {
  const dshHome = home({ 'claude-code': `var a = 1;\n${MARKER}\nvar b = 2;\n`, codex: 'var c = 3;\n' })
  assert.deepEqual(readPatchState({ dshHome }), {
    'claude-code': { on: true, why: null },
    codex: { on: false, why: 'the engine patch has not run on it yet; Start-KzH runs it at each start' },
  })
  assert.deepEqual(readPatchState({ dshHome: home({ codex: `x\n${MARKER.replace('LIVE 2', 'LIVE 1')}\n` }) }).codex, { on: false, why: 'its connector carries version 1 of the engine patch, and this plugin speaks version 2' }, 'a marker of another version is not this one')
  assert.equal(connectorFile('/dsh', 'codex'), join('/dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-subagent-codex', 'lib', 'index.js'))
  assert.deepEqual(['claude-code', 'claude-code-readonly', 'codex', 'spawn', undefined].map(patchKeyOf), ['claude-code', 'claude-code', 'codex', null, null], 'both Claude Code rows run on its one connector')
})

test('an unpatched connector is off for the reason the patch recorded, or because it was installed again after the patch ran', () => {
  const reason = 'dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2'
  const dshHome = home({ 'claude-code': 'var a = 1;\n', codex: 'var c = 3;\n' }, { writtenFor: '0.1.5-rc.2', 'claude-code': { result: 'patched', reason: null }, codex: { result: 'refused', reason } })
  assert.deepEqual(readPatchState({ dshHome }), {
    'claude-code': { on: false, why: 'its connector was installed again after the patch ran; the next start of the harness patches it again' },
    codex: { on: false, why: reason },
  })
})

test('a connector an engine update installed again at a new version says it stays off until KzH is updated for it, not until the next start', () => {
  const status = { writtenFor: '0.1.5-rc.2', 'claude-code': { result: 'applied', reason: null }, codex: { result: 'patched', reason: null } }
  const dshHome = home({ 'claude-code': 'var a = 1;\n', codex: 'var c = 3;\n' }, status)
  writeFileSync(join(dirname(dirname(connectorFile(dshHome, 'claude-code'))), 'package.json'), JSON.stringify({ version: '0.1.6' }))
  writeFileSync(join(dirname(dirname(connectorFile(dshHome, 'codex'))), 'package.json'), JSON.stringify({ version: '0.1.5-rc.2' }))
  assert.deepEqual(readPatchState({ dshHome }), {
    'claude-code': { on: false, why: 'its connector was installed again at version 0.1.6 after the patch ran, and the patch was written for 0.1.5-rc.2, so it stays off until KzH is updated for that version' },
    codex: { on: false, why: 'its connector was installed again after the patch ran; the next start of the harness patches it again' },
  }, 'the same version is patched again at the next start')
})

test('a connector that is missing or cannot be read is off, and so is one beside a status file that cannot be read', () => {
  const dshHome = home({ codex: `${MARKER}\n` })
  // A folder where the file should be: it cannot be read.
  mkdirSync(connectorFile(dshHome, 'claude-code'), { recursive: true })
  const state = readPatchState({ dshHome })
  assert.equal(state['claude-code'].on, false)
  assert.match(state['claude-code'].why, /^its connector could not be read \(EISDIR\)$/)
  assert.deepEqual(state.codex, { on: true, why: null })
  assert.deepEqual(readPatchState({ dshHome: home() }), { 'claude-code': { on: false, why: 'its connector is not installed' }, codex: { on: false, why: 'its connector is not installed' } })
  const garbled = home({ codex: 'x\n' })
  writeFileSync(join(garbled, 'kzh-engine-patches.json'), '{ not json')
  assert.equal(readPatchState({ dshHome: garbled }).codex.on, false)
})

test('a reading is kept for 60 s, then read again, and a cache of the caller\'s own starts afresh', () => {
  const dshHome = home({ 'claude-code': 'var a = 1;\n', codex: 'var c = 3;\n' })
  let t = 1_000_000
  const now = () => t
  const cache = new Map()
  assert.equal(PATCH_TTL_MS, 60_000)
  assert.equal(patchState({ dshHome, now, cache }).codex.on, false)
  writeFileSync(connectorFile(dshHome, 'codex'), `${MARKER}\n`)
  t += 59_999
  assert.equal(patchState({ dshHome, now, cache }).codex.on, false, 'still the reading of a minute ago')
  assert.equal(patchState({ dshHome, now, cache: new Map() }).codex.on, true, 'a cache of its own reads it now')
  t += 1
  assert.equal(patchState({ dshHome, now, cache }).codex.on, true, 'a minute on, read again')
})
