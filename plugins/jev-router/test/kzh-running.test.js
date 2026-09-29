// kzh-running.js: what of KzH runs now, for the speed run and the Laya command line, from a process
// list and whatever answers on KzH's port, both given here, so nothing is listed or opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as running from '../kzh-running.js'
import { isKzhEngine, kzhRunning, stopEngine, stopUnknown } from '../kzh-running.js'

const ENGINE = 'C:\\Program Files\\nodejs\\node.exe C:\\Users\\kz\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web'
const NPX = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y @deepseek-ai/dsh@0.1.5-rc.2 web --no-open'
const run = (list, { listening = false, owner = null } = {}) => {
  const asked = []
  const found = kzhRunning({ port: 3080, processes: () => list, answers: async (p) => { asked.push(p); return listening }, owner: () => owner })
  return found.then((f) => ({ ...f, asked }))
}

test('the app comes first, whatever else runs, and its port is not even asked', async () => {
  const list = [{ pid: 7, name: 'node.exe', cmd: ENGINE }, { pid: 8, name: 'Kz-harness.exe', cmd: null }]
  const found = await run(list, { listening: true, owner: 7 })
  assert.deepEqual(found.app, list[1])
  assert.equal(found.engine, undefined)
  assert.deepEqual(found.asked, [])
  assert.equal(found.list, list, 'the list comes back for the checks that follow')
})

