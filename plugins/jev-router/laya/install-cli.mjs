// Installs, updates, repairs or removes Laya from the command line (docs/laya-auto.md 7.2), for
// `Install-Harness.ps1 -Laya`:
//
//   node plugins/jev-router/laya/install-cli.mjs install [--gpu | --cpu] | update | repair | remove | recover
//
// The same laya-install.js the Settings card runs, so nothing of it is copied into PowerShell. It
// refuses while Kz-harness is running (its DSH engine answers on 127.0.0.1:3080), because it cannot
// stop the app's own Laya, whose interpreter holds the venv's files open, and the app's card is the
// place to install from then. Without --gpu or --cpu it installs for the GPU when the NVIDIA driver
// reports a CUDA version, else for the CPU. The data folder is DSH_HOME's jev-router, as the plugin's.
import { realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLayaInstaller, readPins } from '../laya-install.js'
import { createLayaSidecar } from '../laya-sidecar.js'
import { createProbe } from '../laya-selfcheck.js'
import { detectSpecs } from '../local.js'

const HARNESS = fileURLToPath(new URL('../../../', import.meta.url))
export const HARNESS_RUNNING = 'Close Kz-harness first, or install Laya from Settings → Jev setup → Laya decision model.'
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
  harnessDir = HARNESS, dataDir = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'jev-router'),
  enginePort = 3080, out = (l) => console.log(l), err = (l) => console.error(l), installer: given, specs,
} = {}) {
  const [command, ...flags] = argv
  if (!['install', 'update', 'repair', 'remove', 'recover'].includes(command) || flags.some((f) => !['--gpu', '--cpu'].includes(f)) || (command !== 'install' && flags.length)) {
    err(USAGE)
    return 2
  }
  if (await answers(enginePort)) {
    err(HARNESS_RUNNING)
    return 1
  }
  const readSpecs = specs ?? (() => detectSpecs({ dir: join(harnessDir, 'models') }))
  let installer = given
  if (!installer) {
    const pins = readPins(harnessDir)
    const log = (l) => out(`   ${l.replace(/^laya install: /, '')}`)
    // Not started: here only for the install's step 7, the real start from venv.new.
    const sidecar = createLayaSidecar({ harnessDir, dataDir, config: {}, pins, specs: readSpecs, probe: (conn) => createProbe(conn), log })
    installer = createLayaInstaller({ harnessDir, dataDir, pins, specs: readSpecs, sidecar, log })
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
