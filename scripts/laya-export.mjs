// The one file the owner brings back from the desktop test (docs/laya-auto.md 5.4, 9.5 step 13).
//
//   node scripts/laya-export.mjs [--data <dir>] [--harness <dir>] [--out <dir>]
//
// It writes laya-export-<date>.json into --out (default the current folder) and prints what it
// holds: the shadow rows, both sample stores and the standings as they are (none of them holds
// text, 5.3 and 6.2), laya.json, installed.json and weights.json, the last 500 lines of
// laya-serve.log, and the history.jsonl records reduced to each run's id, time and final status,
// its routing labels and numbers, each attempt's agent, role and stop reason, and each review's
// mode and action. Nothing else of a record is copied: history.jsonl holds the task text as typed,
// workspace and file paths, the start of every answer and the review's reasons, and nothing
// redacts a key pasted into a task, so it is read field by field and never passed through whole.
// Every string of the export, whatever file it came from, goes through export.js redactSecrets.
//
// The data folder defaults to <DSH_HOME>/jev-router (DSH_HOME being ~/.kzh when unset), and the
// harness to the one this script is in. It exits 2 when it could not write the file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAsScript } from './run-as-script.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..', 'plugins', 'jev-router')
const plugin = (file) => import(pathToFileURL(join(PLUGIN, file)).href)

/** How many lines of laya-serve.log the export keeps, the newest. */
export const LOG_LINES = 500

export const defaultDataDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.kzh'), 'jev-router')

function readRows(file) {
  if (!existsSync(file)) return { rows: [], bad: 0, present: false }
  let bad = 0
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows, bad, present: true }
}
const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null } catch { return null } }

// --- a history record, reduced ------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const label = (v) => (typeof v === 'string' || v === null ? v : undefined)
const bool = (v) => (typeof v === 'boolean' ? v : undefined)
/** The fields of `o` that `pick` keeps, by kind, and none that came out undefined. */
function keep(o, pick) {
  if (!o || typeof o !== 'object') return undefined
  const out = {}
  for (const [k, as] of Object.entries(pick)) { const v = as(o[k]); if (v !== undefined) out[k] = v }
  return out
}
/** An object of numbers keyed by a label (probabilities, requirements), numbers only. */
const numbers = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => num(v) !== undefined)) : undefined)
const labels = (a) => (Array.isArray(a) ? a.filter((v) => typeof v === 'string') : undefined)

const ROUTING = {
  decider: label, mode: label, model: label, primaryAgent: label, conservedFrom: label, capability: label, taskType: label, handler: label, strategy: label, deciderDevice: label,
  agentConfidence: num, capabilityConfidence: num, taskTypeConfidence: num, complexity: num, risk: num, needsSecondOpinion: num, needsHumanReview: num, needsTests: num,
  continueHandoff: num, handlerConfidence: num, toolFits: num, toolArgConfidence: num, deciderMs: num,
  agentProbabilities: numbers,
}
const PROFILE = {
  taskType: label, capability: label, minimumCapability: label, preferredCapability: label,
  taskTypeConfidence: num, capabilityConfidence: num, minimumCapabilityConfidence: num, skillConfidence: num, complexity: num, risk: num,
  needsSecondOpinion: num, needsHumanReview: num, needsTests: num, continueHandoff: num,
  taskTypeProbabilities: numbers, requirements: numbers, verification: labels, filledByRules: labels,
  skills: (s) => keep(s, { primary: label, supporting: labels }),
}
const answer = (a) => keep(a, { label: label, confidence: num, informative: bool, ood: bool })
const DOMAIN = {
  authority: label, maturity: label, label: label, confidence: num, requiredConfidence: num, jevCalled: bool,
  ood: (o) => keep(o, { flag: bool }), teacher: answer, provider: answer, local: answer,
}

/**
 * One history.jsonl record as the export keeps it: labels and numbers, field by field. A field not
 * named here is not copied, so a field a later version adds to the record never leaves the PC by
 * being forgotten.
 */
