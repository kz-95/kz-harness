// Makes sure DSH lists the workspaces KzH keeps of its own, before DSH starts, so DSH never has the
// file open (Start-KzH.ps1 runs this):
//   - "No project" (<harness>/no-project), for plain chat: messages there are answered directly, no
//     agent touches files;
//   - "KzH scratch" (kzh-scratch beside the harness folder), where the capability benchmark runs its
//     tasks (docs/benchmark.md 3.7). It must be outside every git repository, or an agent working
//     there would take that repository for its project; when one holds it, it is not added, and the
//     benchmark's routes say why.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NO_PROJECT_README = '# No project\n\nKz-harness chat space. Messages in this workspace are answered directly; no agent reads or changes files here.\n'
export const SCRATCH_README = 'Scratch space. KzH creates and deletes folders here; keep nothing of yours in it.\n'

/** The KzH scratch workspace of a harness: kzh-scratch beside the harness folder. */
export const scratchRootOf = (harnessDir) => resolve(harnessDir, '..', 'kzh-scratch')

/** The git repository `dir` is inside, from the nearest folder that exists, or null when there is none. */
export function gitTopOf(dir) {
  let at = resolve(dir)
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return top ? resolve(top) : null
  } catch {
    return null
  }
}

/**
 * Adds a workspace to DSH's workspace store (storages/workspace.json) unless one with its folder is
 * listed already. Returns what it did: 'added'; 'listed', also when DSH has made no store yet (its
 * first start makes one, and the next start of KzH adds the entry); or why it could not.
 */
function addWorkspace(file, dir, title) {
  let store
  try { store = JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
    // DSH creates it on first run; the next start adds the entry, so there is nothing to say.
    return err.code === 'ENOENT' ? 'listed' : `cannot read ${file}: ${err.message}`
  }
  const table = store.tables?.workspaces
  if (!table || !store.global?.workspaceIds) return 'unexpected workspace.json shape; skipped'
  const same = (p) => resolve(p).toLowerCase() === dir.toLowerCase()
  if (Object.values(table).some((w) => same(w.path ?? ''))) return 'listed'
  const id = randomUUID()
  const now = new Date().toISOString()
  table[id] = { path: dir, title, sessionIds: [], createdAt: now, updatedAt: now }
  store.global.workspaceIds.push(id)
  writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2))
  renameSync(`${file}.tmp`, file)
  return 'added'
}

/**
 * Makes both folders and lists them in DSH, the scratch workspace only when no git repository holds
 * it. `harnessDir` is the harness folder, `dshHome` DSH's home. Returns one line per workspace.
 */
export function ensureWorkspaces({ harnessDir, dshHome }) {
  const file = join(dshHome, 'storages', 'workspace.json')
  const lines = []
  const noProject = resolve(harnessDir, 'no-project')
  mkdirSync(noProject, { recursive: true })
  writeFileSync(join(noProject, 'README.md'), NO_PROJECT_README, { flag: 'w' })
  const listed = addWorkspace(file, noProject, 'No project')
  lines.push(listed === 'added' ? `no-project: added workspace ${noProject}` : listed === 'listed' ? null : `no-project: ${listed}`)
  const scratch = scratchRootOf(harnessDir)
  const top = gitTopOf(scratch)
  if (top) {
    lines.push(`kzh-scratch: not added: ${scratch} is inside the git repository ${top}, where an agent would take that repository for its project`)
  } else {
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'README.md'), SCRATCH_README, { flag: 'w' })
    const added = addWorkspace(file, scratch, 'KzH scratch')
    lines.push(added === 'added' ? `kzh-scratch: added workspace ${scratch}` : added === 'listed' ? null : `kzh-scratch: ${added}`)
  }
  return lines.filter(Boolean)
}

/**
 * Whether node was asked to run this file, rather than a test importing it. Node gives the main
 * module its real path, so the path it was asked for is compared by its real path too: a harness
 * folder reached through a link (a junction on Windows) is still this file. Case does not count on
 * Windows.
 */
function runAsScript(self = fileURLToPath(import.meta.url)) {
  if (!process.argv[1]) return false
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const [a, b] = [real(process.argv[1]), real(self)]
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

if (runAsScript()) {
  const harnessDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (const line of ensureWorkspaces({ harnessDir, dshHome: process.env.DSH_HOME || join(homedir(), '.dsh') })) console.log(line)
} else if (basename(process.argv[1] ?? '') === basename(fileURLToPath(import.meta.url))) {
  // Asked for by its name, yet not found to be this file: said, never a silent start with nothing listed.
  console.error(`ensure-no-project: ${process.argv[1]} did not resolve to ${fileURLToPath(import.meta.url)}, so no workspace was listed`)
}
