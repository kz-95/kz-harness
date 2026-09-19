// Lets the Codex connector take a per-run effort level and speed ("1.5x") from
// jev-router. DSH's Codex executor sends neither to Codex's turn/start, so this
// adds two lines there. Runs on every start (Start-KzH.ps1) because reinstalling
// the connector replaces the file; it is a no-op once applied, and if the code no
// longer matches it only warns: Codex then runs at its own configured effort.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'),
  'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-subagent-codex', 'lib', 'index.js')
if (!existsSync(file)) process.exit(0)
const src = readFileSync(file, 'utf8')
if (src.includes('KZ_CODEX_EFFORT')) process.exit(0)

const anchor = /(this\.transport\.request\("turn\/start", \{\r?\n(\s*)threadId,\r?\n)/
const m = src.match(anchor)
if (!m) {
  console.warn('patch-codex-effort: Codex connector changed; effort/speed levels will not reach Codex (it uses its own settings).')
  process.exit(0)
}
const nl = src.includes('\r\n') ? '\r\n' : '\n'
const pad = m[2]
const add = [
  `${pad}// Kz-harness patch: per-run effort / 1.5x speed set by jev-router just before start.`,
  `${pad}...process.env.KZ_CODEX_EFFORT ? { effort: process.env.KZ_CODEX_EFFORT } : {},`,
  `${pad}...process.env.KZ_CODEX_SERVICE_TIER ? { serviceTier: process.env.KZ_CODEX_SERVICE_TIER } : {},`,
].join(nl) + nl
writeFileSync(file, src.replace(anchor, `$1${add}`))
console.log('patch-codex-effort: applied')
