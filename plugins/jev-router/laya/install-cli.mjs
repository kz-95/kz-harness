// Installs, updates, repairs or removes Laya from the command line (docs/laya-auto.md 7.2), for
// `Install-Harness.ps1 -Laya`:
//
//   node plugins/jev-router/laya/install-cli.mjs install [--gpu | --cpu] | update | repair | remove | recover
//
// The same laya-install.js the Settings card runs, so nothing of it is copied into PowerShell. It
// refuses while Kz-harness is running, because it cannot stop the app's own Laya, whose interpreter
// holds the venv's files open, and the app's card is the place to install from then. What runs is
// looked up as the speed run looks it up (kzh-running.js), so the refusal says how to stop it: the
// app from its tray icon, an engine with no app above it where it runs, and a program on the
// engine's port that cannot be told from it by closing whichever it is. Another program there, by
// a command line that can be read and is not the engine, or a name that is not node, does not stop
// the install. Without --gpu or --cpu it installs for the GPU when the NVIDIA driver reports a CUDA
// version, else for the CPU. The data folder is DSH_HOME's jev-router, DSH_HOME being ~/.kzh when
// it is not set, as Start-KzH.ps1 sets it for KzH: a run by hand reads KzH's own sidecar.json.
import { realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUIT_APP, kzhRunning, otherNote, portOwner, processList, stopEngine, stopUnknown } from '../kzh-running.js'
import { createLayaInstaller, readPins } from '../laya-install.js'
import { createLayaSidecar } from '../laya-sidecar.js'
import { createProbe } from '../laya-selfcheck.js'
import { detectSpecs } from '../local.js'

const HARNESS = fileURLToPath(new URL('../../../', import.meta.url))
const FROM_SETTINGS = 'install Laya from Settings → Jev setup → Laya decision model'
/** Why the install must wait for what kzhRunning() found on `port`, or null when it need not. */
export function harnessRunning(found, port = 3080) {
  if (found.app) return `Quit Kz-harness first (${QUIT_APP}), or ${FROM_SETTINGS}.`
  if (found.engine) return `Kz-harness's engine is running (${found.engine.name}, pid ${found.engine.pid}) with no Kz-harness app above it. To stop it, ${stopEngine(found.engine.pid)}, and run this again; or start Kz-harness and ${FROM_SETTINGS}.`
  if (found.unknown) return `Something answers on 127.0.0.1:${port} (${found.unknown}), and this cannot tell whether it is Kz-harness. ${stopUnknown(found, 'Kz-harness')}. Then run this again, or ${FROM_SETTINGS}.`
  return null
}
const USAGE = 'usage: node plugins/jev-router/laya/install-cli.mjs install [--gpu | --cpu] | update | repair | remove | recover'

/** Whether something answers on a local TCP port: the DSH engine, when Kz-harness is running. */
export function answers(port, { timeoutMs = 1000 } = {}) {
  return new Promise((done) => {
    const s = createConnection({ host: '127.0.0.1', port })
    const end = (v) => { s.destroy(); done(v) }
    s.setTimeout(timeoutMs, () => end(false))
    s.once('connect', () => end(true))
    s.once('error', () => end(false))
  })
}

/**
 * The command line, as a function the tests call. Resolves the exit code: 0 done, 1 refused or
 * failed, 2 a usage error.
 */
export async function main(argv, {
  harnessDir = HARNESS, dataDir = join(process.env.DSH_HOME?.trim() || join(homedir(), '.kzh'), 'jev-router'),
  enginePort = 3080, out = (l) => console.log(l), err = (l) => console.error(l), installer: given, sidecar: givenSidecar, specs,
  processes = processList, owner = portOwner,
} = {}) {
  const [command, ...flags] = argv
  if (!['install', 'update', 'repair', 'remove', 'recover'].includes(command) || flags.some((f) => !['--gpu', '--cpu'].includes(f)) || (command !== 'install' && flags.length)) {
    err(USAGE)
    return 2
  }
  const found = await kzhRunning({ port: enginePort, answers, processes, owner })
  const running = harnessRunning(found, enginePort)
  if (running) {
    err(running)
    return 1
  }
  if (found.other) out(`   note: ${otherNote(found, { port: enginePort, kzh: 'Kz-harness', what: 'the install' })}`)
  const readSpecs = specs ?? (() => detectSpecs({ dir: join(harnessDir, 'models') }))
  let installer = given
  let sidecar = givenSidecar
  if (!installer) {
    const pins = readPins(harnessDir)
    const log = (l) => out(`   ${l.replace(/^laya install: /, '')}`)
    // Not started: here for the sweep below and the install's step 7, the real start from venv.new.
    sidecar = createLayaSidecar({ harnessDir, dataDir, config: {}, pins, specs: readSpecs, probe: (conn) => createProbe(conn), log })
    installer = createLayaInstaller({ harnessDir, dataDir, pins, specs: readSpecs, sidecar, log })
  }
  // No KzH runs (above), so a laya.serve sidecar.json still records is one an earlier session left
  // (docs/laya-auto.md 7.5), unless another installer holds install.lock, whose check the sweep
  // leaves alone. It is stopped first, as KzH's own start does, and its log line says so: it holds
  // the venv's files open. One that is alive but could not be checked (run as administrator) is kept
  // on record and named, and nothing runs beside it, since it would hold those files.
  await sidecar?.sweepOrphans()?.catch((e) => out(`   note: a Laya an earlier session left running could not be looked for (${e.message}).`))
  const unchecked = sidecar?.status?.().orphansUnchecked ?? []
  if (unchecked.length) {
    err(`Laya ${command} did not run: a Laya an earlier session left may still be running (pid ${unchecked.join(', ')}) and would hold the files this changes. Stop it as said above, then run this again.`)
    return 1
  }
  try {
    if (command === 'recover') { out(`ok: ${(await installer.recover()) ?? 'nothing to recover'}`); return 0 }
    const device = flags.includes('--cpu') ? 'cpu' : flags.includes('--gpu') ? 'gpu' : ((await readSpecs().catch(() => null))?.cuda ? 'gpu' : 'cpu')
    await installer.recover()
    const run = { install: () => installer.install({ device }), update: () => installer.update(), repair: () => installer.repair(), remove: () => installer.remove() }[command]
    const got = await run()
    const job = installer.status().job
    for (const note of job?.notes ?? []) out(`   note: ${note}`)
    if (command === 'install' || command === 'update') out(`ok: Laya ${got.laya} installed (${got.cuda ? `for the GPU, ${got.torchIndex}` : 'for the CPU'}).`)
    else out(`ok: ${job?.lines?.at(-1) ?? command}`)
    return 0
  } catch (e) {
    const job = installer.status().job
    err(job?.failedStep ? `Laya ${command} failed at step ${job.failedStep} (${job.failedName}): ${e.message}` : `Laya ${command} failed: ${e.message}`)
    if (job?.offerCpu) err('Run it again with --cpu to install for the CPU instead.')
    return 1
  }
}

/** Whether node was asked to run this file (by its real path, as Windows junctions and symlinks differ). */
function invokedDirectly() {
  try {
    const given = realpathSync(process.argv[1] ?? '')
    const self = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32' ? given.toLowerCase() === self.toLowerCase() : given === self
  } catch { return false }
}

if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2))
