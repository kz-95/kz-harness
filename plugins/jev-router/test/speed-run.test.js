// scripts/speed-run.mjs, the speed benchmark from a shell for Speed-Run.bat (docs/benchmark.md
// 2.12): a harness of its own with the engine and one model in place, driven through main() with a
// fake llama-server, so nothing is loaded and no port is opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeLlamaServer } from './fixtures/fake-llama-server.mjs'
import { SPEED_LOCK as LOCK } from '../local.js'

const SCRIPT_URL = new URL('../../../scripts/speed-run.mjs', import.meta.url)
const SCRIPT = fileURLToPath(SCRIPT_URL)
const BAT = fileURLToPath(new URL('../../../Speed-Run.bat', import.meta.url))
// import() takes a URL, never a path: a bare `C:\...` is read as the scheme `c:` and throws.
const { EXIT, isKzhEngine, jevContextSize, machineCheck, main, parseArgs, portOwner, processList, profileContext, table } = await import(SCRIPT_URL.href)

const made = []
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const sha = (s) => createHash('sha256').update(s).digest('hex')
const GIB = 1024 ** 3
const MODULES = [
  { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') },
  { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * GIB, sha256: sha('big'), recommendedVramGB: 6.5, minRamGB: 12, contextSize: 16384 },
  { id: 'small', kind: 'model', name: 'Small', source: 'https://huggingface.co/Org/Small-GGUF/resolve/main/small.gguf', file: 'small.gguf', size: 3 * GIB, sha256: sha('small'), recommendedVramGB: 3.8, minRamGB: 8, contextSize: 16384 },
]
const PC = {
  gpus: [{ name: 'NVIDIA GeForce RTX 3080', vendor: 'nvidia', vramGB: 10 }],
  cuda: 12.7, ramGB: 32, cpu: { name: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 200 * GIB,
}
const SPLIT = ['load_tensors: offloaded 37/37 layers to GPU', 'CUDA0 model buffer size = 5120.00 MiB', 'CUDA0 KV buffer size = 1024.00 MiB', 'CPU model buffer size = 512.00 MiB']

/** A harness with the engine and `installed` models in place, a data folder, and the fake engine. */
function world({ installed = ['big'], server = fakeLlamaServer({ report: () => SPLIT, speed: () => ({ generate: 64, read: 2048 }) }) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-speedrun-'))
  made.push(root)
  const harness = join(root, 'harness')
  const data = join(root, 'home', 'jev-router')
  const engineDir = join(harness, 'engine', 'llama')
  mkdirSync(join(harness, 'config'), { recursive: true })
  mkdirSync(join(engineDir, '.installed'), { recursive: true })
  mkdirSync(join(harness, 'models'), { recursive: true })
  writeFileSync(join(harness, 'config', 'local-models.json'), JSON.stringify({ about: 'test', modules: MODULES }))
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  for (const id of installed) writeFileSync(join(harness, 'models', MODULES.find((m) => m.id === id).file), id)
  const out = []
  const err = []
  const seams = { machineCheck: async () => ({ why: null, notes: [] }), specs: async () => PC, localModels: { spawn: server.spawn, fetch: server.fetch, port: 0 } }
  const run = (argv = [], extra = {}) => main(['--harness', harness, '--data', data, ...argv], { print: (s) => { out.push(s); extra.onPrint?.(s) }, fail: (s) => err.push(s), seams: { ...seams, ...extra.seams }, interrupts: extra.interrupts })
  return { root, harness, data, server, out, err, run }
}
/** The speed run history, as local.js and this script append to it (docs/benchmark.md 2.13). */
const history = (data) => (existsSync(join(data, 'speed-runs', 'speed-runs.log')) ? readFileSync(join(data, 'speed-runs', 'speed-runs.log'), 'utf8') : '')
/** The detail logs, oldest first. */
const details = (data) => (existsSync(join(data, 'speed-runs')) ? readdirSync(join(data, 'speed-runs')).filter((f) => f.startsWith('speed-run-')).sort().map((f) => readFileSync(join(data, 'speed-runs', f), 'utf8')) : [])

test('a speed run measures every installed chat model through local.js, stores each reading where KzH reads it, and exits 0', async () => {
  const w = world({ installed: ['big', 'small'] })
  // Hand-placed files: hashed once before they count as installed, as the Local models card does.
  const code = await w.run()
  assert.equal(code, EXIT.measured, w.err.join('\n'))
  const text = w.out.join('\n')
  assert.match(text, /Checking the SHA256 of Big, Small/)
  assert.match(text, /PC: RTX 3080 10 GB, 32 GB RAM, Core i7-8700K 6 cores, 200 GB free/)
  assert.match(text, /Measuring Big, Small: a warm-up, the 8,192-token prompt, then three timed requests each\./)
  assert.match(text, /OK  Big: 64\.0 tokens\/s generating and 2048 tokens\/s reading, 8,192 tokens into a conversation, at 16k context\./)
  assert.match(text, /OK  Small: 64\.0 tokens\/s generating/)
  assert.match(text, /The engine is stopped again, as it was before\./)
  // The table: both models, with the split and the memory the load reported.
  const rows = text.split('\n').filter((l) => /^(Big|Small)\s/.test(l))
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^Big\s+64\.0\s+2048\s+16k\s+37\/37\s+6\.0\s+0\.5\s/)
  // local.json holds the readings under <model>@<context>, as the in-app run leaves them.
  const s = JSON.parse(readFileSync(join(w.data, 'local.json'), 'utf8'))
  assert.deepEqual(Object.keys(s.speed).sort(), ['big@16384', 'small@16384'])
  assert.equal(s.speed['big@16384'].tokensPerSec, 64)
  // Three measured requests per model after the warm-up and the fill, and the engine stopped at the end.
  assert.equal(w.server.to('/completion').filter((r) => r.body.n_predict === 128).length, 6)
  assert.ok(w.server.started.every((x) => x.child.exitCode !== null), 'no llama-server is left running')
  // The logs: the run's summary in the history, as Speed-Run.bat's, and its detail log with the engine's lines.
  assert.match(history(w.data), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: 2 of 2 measured\n  PC: RTX 3080 10 GB, 32 GB RAM, Core i7-8700K 6 cores, 200 GB free; engine: cuda12 build [0-9a-f]{12}; budget: GPU layers auto; no Laya held\n  Big    64\.0 tokens\/s generating, 2048 tokens\/s reading, 16k context, 37\/37 layers on the GPU, 6\.0 GB VRAM \+ 0\.5 GB RAM, loaded in \d+\.\d s, 4 threads\n  Small  64\.0 tokens\/s generating/)
  const [detail] = details(w.data)
  assert.match(detail, /^KzH speed run, started .* UTC from Speed-Run\.bat\n/)
  assert.match(detail, /\d\d:\d\d:\d\d\.\d{3} {2}engine ready: big, 37\/37 layers on GPU\n/)
  assert.match(text, /\n2 speed readings saved in local\.json, where KzH reads them\.\nEvery speed run on this PC: .*speed-runs[\\/]speed-runs\.log\nThis run in detail: .*speed-runs[\\/]speed-run-[\dT-]+Z\.log$/)
})

test('--models measures only the models named; a model that is not installed or not known refuses the run with exit 2', async () => {
  const w = world({ installed: ['big', 'small'] })
  assert.equal(await w.run(['--models', 'small']), EXIT.measured, w.err.join('\n'))
  assert.match(history(w.data), /^.* UTC, Speed-Run\.bat: 1 of 1 measured\n.*\n  Small  64\.0 tokens\/s/)
  // A run refused is written in the history too, with why, so a scheduled run that did nothing says so.
  assert.equal(await w.run(['--models', 'nope']), EXIT.couldNotRun)
  assert.match(w.err.at(-1), /No local chat model is named nope\./)
  assert.match(history(w.data), /\n\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: did not run\. No local chat model is named nope\.\n\n$/)
  const v = world({ installed: ['big'] })
  assert.equal(await v.run(['--models', 'small']), EXIT.couldNotRun)
  assert.match(v.err.at(-1), /Small is not installed/)
  const none = world({ installed: [] })
  assert.equal(await none.run(), EXIT.couldNotRun)
  assert.match(none.err.at(-1), /No local chat model is installed \(type \/install-llm\)\.\nInstall in KzH \(type \/install-llm in a chat\), or run scripts\\Install-Harness\.ps1 -LocalModels <id,id\|all>\./)
  assert.ok(!existsSync(join(none.data, 'local.json')), 'a run refused changes no setting')
  assert.match(history(none.data), /Speed-Run\.bat: did not run\. No local chat model is installed \(type \/install-llm\)\. Install in KzH \(type \/install-llm in a chat\), or run scripts\\Install-Harness\.ps1 -LocalModels <id,id\|all>\.\n\n$/)
})

test('a model that is not measured makes the run exit 1, with its reason in its line, the table and the history', async () => {
  // Timings that say fewer tokens were generated than asked for: local.js refuses the reading.
  const server = fakeLlamaServer({ report: () => SPLIT, timings: (entry, worked) => (entry.body.n_predict === 128 ? { ...worked, predicted_n: 100 } : worked) })
  const w = world({ server })
  assert.equal(await w.run(), EXIT.notMeasured)
  const text = w.out.join('\n')
  assert.match(text, /NO  Big not measured: llama-server generated 100 tokens, not 128/)
  assert.match(text, /^Big\s+not measured\s/m)
  assert.ok(w.out.includes('No speed reading was saved.'), 'never that readings were saved when none was')
  assert.match(history(w.data), /: 0 of 1 measured\n.*\n  Big  not measured: llama-server generated 100 tokens, not 128\n/)
  const s = JSON.parse(readFileSync(join(w.data, 'local.json'), 'utf8'))
  assert.deepEqual(s.speed ?? {}, {}, 'nothing is stored for a model that was not measured')
})

test('it refuses with exit 3 while KzH runs, before anything is loaded, and writes why in the history', async () => {
  const w = world()
  const code = await w.run([], { seams: { machineCheck: async () => ({ why: 'KzH is running (something answers on 127.0.0.1:3080).', notes: [] }) } })
  assert.equal(code, EXIT.kzhRunning)
  assert.match(w.err.join('\n'), /KzH is running/)
  assert.equal(w.server.started.length, 0)
  assert.ok(!existsSync(join(w.data, 'local.json')))
  assert.match(history(w.data), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: did not run\. KzH is running \(something answers on 127\.0\.0\.1:3080\)\.\n\n$/)
  assert.deepEqual(details(w.data), [], 'no detail log for a run that never started')
})

test('machineCheck: KzH\'s engine or app, a llama-server or a Laya left behind each stop the run; a program on KzH\'s port is looked up by its pid', async () => {
  const none = async () => null
  const closed = async () => false
  const check = (list, extra = {}) => machineCheck({ harness: '/h', data: '/d', answers: closed, processes: () => list, owner: () => null, laya: none, ...extra })
  const ENGINE = 'C:\\Program Files\\nodejs\\node.exe C:\\Users\\kz\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web'
  assert.deepEqual(await check([{ pid: 1, name: 'explorer.exe', cmd: 'C:\\Windows\\explorer.exe' }, { pid: 2, name: 'node.exe', cmd: 'node C:\\x\\server.js' }]), { why: null, notes: [] })
  assert.match((await check([{ pid: 7, name: 'node.exe', cmd: ENGINE }])).why, /^KzH is running \(its engine, node\.exe\)\. Close KzH and run this again/)
  assert.match((await check([{ pid: 8, name: 'Kz-harness.exe', cmd: null }])).why, /^KzH is running \(Kz-harness\.exe\)\./)
  assert.match((await check([{ pid: 9, name: 'llama-server.exe', cmd: null }])).why, /^A llama-server is running with KzH closed \(llama-server\.exe, pid 9\)/)
  assert.match((await check([], { laya: async () => ({ pid: 4242 }) })).why, /^A Laya an earlier KzH left running \(pid 4242\) holds memory the readings would lose\. Start KzH and close it again, which stops it, or end pid 4242 in Task Manager/)
  // Something on KzH's port, looked up by the pid that listens there.
  const listening = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => listening.once('listening', r))
  const { port } = listening.address()
  try {
    const on = (list, pid) => check(list, { port, answers: undefined, owner: () => pid })
    assert.deepEqual(await on([{ pid: 55, name: 'node.exe', cmd: 'node C:\\LibreChat\\api\\server\\index.js' }], 55), { why: null, notes: [`Another program answers on 127.0.0.1:${port} (node.exe, pid 55); it is not KzH's engine, so the speed run goes ahead.`] })
    // KzH's engine run as administrator: its command line reads empty, so it cannot be told from KzH.
    assert.match((await on([{ pid: 56, name: 'node.exe', cmd: '' }], 56)).why, new RegExp(`^KzH, or another program, answers on 127\\.0\\.0\\.1:${port} \\(node\\.exe, pid 56, whose command line cannot be read \\(it may run as administrator\\)\\), so nobody can tell whether KzH is running\\.`))
    assert.match((await on([{ pid: 57, name: 'node.exe', cmd: null }], 57)).why, /whose command line cannot be read/, 'names alone cannot tell the engine')
    assert.match((await on([], 58)).why, /\(pid 58, which cannot be looked up\)/)
    assert.match((await on(null, null)).why, /\(a program that cannot be found\)/)
  } finally { listening.close() }
  assert.ok(isKzhEngine(ENGINE))
  assert.ok(isKzhEngine('node /home/kz/.npm/_npx/1/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open'))
  assert.ok(!isKzhEngine('node /home/kz/.npm/_npx/1/node_modules/@deepseek-ai/dsh/lib/bin.js --version'))
  assert.ok(!isKzhEngine(null))
})

test('processList reads CIM\'s pids and command lines on Windows, tasklist\'s when PowerShell fails, and ps elsewhere; portOwner reads netstat and ss', () => {
  const cim = '0|System Idle Process|\r\n7|node.exe|"C:\\Program Files\\nodejs\\node.exe" bin.js web\r\n4242|llama-server.exe|llama-server.exe -m a.gguf\r\n'
  assert.deepEqual(processList({ platform: 'win32', run: (cmd) => (cmd === 'powershell.exe' ? { status: 0, stdout: cim } : null) }), [
    { pid: 0, name: 'System Idle Process', cmd: '' }, { pid: 7, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" bin.js web' }, { pid: 4242, name: 'llama-server.exe', cmd: 'llama-server.exe -m a.gguf' },
  ])
  const tasklist = '"System Idle Process","0","Services","0","8 K"\r\n"llama-server.exe","4242","Console","1","5,120 K"\r\n'
  assert.deepEqual(processList({ platform: 'win32', run: (cmd) => (cmd === 'powershell.exe' ? { status: 1, stdout: '' } : { status: 0, stdout: tasklist }) }), [{ pid: 0, name: 'System Idle Process', cmd: null }, { pid: 4242, name: 'llama-server.exe', cmd: null }])
  assert.deepEqual(processList({ platform: 'linux', run: () => ({ status: 0, stdout: '    1 /sbin/init\n 4242 /opt/llama/llama-server -m a.gguf\n' }) }), [{ pid: 1, name: 'init', cmd: '/sbin/init' }, { pid: 4242, name: 'llama-server', cmd: '/opt/llama/llama-server -m a.gguf' }])
  assert.equal(processList({ platform: 'win32', run: () => ({ status: 1, stdout: '' }) }), null, 'a list that cannot be read is said to be unknown')
  assert.equal(processList({ platform: 'linux', run: () => ({ status: 1, stdout: '' }) }), null)
  // A listening socket's far end is 0.0.0.0:0 whatever language Windows words its state in.
  const netstat = '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:3080         127.0.0.1:51000        ESTABLISHED     900\r\n  TCP    127.0.0.1:3080         0.0.0.0:0              ABH\u00d6REN         4711\r\n'
  assert.equal(portOwner(3080, { platform: 'win32', run: () => ({ status: 0, stdout: netstat }) }), 4711)
  assert.equal(portOwner(3081, { platform: 'win32', run: () => ({ status: 0, stdout: netstat }) }), null)
  assert.equal(portOwner(3080, { platform: 'linux', run: () => ({ status: 0, stdout: 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=4712,fd=21))\n' }) }), 4712)
  assert.equal(portOwner(3080, { platform: 'linux', run: () => ({ status: 1, stdout: '' }) }), null)
})

test('Ctrl+C before any model is loaded ends the run there, loads nothing and says so in the history', async () => {
  const w = world({ installed: ['big'] })
  const interrupts = new EventEmitter()
  // Pressed while the hand-placed file is hashed, which can take a while for a real model.
  const code = await w.run([], { interrupts, onPrint: (line) => { if (/^Checking the SHA256/.test(line)) interrupts.emit('interrupt') } })
  assert.equal(code, EXIT.cancelled)
  assert.equal(w.server.started.length, 0, 'no llama-server was started')
  assert.match(w.err.at(-1), /^Cancelled with Ctrl\+C before any model was loaded\.$/)
  assert.match(history(w.data), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: did not run\. Cancelled with Ctrl\+C before any model was loaded\.\n\n$/)
  assert.ok(!existsSync(join(w.data, 'speed-runs', LOCK)), 'the lock is given back')
})

test('one Speed-Run at a time: a live holder of the lock refuses the run with exit 3, and a lock a crash left is taken over', async () => {
  const w = world()
  mkdirSync(join(w.data, 'speed-runs'), { recursive: true })
  writeFileSync(join(w.data, 'speed-runs', LOCK), '4242')
  assert.equal(await w.run([], { seams: { holds: async (pid) => pid === 4242 } }), EXIT.kzhRunning)
  assert.match(w.err.at(-1), /^Another speed run is going \(Speed-Run\.bat, pid 4242\)\. Let it finish, or end it, and run this again\.$/)
  assert.equal(w.server.started.length, 0)
  assert.equal(readFileSync(join(w.data, 'speed-runs', LOCK), 'utf8'), '4242', 'another run\'s lock is left alone')
  // The holder is gone (or its pid now names another program): the lock is taken over, and given back at the end.
  assert.equal(await w.run([], { seams: { holds: async () => false } }), EXIT.measured, w.err.join('\n'))
  assert.ok(!existsSync(join(w.data, 'speed-runs', LOCK)))
})

test('its console closed mid-run: the history says so, with the detail log, and the lock is given back before the exit', async () => {
  const server = fakeLlamaServer({ report: () => SPLIT })
  const w = world({ server })
  const held = server.hold((e) => e.body?.n_predict === 128)
  const interrupts = new EventEmitter()
  const running = w.run([], { interrupts })
  await held.arrived
  for (let i = 0; i < 100 && !w.out.some((l) => /timed request 1 of 3/.test(l)); i++) await new Promise((r) => setTimeout(r, 20))
  // What the script's SIGHUP handler does before process.exit, which runs local.js's exit hook.
  interrupts.emit('ended', 'SIGHUP')
  assert.match(history(w.data), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: ended by SIGHUP while it measured \(its console was closed, or it was stopped\)\. Readings already taken are kept\.\n {2}Details: speed-run-[\dT-]+Z\.log\n\n$/)
  assert.ok(!existsSync(join(w.data, 'speed-runs', LOCK)))
  interrupts.emit('interrupt')
  assert.equal(await running, EXIT.cancelled)
})

test('a model whose file does not match the manifest is named as not measured, so a scheduled check exits 1, and the others are measured', async () => {
  const w = world({ installed: ['big'] })
  writeFileSync(join(w.harness, 'models', 'small.gguf'), 'not small')
  assert.equal(await w.run(), EXIT.notMeasured, w.err.join('\n'))
  const text = w.out.join('\n')
  assert.match(text, /Measuring Big: a warm-up/)
  assert.ok(w.out.includes("NO  Small not measured: its file does not match the manifest's SHA256; install it again (type /install-llm small)"), text)
  assert.match(text, /OK  Big: /)
  assert.match(text, /^Small\s+not measured\s/m)
  assert.match(history(w.data), /: 1 of 2 measured\n.*\n  Small  not measured: its file does not match the manifest's SHA256; install it again \(type \/install-llm small\)\n  Big    [\d.]+ tokens\/s generating/)
  // Named, it is refused with the same why.
  assert.equal(await w.run(['--models', 'small']), EXIT.couldNotRun)
  assert.match(w.err.at(-1), /^Small cannot be measured: its file does not match the manifest's SHA256; install it again \(type \/install-llm small\)\.\nInstall in KzH/)
})

test('Ctrl+C cancels as the card\'s Cancel does: the engine is put back, readings already taken are kept, and the run exits 130', async () => {
  const server = fakeLlamaServer({ report: () => SPLIT })
  const w = world({ installed: ['big', 'small'], server })
  // Hold Small's first measured request, then press Ctrl+C.
  const held = server.hold((e) => e.model === 'small' && e.body?.n_predict === 128)
  const interrupts = new EventEmitter()
  const running = w.run([], { interrupts })
  await held.arrived
  // The poll has seen the request held: the phase line is there before Ctrl+C.
  for (let i = 0; i < 100 && !w.out.some((l) => /\[2\/2\] Small: timed request 1 of 3/.test(l)); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(w.out.includes('     [2/2] Small: timed request 1 of 3'), w.out.join('\n'))
  interrupts.emit('interrupt')
  assert.equal(await running, EXIT.cancelled)
  const text = w.out.join('\n')
  assert.match(text, /Cancelling: the request in flight is stopped/)
  assert.match(text, /OK  Big: /)
  assert.match(text, /NO  Small not measured: cancelled/)
  assert.match(text, /Stopped\. Readings already taken are kept; the engine is stopped again, as it was before\./)
  const s = JSON.parse(readFileSync(join(w.data, 'local.json'), 'utf8'))
  assert.deepEqual(Object.keys(s.speed), ['big@16384'])
  assert.match(history(w.data), /: 1 of 2 measured, stopped\n.*\n  Big    [\d.]+ tokens\/s generating.*\n  Small  not measured: cancelled\n  Stopped\. Readings already taken are kept; the engine is stopped again, as it was before\.\n/)
  assert.ok(server.started.every((x) => x.child.exitCode !== null), 'no llama-server is left running')
})

test('arguments: --models takes a list, --context a plugin-config context, anything else is refused with the usage', () => {
  assert.deepEqual(parseArgs(['--models', 'qwen3-8b, gemma4-e4b', '--context', '16384', '--no-pause']).models, ['qwen3-8b', 'gemma4-e4b'])
  assert.equal(parseArgs(['--context', '24576']).context, 24576)
  assert.throws(() => parseArgs(['--context', '1000']), /2048 or more/)
  assert.throws(() => parseArgs(['--models']), /--models needs a value/)
  assert.throws(() => parseArgs(['--models', ',']), /at least one model id/)
  assert.throws(() => parseArgs(['--fast']), /unknown argument --fast\nusage:/)
  // PowerShell hands `--models a,b` to a .bat as two words.
  assert.deepEqual(parseArgs(['--models', 'qwen3-8b', 'gemma4-e4b', '--verbose']), { models: ['qwen3-8b', 'gemma4-e4b'], context: undefined, harness: undefined, data: undefined, verbose: true, help: false })
})

test('the context comes from jev-router\'s local.contextSize in the profile, the home patch winning; a comment or another contextSize is not it, and one this cannot read refuses the run', async () => {
  // The block form, as config/cordis.patch.yml writes entries, and the one-line forms.
  assert.deepEqual(jevContextSize('- id: jev-router\n  config:\n    policy:\n      gateAtPercent: 80\n    local:\n      port: 8081\n      contextSize: 24576 # 24k\n- id: other\n  config:\n    local:\n      contextSize: 999\n'), { value: 24576 })
  assert.deepEqual(jevContextSize("- id: 'jev-router'\n  config:\n    local: { port: 8081, contextSize: 20480 }\n"), { value: 20480 })
  assert.deepEqual(jevContextSize('- id: jev-router\n  config: { local: { contextSize: 18432 } }\n'), { value: 18432 })
  // Not jev-router's local.contextSize: another plugin's, an agent's, a comment, a line commented out.
  assert.equal(jevContextSize('- id: other\n  config:\n    local:\n      contextSize: 999\n'), null)
  assert.equal(jevContextSize('- id: jev-router\n  config:\n    agents:\n      qwen-local:\n        llm:\n          contextSize: 8192\n'), null)
  assert.equal(jevContextSize('# contextSize: see below\n- id: jev-router\n  config:\n    local:\n      # contextSize: 24576\n      port: 8081\n'), null)
  // Given, in a form this cannot read.
  assert.deepEqual(jevContextSize('- id: jev-router\n  config:\n    local:\n      contextSize: 24k\n'), { unreadable: true })
  assert.deepEqual(jevContextSize('- id: jev-router\n  config:\n    local: !include local.yml\n'), { unreadable: true })
  const home = mkdtempSync(join(tmpdir(), 'kz-speedrun-home-'))
  made.push(home)
  assert.equal(profileContext(home), null)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: jev-router\n  config:\n    local:\n      contextSize: 24576\n')
  assert.deepEqual(profileContext(home), { value: 24576, file: join(home, 'profiles', 'web', 'cordis.patch.yml') })
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: jev-router\n  config:\n    local:\n      contextSize: 20480\n')
  assert.deepEqual(profileContext(home), { value: 20480, file: join(home, 'cordis.patch.yml') }, 'the home patch is laid over the profile\'s')
  writeFileSync(join(home, 'cordis.patch.yml'), '# contextSize: see the profile\n- id: other\n  config:\n    contextSize: 1\n')
  assert.deepEqual(profileContext(home), { value: 24576, file: join(home, 'profiles', 'web', 'cordis.patch.yml') }, 'a patch that gives none leaves the other\'s standing')

  // A run: the reading is taken and kept at the profile's context, where KzH will look for it.
  const w = world()
  mkdirSync(join(w.root, 'home', 'profiles', 'web'), { recursive: true })
  writeFileSync(join(w.root, 'home', 'profiles', 'web', 'cordis.patch.yml'), '- id: jev-router\n  config:\n    local:\n      contextSize: 20480\n')
  assert.equal(await w.run(), EXIT.measured, w.err.join('\n'))
  assert.ok(w.out.includes(`Context: 20480 tokens, jev-router's local.contextSize in ${join(w.root, 'home', 'profiles', 'web', 'cordis.patch.yml')}.`), w.out.join('\n'))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(w.data, 'local.json'), 'utf8')).speed), ['big@20480'])
  // --context says it outright and wins; one this cannot read refuses the run, with why in the history.
  assert.equal(await w.run(['--context', '16384']), EXIT.measured)
  assert.ok(JSON.parse(readFileSync(join(w.data, 'local.json'), 'utf8')).speed['big@16384'])
  writeFileSync(join(w.root, 'home', 'cordis.patch.yml'), '- id: jev-router\n  config:\n    local: !include local.yml\n')
  assert.equal(await w.run(), EXIT.couldNotRun)
  assert.match(w.err.at(-1), /cordis\.patch\.yml gives jev-router's local\.contextSize in a form this cannot read\. Run this again with --context <the number KzH starts local models with>/)
  assert.match(history(w.data), /Speed-Run\.bat: did not run\. .*cordis\.patch\.yml gives jev-router's local\.contextSize in a form this cannot read/)
})

test('a bad argument, or anything unforeseen, is written in the history too, since a scheduled run shows nobody its console', async () => {
  const w = world()
  const err = []
  assert.equal(await main(['--data', w.data, '--model', 'qwen3-8b', '--no-pause'], { print: () => {}, fail: (s) => err.push(s) }), EXIT.couldNotRun)
  assert.match(err.at(-1), /^unknown argument --model\nusage:/)
  assert.match(history(w.data), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: did not run\. unknown argument --model\n\n$/)
  // Something nobody foresaw: its first line in the history, the whole of it on the console.
  writeFileSync(join(w.data, 'local.json'), '{ not json')
  const code = await w.run()
  assert.equal(code, EXIT.couldNotRun)
  assert.match(w.err.at(-1), /^speed-run: .*JSON.*\n\s+at /s)
  assert.match(history(w.data), /Speed-Run\.bat: did not run\. speed-run: .*JSON[^\n]*\n\n$/)
})

test('Ctrl+C once every model is done cancels nothing, and a second Ctrl+C mid-run lets the run end itself before anything is stopped', async () => {
  const w = world()
  const interrupts = new EventEmitter()
  const code = await w.run([], { interrupts, onPrint: (line) => { if (/^The engine is stopped again/.test(line)) interrupts.emit('interrupt') } })
  assert.equal(code, EXIT.measured, 'a complete run is reported as one')
  assert.ok(w.out.includes('The run has ended; there is nothing to cancel.'))
  assert.match(history(w.data), /: 1 of 1 measured\n/)

  const server = fakeLlamaServer({ report: () => SPLIT })
  const v = world({ server })
  const held = server.hold((e) => e.body?.n_predict === 128)
  const twice = new EventEmitter()
  const running = v.run([], { interrupts: twice })
  await held.arrived
  twice.emit('interrupt')
  twice.emit('interrupt')
  assert.equal(await running, EXIT.cancelled)
  assert.ok(v.out.includes('Stopping at once.'))
  // The run ended itself: its history says the engine was stopped, never that KzH closed.
  assert.match(history(v.data), /: 0 of 1 measured, stopped\n.*\n {2}Big {2}not measured: cancelled\n {2}Stopped\. Readings already taken are kept; the engine is stopped again, as it was before\.\n/)
  assert.doesNotMatch(history(v.data), /KzH closed/)
  assert.ok(v.out.includes('No speed reading was saved.'))
})

test('a speed run log that cannot be written is said, and its paths are not given as if they held the run', async () => {
  const w = world()
  // A file where local.js would write the run's logs (the lock's folder stays writable).
  const blocked = join(w.root, 'blocked')
  writeFileSync(blocked, 'in the way')
  assert.equal(await w.run([], { seams: { localModels: { spawn: w.server.spawn, fetch: w.server.fetch, port: 0, speedLogDir: blocked } } }), EXIT.measured, w.err.join('\n'))
  const text = w.out.join('\n')
  assert.match(text, /\n1 speed reading saved in local\.json, where KzH reads them\.\nThe speed run log could not be written: [^\n]*blocked: (EEXIST|ENOTDIR)\. This run is not in it, or not all of it\.$/)
  assert.doesNotMatch(text, /Every speed run on this PC|This run in detail/)
})

test('the table lines its columns up in plain ASCII', () => {
  const t = table([
    { name: 'Qwen3 8B', ok: true, ctx: 16384, reading: { tokensPerSec: 71.26, promptTokensPerSec: 2210.4, layersOnGpu: { gpu: 37, total: 37 }, loadMs: 4200, threads: 4 }, memory: { vramGB: 6.1, ramGB: 0.4 } },
    { name: 'Gemma 4 E4B', ok: false, ctx: null, reading: null, memory: null },
  ])
  assert.equal(t, [
    'Model        Generate tok/s  Read tok/s  Context  GPU layers  VRAM GB  RAM GB  Load s  Threads',
    '-----------  --------------  ----------  -------  ----------  -------  ------  ------  -------',
    'Qwen3 8B     71.3            2210        16k      37/37       6.1      0.4     4.2     4',
    'Gemma 4 E4B  not measured    -           -        -           -        -       -       -',
  ].join('\n'))
  assert.ok(/^[\x20-\x7e\n]*$/.test(t))
})

test('Speed-Run.bat runs the script from the harness it sits in, in plain ASCII with CRLF line ends, and passes its exit code on', () => {
  const bat = readFileSync(BAT, 'latin1')
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(bat), 'ASCII only: cmd.exe reads a .bat in the console code page')
  assert.ok(bat.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'every line ends in CRLF')
  assert.match(bat, /node "%~dp0scripts\\speed-run\.mjs" %\*/)
  // cmd.exe's null device is NUL: a Unix redirect there fails when C:\dev does not exist, the
  // command does not run and its errorlevel is not 0, so every run would say Node.js is missing.
  assert.doesNotMatch(bat, /\/dev\//, 'no Unix redirect')
  assert.match(bat, /^where node >nul 2>nul \|\| \(/m)
  // --no-pause read word by word, with no pipe for an & or a | in the arguments to break.
  assert.match(bat, /^for %%a in \(%\*\) do if \/i "%%~a"=="--no-pause" set pause=0\r$/m)
  assert.match(bat, /^if "%pause%"=="1" pause\r$/m)
  assert.match(bat, /exit \/b %code%/i)
})
