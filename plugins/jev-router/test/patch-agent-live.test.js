// The engine patch for Claude Code and Codex (docs/live-agent-view.md Feature 1, slice 5:
// scripts/patch-agent-live.mjs), against the two connector files the harness pins, vendored in
// test/fixtures/connectors. First what it writes: every edit in place once, CRLF kept, a version or an
// anchor it was not written for refused file by file, its backup and its own upgrades, its order
// beside patch-codex-effort, and how it behaves as the launcher runs it. Then what the patched files
// do, run on stand-ins for the packages they import (test/fixtures/connectors/stubs): the tap sees
// each run's own messages and changes no run, a request without the plugin's fields runs as before,
// and the hooks for steering: Claude Code's input channel and Codex's turn/steer and Send now.
import * as patch from '../../../scripts/patch-agent-live.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { waitFor } from './wait-for.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'patch-agent-live.mjs')
const FIXTURES = fileURLToPath(new URL('./fixtures/connectors/', import.meta.url))
const PKGS = ['claude-code', 'codex']
const made = []
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const tmp = (name) => { const d = realpathSync(mkdtempSync(join(tmpdir(), name))); made.push(d); return d }

/**
 * An engine home with the web profile's two connectors as the harness installs them, from the
 * vendored files, and with `stubs` the packages they import beside them, so the patched files load.
 * `env` points the script at it, with an npx cache of its own that holds nothing.
 */
function profile({ stubs = false } = {}) {
  const home = tmp('kz-patch-home-')
  const modules = join(home, 'profiles', 'web', 'node_modules')
  for (const pkg of PKGS) cpSync(join(FIXTURES, patch.PACKAGES[pkg]), join(modules, '@deepseek-ai', patch.PACKAGES[pkg]), { recursive: true })
  if (stubs) cpSync(join(FIXTURES, 'stubs'), modules, { recursive: true })
  const cache = join(home, 'npm-cache')
  mkdirSync(cache)
  const dir = (pkg) => join(modules, '@deepseek-ai', patch.PACKAGES[pkg])
  return { home, modules, dir, file: (pkg) => join(dir(pkg), 'lib', 'index.js'), env: { ...process.env, DSH_HOME: home, npm_config_cache: cache } }
}
const read = (file) => readFileSync(file, 'utf8')
const pinned = (pkg) => read(join(FIXTURES, patch.PACKAGES[pkg], 'lib', 'index.js'))
const run = (env, script = SCRIPT) => spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
const ADDED = 'patch-agent-live: live view and steering hooks added to Claude Code and Codex'

test('every edit is in place once, the marker with it, and a second run writes nothing and says applied', () => {
  const p = profile()
  const first = patch.patchAll(p.env)
  assert.deepEqual(first.lines, [ADDED])
  for (const pkg of PKGS) {
    assert.equal(first.status[pkg].result, 'patched', pkg)
    const out = read(p.file(pkg))
    for (const e of patch.EDITS[pkg]) assert.equal(out.split(e.to).length, 2, `${pkg} ${e.id} is in place once`)
    assert.equal(out.split(patch.MARKER).length, 2, `${pkg} is marked once`)
  }
  assert.deepEqual(patch.EDITS['claude-code'].map((e) => e.id).sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'])
  assert.deepEqual(patch.EDITS.codex.map((e) => e.id).sort(), ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'])
  const before = PKGS.map((pkg) => read(p.file(pkg)))
  const second = patch.patchAll(p.env)
  assert.deepEqual(second.lines, [], 'nothing is said when it is already applied')
  assert.deepEqual(PKGS.map((pkg) => second.status[pkg].result), ['applied', 'applied'])
  assert.deepEqual(PKGS.map((pkg) => read(p.file(pkg))), before, 'a second run leaves both files byte for byte')
  const saved = JSON.parse(read(join(p.home, 'kzh-engine-patches.json')))
  assert.equal(saved.writtenFor, patch.WRITTEN_FOR)
  assert.deepEqual(PKGS.map((pkg) => [saved[pkg].result, saved[pkg].version, saved[pkg].file]), PKGS.map((pkg) => ['applied', '0.1.5-rc.2', p.file(pkg)]))
})

test('a connector with Windows line ends is patched with Windows line ends throughout', () => {
  const p = profile()
  for (const pkg of PKGS) writeFileSync(p.file(pkg), pinned(pkg).replace(/\n/g, '\r\n'))
  patch.patchAll(p.env)
  for (const pkg of PKGS) {
    const out = read(p.file(pkg))
    assert.ok(out.includes(patch.MARKER), `${pkg} is patched`)
    assert.equal(/(?<!\r)\n/.test(out), false, `${pkg}: no bare line end`)
    for (const e of patch.EDITS[pkg]) assert.ok(out.includes(e.to.replace(/\n/g, '\r\n')), `${pkg} ${e.id} with CRLF`)
  }
})

test('an engine version it was not written for leaves that connector as it was, and the status file names both versions', () => {
  const p = profile()
  const manifest = join(p.dir('codex'), 'package.json')
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(read(manifest)), version: '0.1.6' }))
  const { status, lines } = patch.patchAll(p.env)
  assert.equal(read(p.file('codex')), pinned('codex'), 'the Codex connector is untouched')
  assert.equal(existsSync(`${p.file('codex')}.kzh-backup`), false, 'and no backup is written for it')
  assert.equal(status.codex.result, 'refused')
  const saved = JSON.parse(read(join(p.home, 'kzh-engine-patches.json')))
  assert.match(saved.codex.reason, /0\.1\.6/)
  assert.match(saved.codex.reason, /0\.1\.5-rc\.2/)
  assert.equal(saved['claude-code'].result, 'patched', 'Claude Code is patched all the same')
  assert.deepEqual(lines, [
    'patch-agent-live: live view and steering hooks added to Claude Code',
    `patch-agent-live: NOT APPLIED to Codex: ${saved.codex.reason}. Its runs work as before; the Live tab says live detail is off.`,
  ])
})

