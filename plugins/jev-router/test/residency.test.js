// The residency of local model processes and the one RAM budget they share (docs/laya-auto.md 7.7):
// who is unloaded when the sum is over the budget, who gives way when a local model starts, what a
// plan counts, and that a Laya start never stops llama.
import { createBudgetWatchdog, createResidency, victimOf } from '../residency.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLayaSidecar } from '../laya-sidecar.js'
import { layaPaths, readPins, recordWeights, snapshotDir } from '../laya-install.js'
import { createProbe } from '../laya-selfcheck.js'

const GIB = 1024 ** 3

/** A resident as local.js or laya-sidecar.js registers one, whose unload records why and leaves. */
function resident(res, id, { held = false, busy = false, keepWhileHeld = false, startedAt, ramGB = 1, vramGB = 0, name = id, pid } = {}) {
  const r = { id, held, busy, unloads: [] }
  r.entry = res.set(id, {
    pid: pid ?? 1000 + res.list().length, startedAt, device: 'cuda', name, keepWhileHeld, ramGB, vramGB,
    held: () => r.held, busy: () => r.busy,
    unload: async (why) => { r.unloads.push(why); res.clear(id, r.entry) },
  })
  return r
}

test('the watchdog\'s victim: a Laya nothing holds first, never a held Laya, then the newest resident that is not busy, else the newest', () => {
  const res = createResidency()
  const llama = resident(res, 'llama', { held: true, startedAt: 100 })
  const laya = resident(res, 'laya', { held: false, keepWhileHeld: true, startedAt: 50 })
  assert.equal(victimOf(res.list()).id, 'laya', 'older than llama, but nothing holds it')
  laya.held = true
  assert.equal(victimOf(res.list()).id, 'llama', 'a held Laya is never the victim; llama is, by the rule it always had')
  llama.busy = true
  assert.equal(victimOf(res.list()).id, 'llama', 'busy, but the only one left: the newest')
  // With two that may go, the newest that is not busy.
  const other = resident(res, 'other', { held: true, startedAt: 200 })
  other.busy = true
  llama.busy = false
  assert.equal(victimOf(res.list()).id, 'llama', 'the newest that is not busy')
  llama.busy = true
  assert.equal(victimOf(res.list()).id, 'other', 'all busy: the newest')
  laya.held = false
  assert.equal(victimOf(res.list()).id, 'laya', 'and an unheld Laya still goes before either')
})

test('the summed watchdog unloads only its victim, after 30 s over, and restarts the count on a missing reading or a resident coming or going', async () => {
  let clock = 0
  let budget = 5
  const res = createResidency()
  const rss = { 1: 3 * GIB, 2: 3 * GIB }
  const reads = []
  const logs = []
  const dog = createBudgetWatchdog({ residency: res, readSettings: async () => ({ maxRamGB: budget }), readWorkingSet: async (pid) => { reads.push(pid); return rss[pid] }, now: () => clock, log: (l) => logs.push(l) })
  await dog.check()
  assert.deepEqual(reads, [], 'nothing resident, nothing read')
  const llama = resident(res, 'llama', { held: true, startedAt: 1, pid: 1, name: 'qwen3-8b' })
  const laya = resident(res, 'laya', { held: false, keepWhileHeld: true, startedAt: 2, pid: 2, name: 'Laya' })
  await dog.check()
  assert.deepEqual(reads.sort(), [1, 2], 'every resident is read')
  assert.deepEqual([res.get('llama').workingSetGB, res.get('laya').workingSetGB], [3, 3], 'and the readings kept for the budget')
  clock += 20_000
  rss[2] = null
  await dog.check() // a reading that cannot be taken says nothing: the count starts again
  rss[2] = 3 * GIB
  await dog.check()
  clock += 29_000
  await dog.check()
  assert.deepEqual([llama.unloads, laya.unloads], [[], []], '29 s since the count started again')
  clock += 1_000
  await dog.check()
  assert.deepEqual(llama.unloads, [], 'only the resident unloaded is told, so llama is never marked tripped on Laya\'s account')
  assert.deepEqual(laya.unloads, [{ kind: 'budget', text: 'the local models together stayed over the 5 GB RAM budget for 30 s (last reading 6 GB: qwen3-8b 3 GB, Laya 3 GB)' }])
  assert.equal(res.get('laya'), null)

  // A resident coming while the sum is over starts the count again: the sum describes another set.
  rss[1] = 6 * GIB
  await dog.check()
  clock += 25_000
  resident(res, 'laya', { held: true, keepWhileHeld: true, startedAt: 3, pid: 2 })
  await dog.check()
  clock += 25_000
  await dog.check()
  assert.deepEqual(llama.unloads, [], '50 s over, but only 25 s with this set of residents')
  clock += 5_000
  await dog.check()
  assert.equal(llama.unloads.length, 1, 'the held Laya stays; llama goes')
  assert.match(llama.unloads[0].text, /^the local models together stayed over the 5 GB RAM budget for 30 s/)

  // No budget: nothing is read, and the readings go.
  budget = null
  reads.length = 0
  await dog.check()
  assert.deepEqual(reads, [])
  assert.equal(res.get('laya').workingSetGB, null)
  assert.deepEqual(logs, [])
})