export function reduceRun(r) {
  const routing = r.routing ?? {}
  const decision = routing.decision ?? {}
  return {
    runId: label(r.runId) ?? null,
    ts: label(r.ts) ?? null,
    finalStatus: label(r.finalStatus) ?? null,
    routing: {
      ...keep(routing, ROUTING),
      profile: keep(routing.profile, PROFILE),
      decision: keep(decision, {
        decider: label, jevCalls: num, belowFloor: bool, gateOverride: bool, minimumCapability: label, strategies: labels,
        judgments: numbers,
        domains: (d) => (d && typeof d === 'object' ? Object.fromEntries(Object.entries(d).map(([id, x]) => [id, keep(x, DOMAIN)])) : undefined),
      }),
      deciderErrors: Array.isArray(routing.deciderErrors) ? routing.deciderErrors.map((e) => keep(e, { phase: label })) : undefined,
    },
    attempts: (r.attempts ?? []).map((a) => keep(a, { agent: label, role: label, stopReason: label })),
    assessments: (r.assessments ?? []).map((a) => keep(a, { mode: label, action: label })),
  }
}

/** Every string of `v`, at any depth, through `redact`. */
function redactDeep(v, redact) {
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), redactDeep(x, redact)]))
  return v
}

const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/**
 * Writes the export and says what it holds.
 * @returns {Promise<{ file: string, bytes: number, holds: string[] }>}
 */
export async function layaExport({ dataDir = defaultDataDir(), harnessDir = resolve(here, '..'), outDir = process.cwd(), now = Date.now() } = {}) {
  const { redactSecrets } = await plugin('export.js')
  const { layaPaths } = await plugin('laya-install.js')
  const paths = layaPaths({ harnessDir, dataDir })
  const holds = []
  const rowsOf = (name, file = join(dataDir, name)) => {
    const f = readRows(file)
    holds.push(f.present ? `${name}: ${f.rows.length} row${f.rows.length === 1 ? '' : 's'}${f.bad ? ` (${f.bad} unreadable line${f.bad === 1 ? '' : 's'} left out)` : ''}` : `${name}: not on this PC`)
    return f.rows
  }
  const shadow = rowsOf('laya-shadow.jsonl')
  const jevSamples = rowsOf('routing-samples.jsonl')
  const layaSamples = rowsOf('laya-samples.jsonl')
  const standing = rowsOf('laya-standing.jsonl')
  const files = { 'laya.json': readJson(paths.settings), 'installed.json': readJson(paths.installed), 'weights.json': readJson(paths.weights) }
  for (const [name, v] of Object.entries(files)) holds.push(`${name}: ${v ? 'as it is' : 'not on this PC'}`)
  const log = existsSync(paths.serveLog) ? readFileSync(paths.serveLog, 'utf8').split(/\r?\n/) : null
  if (log && log.at(-1) === '') log.pop()
  const logTail = log ? log.slice(-LOG_LINES) : []
  holds.push(!log ? 'laya-serve.log: not on this PC' : log.length > LOG_LINES ? `laya-serve.log: the last ${LOG_LINES} of its ${log.length} lines` : `laya-serve.log: all ${log.length} of its lines`)
  const history = readRows(join(dataDir, 'history.jsonl'))
  const runs = history.rows.map(reduceRun)
  holds.push(history.present
    ? `history.jsonl: ${runs.length} run${runs.length === 1 ? '' : 's'}, each reduced to its id, time and final status, its routing labels and numbers, each attempt's agent, role and stop reason, and each review's mode and action; no task text, answer, path, diff or reason`
    : 'history.jsonl: not on this PC')

  const bundle = redactDeep({
    kind: 'laya-export', version: 1, writtenAt: new Date(now).toISOString(),
    shadow, samples: { jev: jevSamples, laya: layaSamples }, standing,
    files, layaServeLog: logTail, runs,
  }, redactSecrets)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `laya-export-${day(now)}.json`)
  const text = `${JSON.stringify(bundle, null, 1)}\n`
  writeFileSync(file, text)
  return { file, bytes: Buffer.byteLength(text), holds }
}

if (runAsScript(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (name) => { const at = args.indexOf(name); return at >= 0 ? resolve(args[at + 1] ?? '') : undefined }
  let r
  try { r = await layaExport({ dataDir: opt('--data'), harnessDir: opt('--harness'), outDir: opt('--out') }) } catch (err) { console.error(`laya-export: ${err.message}`); process.exit(2) }
  console.log(`Wrote ${r.file} (${(r.bytes / 1024).toFixed(0)} KB). It holds:`)
  for (const h of r.holds) console.log(`  ${h}`)
  console.log('Every string in it went through the same key redaction as a chat export. Bring back this file only, never history.jsonl or usage.jsonl.')
}
