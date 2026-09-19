// Makes sure DSH lists the "No project" workspace (<harness>/no-project), used for
// plain chat: messages there are answered directly, no agents touch files.
// Runs from Start-KzH.ps1 before DSH starts, so DSH never has the file open.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'no-project')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'README.md'), '# No project\n\nKz-harness chat space. Messages in this workspace are answered directly; no agent reads or changes files here.\n', { flag: 'w' })

const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'workspace.json')
let store
try { store = JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
  if (err.code === 'ENOENT') process.exit(0) // DSH creates it on first run; the next start adds the entry
  console.warn(`no-project: cannot read ${file}: ${err.message}`)
  process.exit(0)
}
const table = store.tables?.workspaces
if (!table || !store.global?.workspaceIds) { console.warn('no-project: unexpected workspace.json shape; skipped'); process.exit(0) }
const same = (p) => resolve(p).toLowerCase() === dir.toLowerCase()
if (Object.values(table).some((w) => same(w.path ?? ''))) process.exit(0)

const id = randomUUID()
const now = new Date().toISOString()
table[id] = { path: dir, title: 'No project', sessionIds: [], createdAt: now, updatedAt: now }
store.global.workspaceIds.push(id)
writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2))
renameSync(`${file}.tmp`, file)
console.log(`no-project: added workspace ${dir}`)