test('an anchor that is missing, or found twice, leaves that connector as it was while the other is still patched', () => {
  const p = profile()
  const codex = pinned('codex').replace('\t\tconst status = terminal.status;', '\t\tconst status = terminal.state;')
  writeFileSync(p.file('codex'), codex)
  const first = patch.patchAll(p.env)
  assert.equal(read(p.file('codex')), codex, 'Codex is left as it was')
  assert.equal(first.status.codex.reason, 'anchor not found: X6 Send now continues the thread')
  assert.equal(first.status['claude-code'].result, 'patched')

  const q = profile()
  const claude = `${pinned('claude-code')}\n// a copy of an anchor\n\tconst publishedQuery = query$1;\n`
  writeFileSync(q.file('claude-code'), claude)
  const second = patch.patchAll(q.env)
  assert.equal(read(q.file('claude-code')), claude, 'Claude Code is left as it was')
  assert.equal(second.status['claude-code'].reason, 'anchor matched more than once: C6 published query')
  assert.equal(second.status.codex.result, 'patched')
})

test('the backup is taken again from each unpatched file it patches, so it holds the file installed now', () => {
  const p = profile()
  patch.patchAll(p.env)
  assert.equal(read(`${p.file('codex')}.kzh-backup`), pinned('codex'))
  // A reinstall of the same version puts an unpatched file back, here with another patch's line in it.
  const reinstalled = `${pinned('codex')}// another patch was here\n`
  writeFileSync(p.file('codex'), reinstalled)
  const { status } = patch.patchAll(p.env)
  assert.equal(status.codex.result, 'patched')
  assert.equal(read(`${p.file('codex')}.kzh-backup`), reinstalled, 'the backup is the file that was installed')
  assert.equal(JSON.parse(read(`${p.file('codex')}.kzh-backup.json`)).version, '0.1.5-rc.2')
  assert.ok(read(p.file('codex')).includes('// another patch was here'), 'and what was installed is what got patched')
})

test('a connector patched by another version of this patch is patched again from a backup of the same version, and refused without one', () => {
  const p = profile()
  patch.patchAll(p.env)
  const older = patch.MARKER.replace(/KZH_AGENT_LIVE \d+/, 'KZH_AGENT_LIVE 0')
  const v0 = patch.patchSource('codex', pinned('codex'), '0.1.5-rc.2', older)
  assert.equal(v0.ok, true)
  writeFileSync(p.file('codex'), v0.out)
  const upgrade = patch.patchAll(p.env)
  assert.equal(upgrade.status.codex.result, 'upgraded')
  assert.equal(read(p.file('codex')), patch.patchSource('codex', pinned('codex'), '0.1.5-rc.2').out, 'patched again from the backup')
  assert.deepEqual(upgrade.lines, ['patch-agent-live: live view and steering hooks added to Codex'])
  assert.equal(read(`${p.file('codex')}.kzh-backup`), pinned('codex'), 'the backup still holds the file as installed, not the one version 0 patched')

  // A backup of another package version is no file to start again from.
  writeFileSync(p.file('codex'), v0.out)
  writeFileSync(`${p.file('codex')}.kzh-backup.json`, JSON.stringify({ version: '0.1.4' }))
  const refused = patch.patchAll(p.env)
  assert.equal(refused.status.codex.result, 'refused')
  assert.match(refused.status.codex.reason, /version 0 of this patch/)
  assert.equal(read(p.file('codex')), v0.out, 'left as it was')
  rmSync(`${p.file('codex')}.kzh-backup`)
  assert.equal(patch.patchAll(p.env).status.codex.result, 'refused', 'and so is one with no backup at all')
})

test('each connector is patched in every engine folder it is installed in, the web profile first, then the other profiles and the npx cache; its status is the web profile\'s copy, which the Live tab reads, and a copy refused elsewhere is said on a line of its own', () => {
  const p = profile()
  const web = join(p.modules, '@deepseek-ai')
  const at = (name) => join(p.home, 'profiles', name, 'node_modules', '@deepseek-ai')
  const npx = join(p.env.npm_config_cache, '_npx', 'abc', 'node_modules', '@deepseek-ai')
  for (const root of [at('beta'), at('alpha'), npx]) for (const pkg of PKGS) cpSync(join(FIXTURES, patch.PACKAGES[pkg]), join(root, patch.PACKAGES[pkg]), { recursive: true })
  assert.deepEqual(patch.roots(p.env), [web, at('alpha'), at('beta'), npx], 'the web profile before the others, which go by name, and the npx cache last')
  const first = patch.patchAll(p.env)
  for (const root of [web, at('alpha'), at('beta'), npx]) for (const pkg of PKGS) assert.ok(read(join(root, patch.PACKAGES[pkg], 'lib', 'index.js')).includes(patch.MARKER), `${pkg} in ${root}`)
  assert.deepEqual([first.status.codex.result, first.status.codex.file], ['patched', p.file('codex')], 'the web profile\'s copy stands for the package')
  // The other profile's Codex is put back unpatched at a version the patch was not written for.
  const other = join(at('alpha'), patch.PACKAGES.codex)
  writeFileSync(join(other, 'lib', 'index.js'), pinned('codex'))
  writeFileSync(join(other, 'package.json'), JSON.stringify({ ...JSON.parse(read(join(other, 'package.json'))), version: '0.1.6' }))
  const second = patch.patchAll(p.env)
  assert.deepEqual([second.status.codex.result, second.status.codex.file], ['applied', p.file('codex')], 'the copy the Live tab reads still stands for the package, which is not said to be off')
  assert.deepEqual(second.lines, [`patch-agent-live: NOT APPLIED to Codex at ${join(other, 'lib', 'index.js')}: dsh-subagent-codex 0.1.6 is installed, and this patch was written for ${patch.WRITTEN_FOR}. That copy works as before; the Live tab reads the web profile's.`])
  assert.deepEqual([second.status['claude-code'].result, read(join(other, 'lib', 'index.js'))], ['applied', pinned('codex')])
  // With no copy in the web profile, the first copy refused stands for the package, so the reason is said.
  rmSync(join(web, patch.PACKAGES.codex), { recursive: true })
  const third = patch.patchAll(p.env)
  assert.deepEqual([third.status.codex.result, third.status.codex.file, third.status.codex.version], ['refused', join(other, 'lib', 'index.js'), '0.1.6'])
  assert.deepEqual(third.lines, [`patch-agent-live: NOT APPLIED to Codex: ${third.status.codex.reason}. Its runs work as before; the Live tab says live detail is off.`])
  assert.match(third.status.codex.reason, /0\.1\.6/)
})

