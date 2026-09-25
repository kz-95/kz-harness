// The end-to-end check against the real laya.serve (docs/laya-auto.md 9.4), run by hand:
//   KZH_LAYA_E2E=1 KZH_LAYA_HARNESS=<dir> node plugins/jev-router/test/e2e/laya.e2e.mjs
// <dir> is a harness laid out as the installer leaves one: engine/laya/venv with laya and torch,
// engine/laya/installed.json, models/laya/hf holding a planted snapshot of convaiinnovations/laya,
// config/ and plugins/ (links to this repo will do). The cloud cannot download Laya's weights, so
// the snapshot there holds random weights at the real English architecture: every answer is
// meaningless, and this proves the rest, being the real process, protocol, supervision, deadlines
// and memory, through KzH's own supervisor and client. It is outside test/*.test.js, so npm test
// never runs it. It writes what it measured to e2e-report.json in the data folder.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJev } from '../../jev.js'
import { createLayaClient } from '../../laya-client.js'
import { layaPaths, readPins, recordWeights } from '../../laya-install.js'
import { createLayaSidecar } from '../../laya-sidecar.js'
import { createProbe } from '../../laya-selfcheck.js'
import { resolveProviders } from '../../providers.js'

if (process.env.KZH_LAYA_E2E !== '1') { console.log('skipped: set KZH_LAYA_E2E=1 to run against a real laya.serve'); process.exit(0) }
const harnessDir = process.env.KZH_LAYA_HARNESS
assert.ok(harnessDir && existsSync(join(harnessDir, 'engine', 'laya', 'installed.json')), 'KZH_LAYA_HARNESS names an installed harness')
const dataDir = process.env.KZH_LAYA_DATA ?? join(harnessDir, '..', 'data')
mkdirSync(dataDir, { recursive: true })

const bodies = JSON.parse(readFileSync(new URL('../fixtures/kzh-bodies.json', import.meta.url), 'utf8'))
const report = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`ok  ${name}  ${JSON.stringify(data)}`) }
const lines = []

// --- 1. the weights, recorded after a load, as the installer records them (7.3) ---
const paths = layaPaths({ harnessDir, dataDir })
const hub = join(paths.hf, 'hub', 'models--convaiinnovations--laya')
const commit = readFileSync(join(hub, 'refs', 'main'), 'utf8').trim()
assert.ok(existsSync(join(hub, 'snapshots', commit, 'model.safetensors')), 'the planted snapshot is complete')
if (!existsSync(paths.weights)) await recordWeights(paths, { repo: 'convaiinnovations/laya', commit, downloadedAt: Date.now(), loadedAt: Date.now() })
step('weights recorded', { commit })

// --- 2. the real supervisor starts the real laya.serve on the CPU ---
const { laya: LAYA, layaSettings } = resolveProviders({}, {})
const sidecar = createLayaSidecar({
  harnessDir, dataDir, config: { ...layaSettings, device: 'cpu' }, pins: readPins(harnessDir),
  probe: (conn) => createProbe(conn, { temperatureCorrections: layaSettings.temperatureCorrections, minTopMargin: layaSettings.minTopMargin }),
  log: (m) => lines.push(m),
})
let t0 = Date.now()
const conn = await sidecar.ensureReady()
const readyMs = Date.now() - t0
const st = sidecar.status()
assert.equal(st.state, 'ready')
assert.match(conn.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'laya.serve listens on the loopback only')
assert.equal(st.running?.device, 'cpu', 'laya.serve runs on the CPU here')
step('ready through the supervisor', { readyMs, device: st.running.device, threads: st.running.threads, ramGB: st.running.ramGB, url: conn.url, warnings: (st.warnings ?? []).map((w) => w.kind ?? w) })

// A wrong key is refused by laya.serve itself.
const wrong = await fetch(new URL('/v1/systemone', conn.url), { method: 'POST', headers: { authorization: 'Bearer not-the-key', 'content-type': 'application/json' }, body: JSON.stringify(bodies.intent) })
assert.equal(wrong.status, 401, 'a wrong key is refused')
step('wrong key refused', { status: wrong.status })

// --- 3. KzH's real bodies through the Laya client, the adapter and the gate ---
const client = createLayaClient({ sidecar, settings: layaSettings, log: (m) => lines.push(m) })
const act = client.client('act')
const timings = {}
for (const name of ['intent', 'resource', 'task', 'review']) {
  const b = bodies[name]
  t0 = Date.now()
  const answer = await act.systemOne({ state: b.state, questions: b.questions }, { phase: b.phase })
  const ms = Date.now() - t0
  const got = answer?.answers ?? answer
  const names = Object.keys(b.questions)
  for (const q of names) assert.ok(got?.[q], `${name}: ${q} was answered`)
  const flat = names.filter((q) => got[q]?.informative === false)
  timings[name] = ms
  step(`${name} call answered`, { questions: names.length, ms, flat: flat.length, model: answer?.model ?? null })
}

// --- 4. the same through createJev with Laya's record, the way a Laya Auto run asks ---
const jev = createJev({ provider: LAYA, client: act })
t0 = Date.now()
const intent = await jev.intent({ message: 'Rename the helper in utils.js and update its callers', context: {} })
step('createJev intent through Laya', { ms: Date.now() - t0, kind: intent?.kind ?? null, uninformative: intent?.uninformative ?? null })

// --- 5. supervision: the interpreter killed mid-call, the call fails with the reason, Laya comes back ---
const pid = sidecar.status().running?.interpreterPid
assert.ok(pid, 'the supervisor names the interpreter it runs')
{
  const pending = act.systemOne({ state: bodies.task.state, questions: bodies.task.questions }, { phase: 'route' }).then(() => 'answered', (err) => err)
  await new Promise((r) => setTimeout(r, 1500))
  try { process.kill(pid, 'SIGKILL') } catch {}
  const outcome = await pending
  const failed = outcome !== 'answered'
  t0 = Date.now()
  await sidecar.ensureReady()
  const again = await act.systemOne({ state: bodies.intent.state, questions: bodies.intent.questions }, { phase: 'intent' })
  assert.ok(failed, 'the call on the killed interpreter fails, with its reason')
  assert.notEqual(sidecar.status().running?.interpreterPid, pid, 'a new interpreter answers')
  step('killed mid-call and recovered', { reason: String(outcome?.message ?? outcome), recoveredMs: Date.now() - t0, answeredAfter: !!again, ramGB: sidecar.status().running?.ramGB })
}

report.status = sidecar.status()
report.counters = client.counters()
report.logTail = sidecar.logTail(60)
report.lines = lines.slice(-80)
report.timings = timings
writeFileSync(join(dataDir, 'e2e-report.json'), JSON.stringify(report, null, 2))
client.dispose()
await sidecar.dispose()
console.log(`done: report in ${join(dataDir, 'e2e-report.json')}`)
process.exit(0)
