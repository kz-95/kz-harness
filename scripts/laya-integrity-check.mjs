// The integrity check on this PC's own data (docs/laya-auto.md 6.9, 9.5 step 12): has anything a
// Laya-decided run did reached what Jev teaches, credits or counts?
//
//   node scripts/laya-integrity-check.mjs [--data <dir>] [--json]
//
// It reads the jev-router data folder (default <DSH_HOME>/jev-router, DSH_HOME being ~/.kzh when
// unset, as Start-KzH.ps1 sets it) and checks, over every run Laya decided:
//
//   1. no row of routing-samples.jsonl, the store Jev teaches from, belongs to one, and none is a
//      Laya row (authority laya, or a provider answer); laya-samples.jsonl holds no teacher;
//   2. capability-evidence.jsonl credits one with reliability only, and never with a task type;
//   3. usage.jsonl has no Jev call under one, and every Laya row costs $0.00;
//   4. "Saved by Jev" (usage.js computeSavings, every period) and Jev's spend this month are the
//      same with and without Laya's usage rows, direct answers and runs;
//   5. laya-shadow.jsonl has no row of one: a Laya Auto run has no shadow.
//
// A run is Laya-decided when its history.jsonl record says `routing.decider: 'laya'`, or when
// laya-samples.jsonl, which only a Laya-decided run writes to, has a sample of it: the two are read
// apart, so a record that lost its decider is still found. It prints one line per check and each
// violation, and exits 1 when anything was violated, 2 when it could not run. With no Laya-decided
// run on this PC it says so: then it has proved nothing yet.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..', 'plugins', 'jev-router')
const plugin = (file) => import(pathToFileURL(join(PLUGIN, file)).href)

/** The jev-router data folder the engine uses on this PC. */
export const defaultDataDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.kzh'), 'jev-router')

/** The rows of a JSONL file, and how many lines of it could not be read; none when it is absent. */
export function readRows(file) {
  if (!existsSync(file)) return { rows: [], bad: 0, present: false }
  let bad = 0
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows, bad, present: true }
}