test('the watchdog takes one reading at a time, and says so when every resident is held and none may go', async () => {
  let clock = 0
  const res = createResidency()
  const answers = []
  const logs = []
  const dog = createBudgetWatchdog({ residency: res, readSettings: async () => ({ maxRamGB: 1 }), readWorkingSet: () => new Promise((r) => answers.push(r)), now: () => clock, log: (l) => logs.push(l) })
  const laya = resident(res, 'laya', { held: true, keepWhileHeld: true, startedAt: 1, pid: 7 })
  const first = dog.check()
  assert.equal(dog.check(), first, 'a check while a reading is out joins it')
  await new Promise((r) => setImmediate(r))
  answers.shift()(2 * GIB)
  await first
  clock += 30_000
  const second = dog.check()
  await new Promise((r) => setImmediate(r))
  answers.shift()(2 * GIB)
  await second
  assert.deepEqual(laya.unloads, [], 'a held Laya is never unloaded for the budget')
  assert.deepEqual(logs, ['RAM watchdog: over the 1 GB RAM budget, and every resident is held'])
})

test('yieldFor unloads a Laya nothing holds and leaves a held or busy one; an unload that fails is logged and left out', async () => {
  const logs = []
  const res = createResidency({ log: (l) => logs.push(l) })
  const llama = resident(res, 'llama', { held: true, startedAt: 1 })
  const laya = resident(res, 'laya', { held: true, keepWhileHeld: true, startedAt: 2 })
  assert.deepEqual(await res.yieldFor('llama', { name: 'qwen3-8b' }), [], 'held: it stays')
  laya.held = false
  laya.busy = true
  assert.deepEqual(await res.yieldFor('llama', { name: 'qwen3-8b' }), [], 'an acting request is out: it stays')
  laya.busy = false
  assert.deepEqual(await res.yieldFor('llama', { name: 'qwen3-8b' }), ['laya'])
  assert.deepEqual(laya.unloads, [{ kind: 'yield', for: 'qwen3-8b', text: 'unloaded so qwen3-8b could have the GPU and RAM' }])
  assert.deepEqual(llama.unloads, [], 'the resident that asked is never unloaded for itself')
  // llama is always held, so nothing makes it give way.
  resident(res, 'laya', { held: false, keepWhileHeld: true, startedAt: 3 })
  assert.deepEqual(await res.yieldFor('laya'), [])
  res.set('broken', { pid: 9, startedAt: 4, name: 'broken', held: () => false, busy: () => false, unload: async () => { throw new Error('no such process') } })
  assert.deepEqual(await res.yieldFor('llama'), ['laya'])
  assert.deepEqual(logs, ['residency: broken did not unload for llama: no such process'])
})