test('a status file that cannot be written is said on stdout, and the connectors are patched all the same', () => {
  const p = profile()
  mkdirSync(join(p.home, 'kzh-engine-patches.json'))
  const r = run(p.env)
  assert.deepEqual([r.status, r.stderr], [0, ''])
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines[0], ADDED)
  assert.match(lines.at(-1), /^patch-agent-live: could not save .+kzh-engine-patches\.json \(E[A-Z]+\), so the Live tab cannot say why live detail is off\.$/)
  for (const pkg of PKGS) assert.ok(read(p.file(pkg)).includes(patch.MARKER), pkg)
})

test('a connector that cannot be written whole is left byte for byte as it was and refused, and a patch that lands leaves nothing beside it', () => {
  const p = profile()
  // Where the patched file is written first, a folder: the write fails before the connector is touched.
  mkdirSync(`${p.file('codex')}.kzh-tmp`)
  const { status } = patch.patchAll(p.env)
  assert.deepEqual([status.codex.result, read(p.file('codex'))], ['refused', pinned('codex')])
  assert.match(status.codex.reason, /^it could not be patched \(/)
  assert.deepEqual([status['claude-code'].result, existsSync(`${p.file('claude-code')}.kzh-tmp`)], ['patched', false])
})

test('beside patch-codex-effort, run before it or after it, turn/start carries threadId, the effort lines, the run\'s own extras, then the input', () => {
  for (const order of ['effort first', 'effort after']) {
    const p = profile()
    const effort = () => execFileSync(process.execPath, [join(REPO, 'scripts', 'patch-codex-effort.mjs')], { env: p.env, encoding: 'utf8' })
    if (order === 'effort first') { assert.match(effort(), /applied/); patch.patchAll(p.env) } else { patch.patchAll(p.env); assert.match(effort(), /applied/, 'patch-codex-effort still sees a file it has not patched') }
    const lines = read(p.file('codex')).split('\n')
    const at = lines.findIndex((l) => l.includes('this.transport.request("turn/start", {'))
    const turn = lines.slice(at + 1, at + 7).map((l) => l.trim())
    assert.deepEqual(turn.map((l) => l.slice(0, 32)), [
      'threadId,',
      '// Kz-harness patch: per-run eff',
      '...process.env.KZ_CODEX_EFFORT ?',
      '...process.env.KZ_CODEX_SERVICE_',
      '...this.kzhTurnExtras,',
      'input: texts.map((text) => ({',
    ], order)
  }
})

test('node --check passes on both patched files', () => {
  const p = profile()
  patch.patchAll(p.env)
  for (const pkg of PKGS) assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', p.file(pkg)]), pkg)
})

test('run as the launcher runs it: stdout only, nothing on stderr, and exit 0 on every path, a thrown error included', () => {
  const fresh = profile()
  const patched = run(fresh.env)
  assert.deepEqual([patched.status, patched.stderr, patched.stdout], [0, '', `${ADDED}\n`])
  const again = run(fresh.env)
  assert.deepEqual([again.status, again.stderr, again.stdout], [0, '', ''], 'nothing when already applied')

  const old = profile()
  const manifest = join(old.dir('claude-code'), 'package.json')
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(read(manifest)), version: '0.1.4' }))
  const refused = run(old.env)
  assert.equal(refused.status, 0)
  assert.equal(refused.stderr, '')
  assert.match(refused.stdout, /^patch-agent-live: NOT APPLIED to Claude Code: dsh-subagent-claude-code 0\.1\.4 is installed, and this patch was written for 0\.1\.5-rc\.2\. Its runs work as before; the Live tab says live detail is off\.$/m)

  const empty = tmp('kz-patch-empty-')
  const none = run({ ...fresh.env, DSH_HOME: empty })
  assert.deepEqual([none.status, none.stderr], [0, ''])
  assert.match(none.stdout, /NOT APPLIED to Claude Code: it is not installed/)
  assert.match(none.stdout, /NOT APPLIED to Codex: it is not installed/)

  // A connector it cannot even read is refused with the reason, and the other is still patched.
  const broken = profile()
  rmSync(broken.file('codex'))
  mkdirSync(broken.file('codex'))
  const unread = run(broken.env)
  assert.deepEqual([unread.status, unread.stderr], [0, ''])
  assert.match(unread.stdout, /^patch-agent-live: live view and steering hooks added to Claude Code\npatch-agent-live: NOT APPLIED to Codex: it could not be patched \(EISDIR.*\)\. Its runs work as before; the Live tab says live detail is off\.\n$/)

  // An engine home it cannot even list throws: the error is said on stdout, and the launcher goes on.
  const odd = tmp('kz-patch-odd-')
  writeFileSync(join(odd, 'profiles'), 'not a folder')
  const threw = run({ ...fresh.env, DSH_HOME: odd })
  assert.deepEqual([threw.status, threw.stderr], [0, ''])
  assert.match(threw.stdout, /^patch-agent-live: NOT APPLIED: ENOTDIR.*\. Claude Code and Codex runs work as before; the Live tab says live detail is off\.\n$/)
})

test('the script runs when it is reached through a linked folder, as a harness behind a junction is', () => {
  const p = profile()
  const link = join(tmp('kz-patch-link-'), 'scripts')
  symlinkSync(join(REPO, 'scripts'), link, 'junction')
  const res = run(p.env, join(link, 'patch-agent-live.mjs'))
  assert.deepEqual([res.status, res.stderr, res.stdout], [0, '', `${ADDED}\n`])
  assert.ok(read(p.file('codex')).includes(patch.MARKER))
})

// ---- the patched connectors at work ----------------------------------------------------------------

let world = null
/**
 * Both connectors patched in an engine home of their own and loaded, each registered on a host that
 * records what it spawns: `claude` and `codex` start runs, `sdk` is the stand-in Agent SDK they
 * call, and `plain` is the Claude Code connector as it ships, for what a patched one must not change.
 */