test('an engine with no app: the one listening on the port, else the engine rather than the npx wrapper above it', async () => {
  const wrapper = { pid: 21, name: 'node.exe', cmd: NPX }
  const shell = { pid: 22, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "dsh web --no-open"' }
  const engine = { pid: 23, name: 'node.exe', cmd: ENGINE }
  assert.ok(isKzhEngine(NPX), 'the wrapper reads as the engine too')
  assert.deepEqual((await run([wrapper, shell, engine], { listening: true, owner: 23 })).engine, engine)
  assert.deepEqual((await run([wrapper, shell, engine])).engine, engine, 'before it listens')
  assert.deepEqual((await run([wrapper])).engine, wrapper, 'the wrapper alone (npx still resolving) is still KzH')
  // The listener wins over the order of the list: a second engine, or a shim node above the real one.
  const E = (pid, dir) => ({ pid, name: 'node.exe', cmd: `node C:\\${dir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open` })
  assert.equal((await run([E(30, 'old'), E(31, 'new')], { listening: true, owner: 31 })).engine.pid, 31)
  assert.equal((await run([E(30, 'old'), E(31, 'new')])).engine.pid, 30, 'before anything listens, the first')
  assert.deepEqual((await run([wrapper, engine], { listening: true, owner: 21 })).engine, wrapper, 'even the wrapper, when it is what listens')
  assert.match(stopEngine(23), /^close the Start-KzH window it runs in, or, if no such window is open, end it in Task Manager \(Details, right-click pid 23, End process tree\)$/)
})

test('something on the port that cannot be told from KzH says who, and why it cannot be told', async () => {
  assert.equal((await run([{ pid: 9, name: 'node.exe', cmd: '' }], { listening: true, owner: 9 })).unknown, 'node.exe, pid 9, whose command line cannot be read (it may run as administrator)')
  assert.equal((await run([{ pid: 9, name: 'node.exe', cmd: null }], { listening: true, owner: 9 })).unknown, 'node.exe, pid 9, whose command line could not be listed')
  assert.equal((await run([], { listening: true, owner: 9 })).unknown, 'pid 9, which cannot be looked up')
  assert.equal((await run(null, { listening: true })).unknown, 'a program that cannot be found')
  // Its owner not found, while a node that could be the engine runs: that node is named.
  const hidden = await run([{ pid: 12, name: 'node.exe', cmd: '' }, { pid: 13, name: 'explorer.exe', cmd: 'explorer.exe' }], { listening: true })
  assert.equal(hidden.unknown, 'a program that cannot be found')
  assert.deepEqual(hidden.candidates, [{ pid: 12, name: 'node.exe', cmd: '' }])
  // How to stop it, in short sentences: a list that was read has no Kz-harness.exe in it, so no tray icon;
  // with no list, it may be the app. The caller's own name for KzH is used.
  assert.equal(stopUnknown(await run([{ pid: 9, name: 'node.exe', cmd: '' }], { listening: true, owner: 9 })), "No Kz-harness app is running. If pid 9 is another program, close it. If it is KzH's engine, close the Start-KzH window it runs in, or, with no such window open, end it in Task Manager (Details, right-click pid 9, End process tree; run Task Manager as administrator if it says access is denied)")
  assert.equal(stopUnknown(hidden, 'Kz-harness'), "No Kz-harness app is running. If it is Kz-harness's engine (node.exe, pid 12), close the Start-KzH window it runs in, or, with no such window open, end it in Task Manager (Details, right-click its pid, End process tree; run Task Manager as administrator if it says access is denied). If it is another program, close it")
  assert.equal(stopUnknown(await run(null, { listening: true })), 'If it is Kz-harness, quit it (right-click its tray icon and choose Quit; closing its window leaves it running) or close its Start-KzH window. If it is another program, close it')
})

test('what cannot be KzH is another program: a holder named other than node, and an owner not found while nothing that could be the engine runs', async () => {
  // KzH's engine is always node, so a name says enough even when the command line cannot be read.
  for (const holder of [{ pid: 4, name: 'System', cmd: '' }, { pid: 3456, name: 'svchost.exe', cmd: '' }, { pid: 77, name: 'com.docker.backend.exe', cmd: null }]) {
    const found = await run([holder], { listening: true, owner: holder.pid })
    assert.deepEqual(found.other, holder)
    assert.equal(found.unknown, undefined)
  }
  const node = await run([{ pid: 9, name: 'node.exe', cmd: null }], { listening: true, owner: 9 })
  assert.equal(node.unknown, 'node.exe, pid 9, whose command line could not be listed', 'node listed by name alone may be the engine')
  // The owner cannot be found, and every node has a readable command line that is not the engine.
  // Listed by name alone (tasklist), the tool asking is a node too, never the engine: it is not a candidate.
  const self = { pid: process.pid, name: 'node.exe', cmd: null }
  assert.deepEqual((await run([self], { listening: true })).other, { name: null, pid: null })
  const beside = await run([self, { pid: 12, name: 'node.exe', cmd: null }], { listening: true })
  assert.deepEqual(beside.candidates.map((p) => p.pid), [12])
  assert.ok(!stopUnknown(beside).includes(String(process.pid)))
  const unseen = await run([{ pid: 55, name: 'node.exe', cmd: 'node C:\\dev\\server.js' }], { listening: true })
  assert.deepEqual(unseen.other, { name: null, pid: null })
  assert.equal(running.otherNote(unseen, { what: 'the speed run' }), "Something answers on 127.0.0.1:3080 whose pid could not be found; no process that could be KzH's engine runs, so the speed run goes ahead.")
  assert.equal(running.otherNote(await run([{ pid: 4, name: 'System', cmd: '' }], { listening: true, owner: 4 }), { port: 3080, kzh: 'Kz-harness', what: 'the install' }), "Another program answers on 127.0.0.1:3080 (System, pid 4); it is not Kz-harness's engine, so the install goes ahead.")
})

test('another program on the port, told apart by its command line, and nothing at all', async () => {
  const other = { pid: 55, name: 'node.exe', cmd: 'node C:\\LibreChat\\api\\server\\index.js' }
  const found = await run([other], { listening: true, owner: 55 })
  assert.deepEqual(found.other, other)
  assert.equal(found.unknown, undefined)
  const none = await run([{ pid: 4242, name: 'llama-server.exe', cmd: 'llama-server.exe -m a.gguf' }])
  assert.deepEqual(Object.keys(none).filter((k) => k !== 'asked'), ['list'])
})