test('what the others hold: RAM counts a watchdog reading over a declared figure, and a plan can count held residents only', () => {
  const res = createResidency()
  resident(res, 'llama', { held: true, startedAt: 1, ramGB: 2.5, vramGB: 2.1, name: 'qwen3-8b' })
  const laya = resident(res, 'laya', { held: false, keepWhileHeld: true, startedAt: 2, ramGB: () => 3.3, vramGB: () => 2.5, name: 'Laya' })
  assert.equal(res.othersRamGB('llama'), 3.3)
  assert.equal(res.othersRamGB('llama', { heldOnly: true }), 0, 'refuse-to-load subtracts held residents only')
  laya.held = true
  assert.equal(res.othersRamGB('llama', { heldOnly: true }), 3.3)
  assert.deepEqual(res.othersNames('llama', { heldOnly: true }), ['Laya'])
  assert.equal(res.othersRamGB('laya'), 2.5)
  assert.equal(res.othersVramGB('laya'), 2.1)
  res.get('llama').workingSetGB = 4.2
  assert.equal(res.othersRamGB('laya'), 4.2, 'a reading of what it really holds wins over its own figure')
  const g = res.generation()
  const e = res.get('llama')
  res.clear('llama', {})
  assert.equal(res.generation(), g, 'a clear for an entry since replaced changes nothing')
  res.clear('llama', e)
  assert.equal(res.generation(), g + 1)
  assert.equal(res.othersRamGB('laya'), 0)
})

// ---------- a Laya start never stops llama ----------

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-laya-serve.mjs', import.meta.url))

async function installedLaya() {
  const harnessDir = mkdtempSync(join(tmpdir(), 'laya-residency-'))
  const dataDir = join(harnessDir, 'data')
  const paths = layaPaths({ harnessDir, dataDir })
  const pins = readPins(REPO)
  mkdirSync(dirname(paths.pythonOf(paths.venv)), { recursive: true })
  writeFileSync(paths.pythonOf(paths.venv), '')
  writeFileSync(paths.installed, JSON.stringify({ laya: '0.3.20', torch: '2.14.0+cpu', cuda: false }))
  const commit = 'c'.repeat(40)
  const snap = snapshotDir(paths.hf, pins.weights.repo, commit)
  mkdirSync(snap, { recursive: true })
  writeFileSync(join(snap, 'model.safetensors'), 'weights')
  await recordWeights(paths, { repo: pins.weights.repo, commit, downloadedAt: 'then', loadedAt: 'then' })
  return { harnessDir, dataDir, pins }
}

test('a Laya start never stops llama: over the RAM budget it refuses, naming what is resident; within it, both stay', async (t) => {
  const res = createResidency()
  const llama = resident(res, 'llama', { held: true, startedAt: 1, ramGB: 6, name: 'qwen3-8b' })
  const h = await installedLaya()
  let budget = { maxRamGB: 8 }
  const spawned = []
  const sidecar = createLayaSidecar({
    ...h, config: { port: 20000 + Math.floor(Math.random() * 20000) }, residency: res, readBudget: async () => budget,
    probe: (conn) => createProbe(conn), specs: async () => ({ cpu: { cores: 4, threads: 8 } }),
    spawn: (cmd, args, opts) => { spawned.push(cmd); return nodeSpawn(process.execPath, [FAKE, ...args], opts) },
    timing: { readyPollMs: 50 },
  })
  t.after(() => sidecar.dispose())
  const refusal = 'Laya needs about 3.3 GB of RAM; the budget leaves 2 GB beside qwen3-8b. Stop the local model or raise the RAM budget.'
  await assert.rejects(sidecar.start(), { message: refusal })
  assert.deepEqual(llama.unloads, [], 'llama was not unloaded to make room')
  assert.equal(spawned.length, 0, 'refused before anything was started')
  assert.equal(sidecar.status().state, 'stopped', 'a refusal, not a failure: it starts once there is room (7.4)')
  assert.equal(sidecar.status().why, refusal)

  budget = { maxRamGB: 12 }
  await sidecar.start()
  assert.deepEqual(llama.unloads, [])
  assert.deepEqual(res.list().map((r) => r.id).sort(), ['laya', 'llama'], 'both resident')
  const laya = res.get('laya')
  assert.deepEqual([laya.held(), laya.keepWhileHeld, laya.busy()], [false, true, false], 'unheld until a hold, and busy only while an acting request raises it')
  sidecar.hold('run:1')
  assert.equal(laya.held(), true)
  sidecar.setPriority('normal')
  assert.equal(laya.busy(), true)
  sidecar.setPriority('below_normal')
  sidecar.release('run:1')
  // Given way to a starting local model, it says so and is gone from the residency.
  assert.deepEqual(await res.yieldFor('llama', { name: 'qwen3-8b' }), ['laya'])
  assert.equal(res.get('laya'), null)
  assert.deepEqual([sidecar.status().state, sidecar.status().stoppedBecause, sidecar.status().why], ['stopped', 'yielded', 'qwen3-8b'])
})