async function connectors() {
  if (world) return world
  const p = profile({ stubs: true })
  // Beside patch-codex-effort, run first as the launcher runs it, so turn/start reads the variables as on the PC.
  execFileSync(process.execPath, [join(REPO, 'scripts', 'patch-codex-effort.mjs')], { env: p.env, encoding: 'utf8' })
  patch.patchAll(p.env)
  const plainHome = profile({ stubs: true })
  const load = (file) => import(pathToFileURL(file).href)
  const [claude, codex, sdk, plain, plainSdk] = await Promise.all([
    load(p.file('claude-code')), load(p.file('codex')),
    load(join(p.modules, '@anthropic-ai', 'claude-agent-sdk', 'index.js')),
    load(plainHome.file('claude-code')), load(join(plainHome.modules, '@anthropic-ai', 'claude-agent-sdk', 'index.js')),
  ])
  const cwd = tmp('kz-patch-cwd-')
  const host = (mod, config, onSpawn = () => {}) => {
    let provider
    mod.apply({ subagents: { registerProvider: (x) => { provider = x } }, subprocess: { spawn: (spec) => { const child = fakeChild(); onSpawn(child, spec); return child } }, logger: { warn() {} } }, { env: {}, disposeGraceMs: 1000, ...config })
    return (fields = {}) => provider.start({ prompt: [{ type: 'text', text: 'Fix the state file' }], parent: { session: { header: { cwd } } }, signal: new AbortController().signal, ...fields })
  }
  const servers = []
  world = {
    sdk, plainSdk, servers,
    claude: host(claude, { providerName: 'claude-code', permissionMode: 'dontAsk' }),
    plain: host(plain, { providerName: 'claude-code', permissionMode: 'dontAsk' }),
    codex: host(codex, { providerName: 'codex', permissionMode: 'never' }, (child) => servers.push(appServer(child, servers.length + 1))),
  }
  return world
}

/** A process as the engine's subprocess service hands it out: pipes, `done` once it exits, terminate() and waitForExit(). */
function fakeChild() {
  let exit
  const done = new Promise((resolve) => { exit = resolve })
  const child = {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), done,
    terminate() { exit({ exitCode: 0, signal: null }); child.stdout.end() },
    async waitForExit() { await done; return true },
  }
  return child
}

/**
 * A Codex app-server on a fake child's pipes, answering the connector as Codex 0.153 does: one thread
 * (`thr_<n>`), each turn/start answered and started (`turn_<k>`), turn/steer acknowledged, and
 * turn/interrupt ending the turn as interrupted. Every request is kept in `requests`. `onTurn(id)`
 * hears each turn start, `say` sends a notification of the thread, and `complete` ends a turn with a
 * final answer. `beforeTurn` notifications go out just before a turn/start is answered.
 */
function appServer(child, n) {
  const thread = `thr_${n}`
  const s = { thread, requests: [], turns: 0, current: null, onTurn: null, beforeTurn: [], onInterrupt: null }
  const write = (m) => child.stdout.write(`${JSON.stringify(m)}\n`)
  s.say = (method, params) => write({ method, params: { threadId: thread, ...params } })
  s.complete = (turnId, text = `Done (${thread}).`, status = 'completed') => {
    if (text) s.say('item/completed', { turnId, item: { type: 'agentMessage', id: `msg_${turnId}`, text, phase: 'final_answer' } })
    s.say('turn/completed', { turn: { id: turnId, status, items: [], error: null } })
  }
  let buf = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk) => {
    buf += chunk
    let at
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at)
      buf = buf.slice(at + 1)
      if (line.trim()) take(JSON.parse(line))
    }
  })
  function take(m) {
    if (m.id === undefined || m.method === undefined) return
    s.requests.push({ method: m.method, params: m.params })
    if (m.method === 'initialize') return write({ id: m.id, result: { userAgent: 'codex/0.153.4' } })
    if (m.method === 'thread/start') return write({ id: m.id, result: { thread: { id: thread, ephemeral: true }, model: 'gpt-5.4', reasoningEffort: 'high', sandbox: { type: 'workspaceWrite' } } })
    if (m.method === 'turn/start') {
      const id = `turn_${++s.turns}`
      for (const [method, params] of s.beforeTurn.splice(0)) s.say(method, params)
      s.current = id
      write({ id: m.id, result: { turn: { id, status: 'inProgress', items: [], error: null } } })
      s.say('turn/started', { turn: { id, status: 'inProgress', items: [], error: null } })
      s.onTurn?.(id, m.params)
      return
    }
    if (m.method === 'turn/steer') return write({ id: m.id, result: { turnId: m.params.expectedTurnId } })
    if (m.method === 'turn/interrupt') {
      write({ id: m.id, result: {} })
      if (s.onInterrupt) s.onInterrupt(m.params.turnId)
      else s.say('turn/completed', { turn: { id: m.params.turnId, status: 'interrupted', items: [], error: null } })
      return
    }
    write({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } })
  }
  return s
}

// What the Claude Code CLI streams, in the Agent SDK's shapes.
const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid, uuid: `${sid}-init`, model: 'claude-opus-4-1', apiKeySource: 'none', cwd: '/w', tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], claude_code_version: '2.1.0' })
const said = (sid, text) => ({ type: 'stream_event', session_id: sid, uuid: `${sid}-ev`, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const success = (sid, text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, uuid: `${sid}-result`, num_turns: 1, duration_ms: 5, duration_api_ms: 4, stop_reason: 'end_turn', total_cost_usd: 0.02, usage: {}, modelUsage: {}, permission_denials: [], ...extra })
const failure = (sid, extra = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['it broke'], session_id: sid, uuid: `${sid}-failed`, num_turns: 1, duration_ms: 5, duration_api_ms: 4, stop_reason: null, total_cost_usd: 0.02, usage: {}, modelUsage: {}, permission_denials: [], ...extra })
const textOf = (r) => r.output.map((b) => b.text).join('')
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A Claude Code run started on the patched connector: its SDK stand-in run, its handle, and the outcomes its control heard. */
async function claudeRun(fields = {}, { control = {} } = {}) {
  const w = await connectors()
  const outcomes = []
  const kzhControl = { ...control, onOutcome: (uuid, outcome) => outcomes.push([uuid, outcome]) }
  const handle = await w.claude({ kzhControl, ...fields })
  return { run: w.sdk.runs.at(-1), handle, control: kzhControl, outcomes }
}

test('Claude Code: the tap hears every message of its own run and none of another run beside it, and the answers are the runs\' own', async () => {
  const w = await connectors()
  const heard = { a: [], b: [] }
  const ha = await w.claude({ kzhTap: (f) => heard.a.push(f), kzhControl: {} })
  const ra = w.sdk.runs.at(-1)
  const hb = await w.claude({ kzhTap: (f) => heard.b.push(f), kzhControl: {} })
  const rb = w.sdk.runs.at(-1)
  const a = [init('a'), said('a', 'Looking'), success('a', 'Fixed A.')]
  const b = [init('b'), said('b', 'Reading'), said('b', ' more'), success('b', 'Fixed B.')]
  rb.say(b[0]); ra.say(a[0], a[1]); rb.say(b[1], b[2]); ra.say(a[2]); rb.say(b[3])
  ra.end(); rb.end()
  const [resA, resB] = await Promise.all([ha.result, hb.result])
  assert.deepEqual([textOf(resA), textOf(resB)], ['Fixed A.', 'Fixed B.'])
  assert.deepEqual(heard.a, a.map((message) => ({ provider: 'claude-code', message })))
  assert.deepEqual(heard.b, b.map((message) => ({ provider: 'claude-code', message })))
  assert.equal(heard.a[0].message, a[0], 'the very message the connector reads')
})