// The figures of computeSavings that are Jev's; Laya's own (layaDecisions, layaTokens) are counted
// apart there and may differ.
const JEV_FIGURES = ['decisions', 'jevCostUsd', 'llmCostUsd', 'savedUsd', 'savedMs', 'llmOutputTokensAvoided', 'jevTokens', 'directAnswers', 'toolRuns', 'limitsAvoided']
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const short = (id) => String(id).slice(0, 8)
const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`

/**
 * Every check over one data folder, without printing. `now` fixes the periods of "Saved by Jev" and
 * the month of Jev's spend.
 * @returns {Promise<{ dataDir: string, layaRuns: number, jevRuns: number, checks: { id: string, title: string, ok: boolean, detail: string, violations: string[] }[], unreadable: string[] }>}
 */
export async function integrityCheck({ dataDir = defaultDataDir(), historyFile = join(dataDir, 'history.jsonl'), now = Date.now() } = {}) {
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) throw new Error(`no jev-router data folder at ${dataDir}`)
  const { computeSavings } = await plugin('usage.js')
  const read = (name) => readRows(join(dataDir, name))
  const history = readRows(historyFile)
  const jevStore = read('routing-samples.jsonl')
  const layaStore = read('laya-samples.jsonl')
  const evidence = read('capability-evidence.jsonl')
  const usage = read('usage.jsonl')
  const shadow = read('laya-shadow.jsonl')
  const unreadable = Object.entries({ 'history.jsonl': history, 'routing-samples.jsonl': jevStore, 'laya-samples.jsonl': layaStore, 'capability-evidence.jsonl': evidence, 'usage.jsonl': usage, 'laya-shadow.jsonl': shadow })
    .filter(([, f]) => f.bad).map(([name, f]) => `${name}: ${f.bad} line${f.bad === 1 ? '' : 's'} could not be read`)

  const layaRuns = new Set()
  for (const r of history.rows) if (r.routing?.decider === 'laya' && r.runId) layaRuns.add(r.runId)
  for (const s of layaStore.rows) if (s.runId) layaRuns.add(s.runId)
  const isLaya = (runId) => !!runId && layaRuns.has(runId)
  const jevRuns = history.rows.filter((r) => r.runId && !isLaya(r.runId)).length
  const checks = []
  const check = (id, title, violations, detail) => checks.push({ id, title, ok: violations.length === 0, detail, violations })

  // 1. The stores.
  {
    const v = []
    for (const s of jevStore.rows) {
      if (isLaya(s.runId)) v.push(`routing-samples.jsonl holds a ${s.domain ?? 'sample'} sample of the Laya-decided run ${short(s.runId)} (sample ${short(s.id)})`)
      else if (s.authority === 'laya' || s.provider) v.push(`routing-samples.jsonl holds a Laya row: ${s.domain ?? 'sample'} sample ${short(s.id)}${s.authority === 'laya' ? ' decided by Laya' : ' with a provider answer'}`)
    }
    for (const s of layaStore.rows) if (s.teacher != null) v.push(`laya-samples.jsonl holds a teacher's answer: ${s.domain ?? 'sample'} sample ${short(s.id)}`)
    check('stores', 'no Laya-decided run in routing-samples.jsonl, the store Jev teaches from', v, `${count(jevStore.rows.length, 'Jev sample')}, ${count(layaStore.rows.length, 'Laya sample')}`)
  }

  // 2. Capability evidence.
  {
    const v = []
    let n = 0
    for (const e of evidence.rows) {
      if (!e.dimension || !isLaya(e.runId)) continue
      n++
      if (e.dimension !== 'reliability' || e.taskType != null) v.push(`capability-evidence.jsonl credits ${e.subject?.model ?? e.subject?.provider ?? 'a resource'} with ${e.dimension}${e.taskType != null ? ` for the task type ${e.taskType}` : ''} (${e.source ?? 'no source'}) from the Laya-decided run ${short(e.runId)}`)
    }
    check('evidence', 'no capability evidence but reliability from Laya-decided runs', v, `${count(n, 'evidence row')} from Laya-decided runs`)
  }

  // 3. The calls of a Laya-decided run.
  {
    const v = []
    let n = 0
    for (const u of usage.rows) {
      if (u.agent === 'jev' && isLaya(u.runId)) v.push(`usage.jsonl has a Jev ${u.phase ?? 'call'} in the Laya-decided run ${short(u.runId)} (${u.ts ?? 'no time'})`)
      if (u.agent === 'laya') { n++; if ((u.costUsd ?? 0) !== 0) v.push(`usage.jsonl prices a Laya ${u.phase ?? 'call'} at $${u.costUsd} (${u.ts ?? 'no time'})`) }
    }
    check('calls', 'no Jev call in a Laya-decided run, and every Laya call at $0.00', v, `${count(n, 'Laya call')}`)
  }

  // 4. "Saved by Jev" and Jev's spend.
  {
    const v = []
    const layaUsage = (u) => u.agent === 'laya' || (u.role === 'direct-answer' && u.decider != null && u.decider !== 'jev')
    const withoutUsage = usage.rows.filter((u) => !layaUsage(u))
    const withoutRuns = history.rows.filter((r) => !isLaya(r.runId) && r.routing?.decider !== 'laya')
    const all = computeSavings(usage.rows, history.rows, {}, now)
    const jevOnly = computeSavings(withoutUsage, withoutRuns, {}, now)
    for (const [period, p] of Object.entries(all.periods)) {
      for (const f of JEV_FIGURES) if (!same(p[f], jevOnly.periods[period]?.[f])) v.push(`"Saved by Jev" ${period}: ${f} is ${JSON.stringify(p[f])} with Laya's rows and ${JSON.stringify(jevOnly.periods[period]?.[f])} without them`)
    }
    const month = new Date(now).toISOString().slice(0, 7)
    const spend = (rows) => rows.filter((u) => u.agent === 'jev' && u.ts?.startsWith(month)).reduce((a, u) => a + (u.costUsd ?? 0), 0)
    if (spend(usage.rows) !== spend(withoutUsage)) v.push(`Jev's spend this month is $${spend(usage.rows)} with Laya's rows and $${spend(withoutUsage)} without them`)
    const counted = usage.rows.length - withoutUsage.length + history.rows.length - withoutRuns.length
    check('savings', '"Saved by Jev" and Jev\'s spend unchanged by Laya\'s rows', v, `${count(counted, 'Laya row')} of usage and history left out and put back`)
  }

  // 5. The shadow.
  {
    const v = []
    for (const s of shadow.rows) if (isLaya(s.runId)) v.push(`laya-shadow.jsonl has a ${s.phase ?? ''} row of the Laya-decided run ${short(s.runId)}: a Laya Auto run has no shadow`)
    check('shadow', 'no shadow row of a Laya-decided run', v, `${count(shadow.rows.length, 'shadow row')}`)
  }

  return { dataDir, layaRuns: layaRuns.size, jevRuns, checks, unreadable }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--data')
  const dataDir = at >= 0 ? resolve(args[at + 1] ?? '') : defaultDataDir()
  let r
  try { r = await integrityCheck({ dataDir }) } catch (err) { console.error(`laya-integrity-check: ${err.message}`); process.exit(2) }
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`laya-integrity-check: ${r.dataDir}: ${count(r.layaRuns, 'Laya-decided run')}, ${count(r.jevRuns, 'other run')}`)
    if (!r.layaRuns) console.log('No run on this PC was decided by Laya, so this proves nothing about Laya Auto yet: send some Laya Auto tasks, then run it again.')
    for (const u of r.unreadable) console.log(`note  ${u}; they were left out`)
    for (const c of r.checks) {
      console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.title} (${c.detail})`)
      for (const v of c.violations) console.log(`      ${v}`)
    }
    const failed = r.checks.filter((c) => !c.ok)
    console.log(failed.length ? `${failed.length} of ${r.checks.length} checks failed.` : `All ${r.checks.length} checks passed.`)
  }
  process.exit(r.checks.some((c) => !c.ok) ? 1 : 0)
}