test('Claude Code: partial messages are asked for only by a tapped run, and a run without the plugin\'s fields gets the same string and options as the connector as it ships', async () => {
  const w = await connectors()
  const shape = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? 'a function' : v instanceof AbortController ? 'an AbortController' : v]))
  const runOf = async (start, sdk, fields) => { const h = await start(fields); const r = sdk.runs.at(-1); r.say(success('s', 'Done.')); r.end(); await h.result; return r }
  const tapped = await runOf(w.claude, w.sdk, { kzhTap: () => {} })
  assert.equal(tapped.options.includePartialMessages, true)
  const controlOnly = await runOf(w.claude, w.sdk, { kzhControl: {} })
  assert.equal('includePartialMessages' in controlOnly.options, false, 'not for a run that is not tapped')
  const bare = await runOf(w.claude, w.sdk, {})
  const shipped = await runOf(w.plain, w.plainSdk, {})
  assert.equal(bare.prompt, 'Fix the state file')
  assert.equal(bare.prompt, shipped.prompt)
  assert.deepEqual(shape(bare.options), shape(shipped.options))
  assert.deepEqual(Object.keys(bare.options), Object.keys(shipped.options))
})

test('Claude Code: fast mode goes to the SDK as flag settings, only for a run asked for with kzhControl while KZ_CLAUDE_FAST_MODE is 1 as it starts', async (t) => {
  const w = await connectors()
  const was = process.env.KZ_CLAUDE_FAST_MODE
  t.after(() => { if (was === undefined) delete process.env.KZ_CLAUDE_FAST_MODE; else process.env.KZ_CLAUDE_FAST_MODE = was })
  const runOf = async (fields) => { const h = await w.claude(fields); const r = w.sdk.runs.at(-1); r.say(success('s', 'Done.')); r.end(); await h.result; return r }
  process.env.KZ_CLAUDE_FAST_MODE = '1'
  const fast = await runOf({ kzhControl: {} })
  assert.deepEqual(fast.options.settings, { fastMode: true })
  assert.equal('includePartialMessages' in fast.options, false, 'fast mode asks for no partial messages of its own')
  const tapped = await runOf({ kzhTap: () => {}, kzhControl: {} })
  assert.deepEqual([tapped.options.settings, tapped.options.includePartialMessages], [{ fastMode: true }, true])
  assert.equal('settings' in (await runOf({ kzhTap: () => {} })).options, false, 'not for a run without the control')
  assert.equal('settings' in (await runOf({})).options, false, 'nor for a run without the plugin\'s fields, which the engine may start itself')
  process.env.KZ_CLAUDE_FAST_MODE = '0'
  assert.equal('settings' in (await runOf({ kzhControl: {} })).options, false, 'normal speed leaves it off')
  delete process.env.KZ_CLAUDE_FAST_MODE
  assert.equal('settings' in (await runOf({ kzhControl: {} })).options, false)
})

test('Claude Code: a tap that throws leaves the run\'s answer as it was', async () => {
  const w = await connectors()
  const h = await w.claude({ kzhTap: () => { throw new Error('the tap broke') }, kzhControl: {} })
  const r = w.sdk.runs.at(-1)
  r.say(init('t'), said('t', 'Working'), success('t', 'Fixed.'))
  r.end()
  const res = await h.result
  assert.deepEqual(res, { output: [{ type: 'text', text: 'Fixed.' }], stopReason: 'completed' })
})

test('Claude Code channel: the first message is the SDK\'s own write of the task, and the channel ends at the first result when nothing is pending', async () => {
  const { run: r, handle } = await claudeRun({}, { control: { channel: true } })
  await waitFor('the task is written', () => r.written.length, (n) => n === 1)
  assert.deepEqual(r.written[0], { type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: 'Fix the state file' }] }, parent_tool_use_id: null })
  assert.equal(r.inputEnded, false, 'open while the turn runs')
  r.say(success('c', 'Fixed.'))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  r.end()
  assert.equal(textOf(await handle.result), 'Fixed.')
})

test('Claude Code channel: a steer the turn took is delivered and the channel ends; one it did not take keeps it open until the next result', async () => {
  const one = await claudeRun({}, { control: { channel: true } })
  assert.equal(await one.control.steer('Also run the tests', 'u-1'), 'u-1')
  await waitFor('the steer is written', () => one.run.written.length, (n) => n === 2)
  assert.deepEqual(one.run.written[1], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Also run the tests' }] }, parent_tool_use_id: null, session_id: '', uuid: 'u-1' })
  one.run.say(success('c', 'Fixed, tests pass.', { user_message_uuids: ['u-1'] }))
  await waitFor('the input ends', () => one.run.inputEnded, Boolean)
  assert.deepEqual(one.outcomes, [['u-1', 'delivered']])
  one.run.end()
  await one.handle.result

  const two = await claudeRun({}, { control: { channel: true } })
  await two.control.steer('Then tidy up', 'u-2')
  two.run.say(success('c', 'Fixed.', { user_message_uuids: [] }))
  await settle()
  assert.equal(two.run.inputEnded, false, 'still open: the steer is still to run')
  assert.deepEqual(two.outcomes, [])
  two.run.say(success('c', 'Tidied.', { user_message_uuids: ['u-2'] }))
  await waitFor('the input ends', () => two.run.inputEnded, Boolean)
  assert.deepEqual(two.outcomes, [['u-2', 'delivered']])
  two.run.end()
  assert.equal(textOf(await two.handle.result), 'Fixed.\n\n---\n\nTidied.', 'both answers, in order')
})

test('Claude Code channel: a result that names no messages leaves a pending steer unknown and ends the channel', async () => {
  const { run: r, handle, control, outcomes } = await claudeRun({}, { control: { channel: true } })
  await control.steer('Also run the tests', 'u-3')
  r.say(success('c', 'Fixed.'))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  assert.deepEqual(outcomes, [['u-3', 'unknown']])
  r.end()
  await handle.result
  await assert.rejects(control.steer('too late', 'u-4'), (err) => err.code === 'kzh-no-channel', 'a closed channel takes nothing more')
})

test('Claude Code channel: 30 s after a result with a steer still pending, the channel ends and the steer is unknown', async (t) => {
  const { run: r, handle, control, outcomes } = await claudeRun({}, { control: { channel: true } })
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  await control.steer('Also run the tests', 'u-5')
  r.say(success('c', 'Fixed.', { user_message_uuids: [] }))
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(r.inputEnded, false)
  mock.timers.tick(29_999)
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(r.inputEnded, false, 'not before 30 s')
  mock.timers.tick(1)
  for (let i = 0; i < 5 && !r.inputEnded; i++) await settle()
  assert.equal(r.inputEnded, true)
  assert.deepEqual(outcomes, [['u-5', 'unknown']])
  r.end()
  assert.equal(textOf(await handle.result), 'Fixed.')
})

test('Claude Code channel: Send now interrupts the turn, passes over its aborted result and answers with the next', async () => {
  const { run: r, handle, control, outcomes } = await claudeRun({}, { control: { channel: true } })
  assert.equal(await control.sendNow('Do the other thing instead', 'u-6'), 'u-6')
  assert.equal(r.interrupts, 1)
  await waitFor('the message is written', () => r.written.length, (n) => n === 2)
  // The interrupted turn's result names no messages: the one that replaces it is still to run.
  r.say(failure('c', { terminal_reason: 'aborted_streaming' }))
  await settle()
  assert.equal(r.inputEnded, false, 'the replaced turn keeps the channel open for the message that replaces it')
  assert.deepEqual(outcomes, [])
  r.say(success('c', 'Did the other thing.', { user_message_uuids: ['u-6'] }))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  r.end()
  assert.deepEqual(await handle.result, { output: [{ type: 'text', text: 'Did the other thing.' }], stopReason: 'completed' })
  assert.deepEqual(outcomes, [['u-6', 'delivered']])
})

test('Claude Code channel: a steered turn that fails after one that answered leaves that answer', async () => {
  const { run: r, handle, control } = await claudeRun({}, { control: { channel: true } })
  await control.steer('Also run the tests', 'u-7')
  r.say(success('c', 'Fixed.', { user_message_uuids: [] }), failure('c', { user_message_uuids: ['u-7'] }))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  r.end()
  assert.deepEqual(await handle.result, { output: [{ type: 'text', text: 'Fixed.' }], stopReason: 'completed' })
})

test('Claude Code channel: a stop of the run ends the channel and leaves a pending steer unknown', async () => {
  const stop = new AbortController()
  const { run: r, handle, control, outcomes } = await claudeRun({ signal: stop.signal }, { control: { channel: true } })
  await control.steer('Also run the tests', 'u-12')
  assert.equal(r.inputEnded, false)
  stop.abort()
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  assert.deepEqual(outcomes, [['u-12', 'unknown']])
  r.end()
  await handle.result.catch(() => {})
})

test('Claude Code channel: a result with a turn still queued keeps the channel open until the next result', async () => {
  const { run: r, handle } = await claudeRun({}, { control: { channel: true } })
  await waitFor('the task is written', () => r.written.length, (n) => n === 1)
  r.say(success('c', 'Fixed.', { queued_turn_count: 1 }))
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(r.inputEnded, false, 'open: a turn is still to run')
  r.say(success('c', 'Tidied.', { queued_turn_count: 0 }))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  r.end()
  await handle.result
})

test('Claude Code channel: Send now passes over the aborted result of the turn it replaced once only, so the replacing turn\'s own aborted result ends the channel', async () => {
  const { run: r, handle, control, outcomes } = await claudeRun({}, { control: { channel: true } })
  await control.sendNow('Do the other thing instead', 'u-13')
  await waitFor('the message is written', () => r.written.length, (n) => n === 2)
  r.say(failure('c', { terminal_reason: 'aborted_streaming' }))
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(r.inputEnded, false, 'the replaced turn\'s result keeps it open')
  r.say(failure('c', { terminal_reason: 'aborted_tools', user_message_uuids: ['u-13'] }))
  await waitFor('the input ends', () => r.inputEnded, Boolean)
  assert.deepEqual(outcomes, [['u-13', 'delivered']])
  r.end()
  await handle.result.catch(() => {})
})

test('Claude Code channel: a steer run as a turn of its own that works for longer than 30 s, and a Send now\'s turn as long, keep the channel open while they work and are delivered at their results', async (t) => {
  const steered = await claudeRun({}, { control: { channel: true } })
  const sent = await claudeRun({}, { control: { channel: true } })
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const ticks = async () => { for (let i = 0; i < 5; i++) await settle() }
  await steered.control.steer('Also run the tests', 'u-14')
  steered.run.say(success('c', 'Fixed.', { user_message_uuids: [] }))
  await sent.control.sendNow('Do the other thing instead', 'u-15')
  sent.run.say(failure('c', { terminal_reason: 'aborted_streaming' }))
  await ticks()
  // Each next turn works for a minute and a half, saying something every 20 s.
  for (let n = 1; n <= 4; n++) {
    mock.timers.tick(20_000)
    steered.run.say(said('c', `Testing ${n}`))
    sent.run.say(said('c', `Doing ${n}`))
    await ticks()
    assert.deepEqual([steered.run.inputEnded, sent.run.inputEnded], [false, false], `open ${n * 20} s on`)
  }
  assert.equal(await steered.control.steer('And lint it', 'u-16'), 'u-16', 'the channel still takes a steer')
  steered.run.say(success('c', 'Tested and linted.', { user_message_uuids: ['u-14', 'u-16'] }))
  sent.run.say(success('c', 'Did the other thing.', { user_message_uuids: ['u-15'] }))
  await ticks()
  assert.deepEqual([steered.run.inputEnded, sent.run.inputEnded], [true, true])
  assert.deepEqual([steered.outcomes, sent.outcomes], [[['u-14', 'delivered'], ['u-16', 'delivered']], [['u-15', 'delivered']]])
  steered.run.end()
  sent.run.end()
  assert.deepEqual([textOf(await steered.handle.result), textOf(await sent.handle.result)], ['Fixed.\n\n---\n\nTested and linted.', 'Did the other thing.'])
})

test('Claude Code: without a channel, steer and Send now refuse, and the thinking display goes to the query', async () => {
  const { run: r, handle, control } = await claudeRun()
  await assert.rejects(control.steer('x', 'u-8'), (err) => err.code === 'kzh-no-channel')
  await assert.rejects(control.sendNow('x', 'u-9'), (err) => err.code === 'kzh-no-channel')
  assert.equal(r.interrupts, 0, 'nothing is interrupted for a message that has nowhere to go')
  await control.thinkingDisplay('summarized')
  assert.deepEqual(r.thinking, [[null, 'summarized']])
  r.say(success('c', 'Fixed.'))
  r.end()
  assert.equal(textOf(await handle.result), 'Fixed.')
})

/**
 * Until the app-server has started a turn, and a moment more: the connector learns the turn's id from
 * the turn/start response, which it reads just before the turn's first notification.
 */
async function turnRunning(started) {
  await waitFor('the turn runs', started, Boolean)
  for (let i = 0; i < 3; i++) await settle()
}

/** A Codex run started on the patched connector, with its app-server; `onTurn` is given before the run starts. */
async function codexRun(fields = {}, onTurn = null) {
  const w = await connectors()
  const before = w.servers.length
  const started = w.codex(fields)
  const server = w.servers[before]
  server.onTurn = onTurn
  return { handle: await started, server }
}

test('Codex: two runs at once each tap only their own frames, the thread/start response first among them, and their answers are as without a tap', async () => {
  const heard = { a: [], b: [] }
  const turns = {}
  // Both runs start before either turn ends, and their frames come in turn, as two runs' do on the PC.
  const [a, b] = await Promise.all([
    codexRun({ kzhTap: (f) => heard.a.push(f), kzhControl: {} }, (id) => { turns.a = id }),
    codexRun({ kzhTap: (f) => heard.b.push(f), kzhControl: {} }, (id) => { turns.b = id }),
  ])
  await turnRunning(() => turns.a && turns.b)
  a.server.say('item/agentMessage/delta', { turnId: turns.a, itemId: 'm1', delta: 'Working' })
  b.server.say('item/agentMessage/delta', { turnId: turns.b, itemId: 'm1', delta: 'Working on B' })
  for (let i = 0; i < 3; i++) await settle()
  b.server.complete(turns.b, 'Fixed B.')
  a.server.complete(turns.a, 'Fixed A.')
  const [ra, rb] = await Promise.all([a.handle.result, b.handle.result])
  assert.deepEqual([textOf(ra), textOf(rb)], ['Fixed A.', 'Fixed B.'])
  for (const [mine, server] of [[heard.a, a.server], [heard.b, b.server]]) {
    assert.equal(mine[0].method, 'kzh/thread-start-response')
    assert.equal(mine[0].params.thread.id, server.thread)
    assert.equal(mine[0].params.model, 'gpt-5.4')
    assert.ok(mine.slice(1).every((f) => f.provider === 'codex' && f.params.threadId === server.thread), 'only frames of its own thread')
    assert.ok(mine.some((f) => f.method === 'turn/completed'))
  }
  assert.ok(heard.a.some((f) => f.method === 'item/agentMessage/delta' && f.params.delta === 'Working'))
  const plain = await codexRun({}, function (id) { this.complete(id, 'Fixed A.') })
  assert.deepEqual(await plain.handle.result, ra, 'the same answer as a run without the plugin\'s fields')
})

test('Codex: every turn of a run takes the effort and speed set as it started, however they change after', async (t) => {
  const was = { effort: process.env.KZ_CODEX_EFFORT, tier: process.env.KZ_CODEX_SERVICE_TIER }
  t.after(() => { for (const [k, v] of [['KZ_CODEX_EFFORT', was.effort], ['KZ_CODEX_SERVICE_TIER', was.tier]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  process.env.KZ_CODEX_EFFORT = 'xhigh'
  process.env.KZ_CODEX_SERVICE_TIER = 'fast'
  const w = await connectors()
  const started = w.codex({ kzhControl: {} })
  process.env.KZ_CODEX_EFFORT = 'low'
  delete process.env.KZ_CODEX_SERVICE_TIER
  const server = w.servers.at(-1)
  server.onTurn = (id) => server.complete(id)
  const handle = await started
  await handle.result
  const turn = server.requests.find((x) => x.method === 'turn/start').params
  assert.deepEqual([turn.effort, turn.serviceTier], ['xhigh', 'fast'])
  // A run without kzhControl adds nothing to turn/start: it has what patch-codex-effort reads as the turn starts.
  const bare = w.codex({})
  const s2 = w.servers.at(-1)
  s2.onTurn = (id) => s2.complete(id)
  await (await bare).result
  const plain = s2.requests.find((x) => x.method === 'turn/start').params
  assert.deepEqual([Object.keys(plain), plain.effort], [['threadId', 'effort', 'input'], 'low'])
})

test('Codex: a turn after Send now takes no effort or speed set since by another run, when its own run started without them', async (t) => {
  const was = { effort: process.env.KZ_CODEX_EFFORT, tier: process.env.KZ_CODEX_SERVICE_TIER }
  t.after(() => { for (const [k, v] of [['KZ_CODEX_EFFORT', was.effort], ['KZ_CODEX_SERVICE_TIER', was.tier]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  delete process.env.KZ_CODEX_EFFORT
  delete process.env.KZ_CODEX_SERVICE_TIER
  const control = {}
  const turns = []
  const run = await codexRun({ kzhControl: control }, (id) => { turns.push(id) })
  await turnRunning(() => turns.length === 1)
  // Another run starts at 1.5x and high effort, and nothing clears the variables after it.
  process.env.KZ_CODEX_EFFORT = 'xhigh'
  process.env.KZ_CODEX_SERVICE_TIER = 'priority'
  await control.sendNow('Do the other thing instead', 'c-7')
  await waitFor('the next turn runs', () => turns.length, (n) => n === 2)
  run.server.complete('turn_2', 'Did the other thing.')
  await run.handle.result
  const starts = run.server.requests.filter((x) => x.method === 'turn/start').map((x) => Object.keys(x.params))
  assert.deepEqual(starts, [['threadId', 'input'], ['threadId', 'input']], 'neither turn carries an effort or a speed')
})

test('Codex: steer refuses without a running turn, and sends turn/steer for the running one with its id and the message\'s', async () => {
  const control = {}
  let turnId = null
  const run = await codexRun({ kzhControl: control }, (id) => { turnId = id })
  await turnRunning(() => turnId)
  assert.deepEqual(await control.steer('Focus on the failing test first', 'c-1'), { turnId })
  const steer = run.server.requests.find((x) => x.method === 'turn/steer')
  assert.deepEqual(steer.params, { threadId: run.server.thread, expectedTurnId: turnId, input: [{ type: 'text', text: 'Focus on the failing test first', text_elements: [] }], clientUserMessageId: 'c-1' })
  run.server.complete(turnId)
  await run.handle.result
  await assert.rejects(control.steer('too late', 'c-2'), (err) => err.code === 'kzh-no-turn', 'not once the turn has ended')
  await assert.rejects(control.sendNow('too late', 'c-3'), (err) => err.code === 'kzh-no-turn')
})

test('Codex: Send now interrupts the turn and goes on in the same thread at the effort the run started with, past the old turn\'s late notifications', async (t) => {
  const was = process.env.KZ_CODEX_EFFORT
  t.after(() => { if (was === undefined) delete process.env.KZ_CODEX_EFFORT; else process.env.KZ_CODEX_EFFORT = was })
  process.env.KZ_CODEX_EFFORT = 'high'
  const outcomes = []
  const control = { onOutcome: (id, outcome) => outcomes.push([id, outcome]) }
  const turns = []
  const run = await codexRun({ kzhControl: control }, (id) => { turns.push(id) })
  process.env.KZ_CODEX_EFFORT = 'minimal'
  await turnRunning(() => turns.length === 1)
  // The old turn's last words arrive after it has been replaced, before the new turn is answered.
  run.server.beforeTurn.push(
    ['item/completed', { turnId: 'turn_1', item: { type: 'agentMessage', id: 'late', text: 'An answer to the old task.', phase: 'final_answer' } }],
    ['turn/completed', { turn: { id: 'turn_1', status: 'interrupted', items: [], error: null } }],
  )
  await control.sendNow('Do the other thing instead', 'c-4')
  await waitFor('the next turn runs', () => turns.length, (n) => n === 2)
  run.server.complete('turn_2', 'Did the other thing.')
  assert.deepEqual(await run.handle.result, { output: [{ type: 'text', text: 'Did the other thing.' }], stopReason: 'completed' })
  const starts = run.server.requests.filter((x) => x.method === 'turn/start').map((x) => x.params)
  assert.deepEqual(starts.map((p) => [p.threadId, p.effort, p.input[0].text]), [[run.server.thread, 'high', 'Fix the state file'], [run.server.thread, 'high', 'Do the other thing instead']])
  assert.equal(run.server.requests.filter((x) => x.method === 'turn/interrupt').length, 1)
  assert.deepEqual(outcomes, [['c-4', 'continued']])
})

test('Codex: words sent now again before the interrupt has ended the turn go in the same next turn, after the first, and each is gone on with', async () => {
  const outcomes = []
  const control = { onOutcome: (id, outcome) => outcomes.push([id, outcome]) }
  const turns = []
  const run = await codexRun({ kzhControl: control }, (id) => { turns.push(id) })
  await turnRunning(() => turns.length === 1)
  // Codex has not ended the turn yet when the second words come.
  let interrupted = null
  run.server.onInterrupt = (id) => { interrupted = id }
  await control.sendNow('Do the other thing instead', 'c-8')
  await control.sendNow('And keep the old tests', 'c-9')
  await waitFor('the interrupt lands', () => interrupted, Boolean)
  run.server.say('turn/completed', { turn: { id: interrupted, status: 'interrupted', items: [], error: null } })
  await waitFor('the next turn runs', () => turns.length, (n) => n === 2)
  run.server.complete('turn_2', 'Did both.')
  assert.deepEqual(await run.handle.result, { output: [{ type: 'text', text: 'Did both.' }], stopReason: 'completed' })
  const next = run.server.requests.filter((x) => x.method === 'turn/start')[1].params
  assert.deepEqual(next.input.map((x) => x.text), ['Do the other thing instead', 'And keep the old tests'])
  assert.equal(run.server.requests.filter((x) => x.method === 'turn/interrupt').length, 1, 'one interrupt for both')
  assert.deepEqual(outcomes, [['c-8', 'continued'], ['c-9', 'continued']])
})

test('Codex: a turn that completes before Send now\'s interrupt lands is the run\'s answer, and no turn follows it', async () => {
  const outcomes = []
  const control = { onOutcome: (id, outcome) => outcomes.push([id, outcome]) }
  let turnId = null
  const run = await codexRun({ kzhControl: control }, (id) => { turnId = id })
  await turnRunning(() => turnId)
  // The turn was already done when the interrupt came: Codex completes it as it was.
  run.server.onInterrupt = (id) => run.server.complete(id, 'Fixed it first.')
  await control.sendNow('Do the other thing instead', 'c-5')
  assert.deepEqual(await run.handle.result, { output: [{ type: 'text', text: 'Fixed it first.' }], stopReason: 'completed' })
  assert.equal(run.server.requests.filter((x) => x.method === 'turn/start').length, 1)
  assert.deepEqual(outcomes, [], 'the message was not used, which the plugin reports as returned')
})

test('Codex: a tap that throws leaves the run\'s answer as it was', async () => {
  const run = await codexRun({ kzhTap: () => { throw new Error('the tap broke') }, kzhControl: {} }, function (id) { this.say('item/agentMessage/delta', { turnId: id, itemId: 'm1', delta: 'Working' }); this.complete(id, 'Fixed.') })
  assert.deepEqual(await run.handle.result, { output: [{ type: 'text', text: 'Fixed.' }], stopReason: 'completed' })
})

test('Codex: Send now lets go of the answer of the turn it replaced, so a next turn that answers nothing is no answer', async () => {
  const control = {}
  const turns = []
  const run = await codexRun({ kzhControl: control }, (id) => { turns.push(id) })
  await turnRunning(() => turns.length === 1)
  run.server.say('item/completed', { turnId: 'turn_1', item: { type: 'agentMessage', id: 'old', text: 'An answer to the old task.', phase: 'final_answer' } })
  for (let i = 0; i < 5; i++) await settle()
  await control.sendNow('Do the other thing instead', 'c-6')
  await waitFor('the next turn runs', () => turns.length, (n) => n === 2)
  run.server.complete('turn_2', '')
  const res = await run.handle.result
  assert.deepEqual([res.output, res.stopReason, res.error?.facts], [[], 'error', { stage: 'turn', category: 'invalid-result' }], 'not the old turn\'s answer')
})
