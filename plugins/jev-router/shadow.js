// The Laya shadow: in Jev Auto, Laya answers the same questions as Jev in the background, and both
// answers are recorded side by side (docs/laya-auto.md 5).
//
// It hooks every acting Jev call through createJev's `onCall` and must never slow or break the run:
// the hook only hands the call, as jev.js built it and froze it, to the Laya client's queue, which
// is synchronous and O(1); nothing in the run awaits the comparison, every error in it is caught
// here and becomes a `failed` row, and a comparison may land after its run has ended. The Laya
// client decides when the question is asked (after every acting Laya call, beside no local model
// request, never starting Laya, 4.5); this file only records what came of it.
//
// One row per shadowed call in laya-shadow.jsonl, written once Jev's side and Laya's side have
// both settled, with answers and numbers only: no state, task text, question text, answer text or
// diff, the rule routing-samples.jsonl keeps (training.js). A tool parameter's answer is recorded
// as its option index, because tool option keys are the person's own config, which jev.js leaves
// unscrubbed so they can come back as the tool's arguments. Nothing trains on a row.
//
// The file keeps its newest rows (10,000), rewritten to a temporary file and renamed over itself
// as training.js does. Reading it, whether to load the newest rows at start, to compact it or to
// compute the comparison of 8.4, runs in a worker thread: a file at its cap is never parsed on the
// thread that streams the Jev Auto run the person is watching. The Decisions tab's poll reads the
// in-memory index instead, which holds every row written since start and the newest read at start.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { langOf } from './laya-client.js'
import { compare, reviewActions, rowAgreement, standing, thresholdsHash } from './shadow-stats.js'

/** Rows the file keeps. A route row is about 3 KB with its probabilities as arrays (5.3). */
export const SHADOW_CAP = 10_000
/** Rows read into memory at start, so the Decisions tab can show a recent run without the file. */
export const SHADOW_KEEP_AT_START = 2000
/** How long a comparison is reused, and how many new rows make it stale sooner (5.3). */
const COMPARE_TTL_MS = 60_000
const COMPARE_STALE_ROWS = 100
const WORKER_TASK = 'kzh-laya-shadow'
const SKIPS = ['not_running', 'starting', 'queue_full', 'too_old', 'jev_failed', 'yielded']
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
const at = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? 0 : t }

/** The host Jev calls go to: TYPESAFE_BASE_URL still redirects Jev, and the comparison is with that server (8.1). */
export function jevHostOf(env = process.env) {
  const base = String(env.TYPESAFE_BASE_URL ?? '').trim()
  if (!base) return 'api.typesafe.ai'
  try { return new URL(base).host || base } catch { return base }
}

/** A tool parameter's question (`<tool>.<param>`): its option keys are config the person wrote. */
const isToolParam = (name) => name.includes('.') && !name.startsWith('req.') && !name.endsWith('.fits')

/** The option keys of a question in the order it asked them, which is the order of `p`. */
function keysOf(q) {
  if (q?.type === 'choice') return Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q?.criteria ?? {})
  if (q?.type === 'score') return (Array.isArray(q.criteria) ? q.criteria : []).map((_, i) => String(i))
  return null
}

/**
 * One answer as a row keeps it: the pick (a key, an expected level, or P(true)), the probabilities
 * as an array in the question's option order, and the confidence; a tool parameter's pick as its
 * index. Nothing else of the answer, and nothing of the question.
 */
function recorded(name, q, a, { marks = false } = {}) {
  const type = q?.type ?? a?.type
  const keys = keysOf(q)
  let answer
  let p = null
  if (type === 'noul') {
    answer = r3(a?.noul ?? a?.answer)
    p = answer
  } else if (type === 'score') {
    answer = r3(a?.score ?? a?.answer)
    const probs = a?.probabilities
    p = probs && typeof probs === 'object' && keys ? keys.map((k) => r3(Number(probs[k]) || 0)) : null
  } else {
    const pick = a?.choice ?? a?.answer
    answer = isToolParam(name) ? (keys?.includes(pick) ? `#${keys.indexOf(pick)}` : null) : typeof pick === 'string' ? pick : null
    const probs = a?.probabilities
    p = probs && typeof probs === 'object' && keys ? keys.map((k) => r3(Number(probs[k]) || 0)) : null
  }
  return {
    type,
    answer,
    p,
    confidence: r3(a?.confidence),
    ...(marks ? { informative: a?.informative !== false, corrected: a?.corrected === true } : {}),
  }
}

/** Which judgment groups one route call asked, from its question names (5.3). */
function groupsOf(phase, names) {
  if (phase !== 'route') return null
  const groups = []
  const own = new Set(['strategy', 'secondOpinion'])
  // A task-group call carries the profile's secondOpinion itself; only a call without the task
  // group asks the judgments group's, which teaches second_opinion. The legacy named-agent call
  // (routing.enabled off) is a task-group call: its agent question teaches no domain.
  const task = names.some((n) => !own.has(n))
  if (task) groups.push('task')
  if (names.includes('strategy')) groups.push('resource')
  if (!task && names.includes('secondOpinion')) groups.push('judgments')
  return groups
}

/** A Jev error as a row keeps it: its class and codes, never its message. */
const errorOf = (e) => ({ class: e?.constructor?.name ?? typeof e, code: e?.code ?? null, status: typeof e?.status === 'number' ? e.status : null })

// --- the worker: every read of the files ---------------------------------------------------------

/** A JSONL file's rows; a line that does not parse (a write cut off by a crash) is dropped. */
async function readRows(file) {
  let raw = ''
  try { raw = await readFile(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a truncated line */ }
  }
  return out
}

/** A training store's samples, each joined with its newest outcome, as the store's list() gives them. */
async function readSamples(file) {
  if (!file) return []
  const samples = new Map()
  const outcomes = new Map()
  for (const r of await readRows(file)) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue
    if ('outcomeTs' in r) {
      const prev = outcomes.get(r.id)
      if (!prev || at(r.outcomeTs) >= at(prev.outcomeTs)) outcomes.set(r.id, r)
    } else if (typeof r.domain === 'string') samples.set(r.id, r)
  }
  return [...samples.values()].map((s) => ({ ...s, outcome: outcomes.get(s.id)?.outcome ?? null }))
}

/** What the figures read of a history record: never its task, context, answers or paths. */
const reduceRecord = (h) => ({
  runId: h?.runId ?? null,
  finalStatus: h?.finalStatus ?? null,
  attempts: (Array.isArray(h?.attempts) ? h.attempts : []).map((a) => ({ agent: a?.agent ?? null, role: a?.role ?? null, stopReason: a?.stopReason ?? null, limitHit: a?.limitHit === true })),
})
/**
 * What the figures read of a feedback row: its verdict and run, and the time and keys feedback.js
 * reads it back by, so a cleared verdict (a tombstone with no run) still clears; never the reason.
 */
const reduceVerdict = (f) => ({
  ts: f?.ts ?? null, sessionId: f?.sessionId ?? null, messageId: f?.messageId ?? null,
  runId: f?.runId ?? null, verdict: f?.verdict ?? null, tag: f?.tag ?? null,
})

async function inputsOf(files) {
  const [shadowRows, jevSamples, layaSamples, feedback, history] = await Promise.all([
    readRows(files.shadow), readSamples(files.jevSamples), readSamples(files.layaSamples),
    files.feedback ? readRows(files.feedback) : [], files.history ? readRows(files.history) : [],
  ])
  return { shadowRows, jevSamples, layaSamples, feedback: feedback.map(reduceVerdict), history: history.map(reduceRecord) }
}

/** Write rows to a temporary file and rename it over `file`, retried while Windows holds it (training.js). */
async function rewrite(file, lines) {
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(tmp, 'w')
  try {
    for (let i = 0; i < lines.length; i += 1000) await handle.writeFile(lines.slice(i, i + 1000).map((l) => `${l}\n`).join(''))
    await handle.sync()
  } finally { await handle.close() }
  for (let attempt = 0; ; attempt++) {
    try { await rename(tmp, file); break } catch (err) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)))
    }
  }
}

async function work({ job, file, files, keep, cap, options }) {
  if (job === 'load') {
    let raw = ''
    try { raw = await readFile(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
    const lines = raw.split('\n').filter(Boolean)
    const rows = []
    for (const l of lines.slice(-keep)) { try { rows.push(JSON.parse(l)) } catch { /* a truncated line */ } }
    return { lines: lines.length, rows }
  }
  if (job === 'compact') {
    const lines = (await readFile(file, 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err })).split('\n').filter(Boolean)
    const kept = lines.filter((l) => { try { JSON.parse(l); return true } catch { return false } }).slice(-cap)
    if (kept.length < lines.length) await rewrite(file, kept)
    return { lines: kept.length }
  }
  const inputs = await inputsOf(files)
  if (job === 'compare') return compare({ ...inputs, ...options })
  if (job === 'standing') {
    const rows = standing({ ...inputs, ...options })
    await mkdir(dirname(files.standing), { recursive: true })
    await appendFile(files.standing, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
    return rows
  }
  throw new Error(`shadow worker: unknown job ${job}`)
}

if (!isMainThread && workerData?.task === WORKER_TASK) {
  work(workerData).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (err) => parentPort.postMessage({ ok: false, error: String(err?.message ?? err) }),
  )
}

/** Run one job in a worker thread of this same file, and resolve what it answers. */
function inWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { task: WORKER_TASK, ...data } })
    let done = false
    w.once('message', (m) => { done = true; if (m?.ok) resolve(m.result); else reject(new Error(m?.error ?? 'the shadow worker failed')) })
    w.once('error', (err) => { done = true; reject(err) })
    w.once('exit', (code) => { if (!done) reject(new Error(`the shadow worker exited with code ${code}`)) })
  })
}

// --- the shadow ----------------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.file              laya-shadow.jsonl
 * @param {object|null} p.laya         createLayaClient(): offerShadow, withdraw, identity
 * @param {() => boolean} [p.enabled]  whether a Jev call is shadowed now: Laya installed and enabled,
 *   no settings error, learning on, and the card's switch on (5.1)
 * @param {(m: string) => void} [p.log]
 * @param {() => number} [p.now]
 * @param {{ jev: object, laya: object|null }} [p.providers]  the records, for their thresholds
 * @param {string} [p.jevHost]         the host Jev calls go to (jevHostOf())
 * @param {(row: object) => void} [p.onRow]  each row as it is written, for the run's inspector log
 * @param {{ jevSamples?: string, layaSamples?: string, feedback?: string, history?: string, standing?: string }} [p.files]
 *   what the comparison and the standing read and where the standing goes
 * @param {number} [p.cap]    rows the file keeps
 * @param {number} [p.slack]  rows past the cap before the file is rewritten
 */
export function createShadow({ file, laya, enabled = () => true, log = () => {}, now = Date.now, providers = {}, jevHost = jevHostOf(), onRow, files = {}, cap = SHADOW_CAP, slack = 1000, keepAtStart = SHADOW_KEEP_AT_START } = {}) {
  if (!(cap >= 1) || !(slack >= 1)) throw new Error('shadow: cap and slack must each be at least 1')
  const thresholds = { jev: providers?.jev?.thresholds ?? null, laya: providers?.laya?.thresholds ?? null }
  const hashes = { jev: thresholdsHash(thresholds.jev), laya: thresholdsHash(thresholds.laya) }
  const counts = { answered: 0, partial: 0, skipped: Object.fromEntries(SKIPS.map((r) => [r, 0])), failed: 0 }
  const pending = new Map() // callId -> the call while a side has not settled
  // The in-memory index: every row written since start and the newest read at start, newest last,
  // bounded like the file, so the Decisions tab never reads it.
  const memory = []
  const byRun = new Map()
  const byCall = new Map()
  let lines = 0
  let checkedAt = 0
  let written = 0
  let queue = Promise.resolve()
  const serial = (task) => { const run = queue.then(task); queue = run.catch(() => {}); return run }
  const cache = new Map()

  const index = (row) => {
    memory.push(row)
    byCall.set(row.callId, row)
    if (row.runId != null) {
      if (!byRun.has(row.runId)) byRun.set(row.runId, [])
      byRun.get(row.runId).push(row)
    }
    while (memory.length > cap) {
      const old = memory.shift()
      if (byCall.get(old.callId) === old) byCall.delete(old.callId)
      const list = byRun.get(old.runId)
      if (list) { list.splice(list.indexOf(old), 1); if (!list.length) byRun.delete(old.runId) }
    }
  }

  // The newest rows at start, read in the worker; the rows written meanwhile stay after them.
  const loaded = !existsSync(file) ? Promise.resolve() : serial(async () => {
    const got = await inWorker({ job: 'load', file, keep: keepAtStart })
    const since = memory.splice(0)
    byRun.clear()
    byCall.clear()
    for (const row of got.rows) if (row && typeof row === 'object') index(row)
    for (const row of since) index(row)
    lines = got.lines
    checkedAt = lines
    if (lines >= cap + slack) await compact()
  }).catch((err) => log(`laya shadow: ${file} not read: ${err.message}`))

  async function compact() {
    checkedAt = lines
    try {
      lines = (await inWorker({ job: 'compact', file, cap })).lines
      checkedAt = lines
    } catch (err) { log(`laya shadow: not compacted: ${err.message}`) }
  }

  const write = (row) => serial(async () => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(row)}\n`)
    lines++
    if (lines - checkedAt >= slack && lines > cap) await compact()
  }).catch((err) => log(`laya shadow: row not saved: ${err.message}`))

  const safeIdentity = () => { try { return laya?.identity?.() ?? null } catch { return null } }

  /** The row of one call, from Jev's side and Laya's (5.3). */
  function rowOf(p) {
    const jevFailed = !!p.jevError
    const status = jevFailed ? 'skipped' : p.laya.status
    const reason = jevFailed ? 'jev_failed' : p.laya.reason ?? null
    const answer = !jevFailed && (status === 'answered' || status === 'partial') ? p.laya.answer : null
    const meta = answer?.meta ?? {}
    const ctx = p.context && typeof p.context === 'object' ? p.context : {}
    const jevQuestions = {}
    for (const t of Array.isArray(p.jev?.questions) ? p.jev.questions : []) {
      if (!t || t.answer === undefined || !p.questions?.[t.name]) continue
      jevQuestions[t.name] = recorded(t.name, p.questions[t.name], { choice: t.answer, score: t.answer, noul: t.answer, probabilities: t.probabilities, confidence: t.confidence })
    }
    const layaQuestions = {}
    for (const [name, a] of Object.entries(answer?.answers ?? {})) {
      if (p.questions?.[name]) layaQuestions[name] = recorded(name, p.questions[name], a, { marks: true })
    }
    const row = {
      id: randomUUID(),
      ts: new Date(now()).toISOString(),
      runId: p.runId,
      callId: p.callId,
      phase: p.phase,
      groups: groupsOf(p.phase, Object.keys(p.questions ?? {})),
      attempt: p.phase === 'review' && Number.isInteger(ctx.attempt) ? ctx.attempt : null,
      review: p.phase === 'review' ? { risk: typeof ctx.risk === 'number' && Number.isFinite(ctx.risk) ? ctx.risk : null, blockAccept: ctx.blockAccept === true, reviewed: ctx.reviewed === true } : null,
      actions: null,
      identity: meta.identity ?? safeIdentity(),
      device: meta.device ?? null,
      lang: meta.lang ?? langOf(p.state),
      thresholds: hashes,
      status,
      reason,
      queuedMs: p.laya?.queuedMs ?? null,
      ms: p.laya?.ms ?? null,
      rows: meta.rows ?? 0,
      requests: meta.requests ?? 0,
      atContextLimit: meta.atContextLimit ?? 0,
      jev: { model: p.jev?.model ?? null, host: jevHost, ms: p.jev?.ms ?? p.jevMs ?? null, error: jevFailed ? p.jevError : null, questions: jevQuestions },
      laya: { questions: layaQuestions },
    }
    // The action each side's answers give at its own bars, which the inspector's review line reads (5.6).
    if (row.phase === 'review') row.actions = reviewActions(row, thresholds)
    return row
  }

  function finish(p) {
    pending.delete(p.callId)
    let row
    try {
      row = rowOf(p)
    } catch (err) {
      log(`laya shadow: ${p.phase} not recorded as answered: ${err.message}`)
      row = rowOf({ ...p, jev: null, laya: { status: 'failed', reason: 'error' } })
    }
    if (row.status === 'skipped') counts.skipped[row.reason] = (counts.skipped[row.reason] ?? 0) + 1
    else counts[row.status] = (counts[row.status] ?? 0) + 1
    index(row)
    written++
    write(row)
    try { onRow?.(row) } catch (err) { log(`laya shadow: ${err.message}`) }
    // Skips are counted, not logged (7.8).
    if (row.status !== 'skipped') {
      const n = Object.keys(row.laya.questions).length
      const { n: both, agree } = rowAgreement(row)
      log(row.status === 'failed'
        ? `Laya shadow ${row.phase}: failed (${row.reason})`
        : `Laya shadow ${row.phase}: ${n} ${row.status === 'partial' ? 'answered before it waited too long' : 'answered'} in ${row.ms} ms, ${agree}/${both} agree with Jev`)
    }
  }

  /** Once both sides have settled, the row is built and written, later, off the run's own path. */
  function settled(p) {
    if (p.done || (p.jev === undefined && !p.jevError) || p.laya === undefined) return
    p.done = true
    setImmediate(() => {
      try { finish(p) } catch (err) { log(`laya shadow: ${err.message}`) }
    })
  }

  /**
   * The hook createJev takes as `onCall`, for one run (`runId` null for the intent). It offers the
   * call and returns the settle function jev.js calls with `{ trace }` or `{ error }`; both only
   * note what they were given, so neither can delay the Jev call or the run.
   */
  function offerer({ runId = null } = {}) {
    return function onCall({ callId, phase, state, questions, context = null } = {}) {
      let on = false
      try { on = !!laya && !!enabled() } catch { on = false }
      if (!on) return undefined
      const p = { callId, runId: phase === 'intent' ? null : runId ?? null, phase, state, questions, context, jev: undefined, jevError: null, laya: undefined, done: false }
      pending.set(callId, p)
      try {
        const r = laya.offerShadow({ callId, runId: p.runId, phase, state, questions, context, onDone: (res) => { if (p.laya === undefined) { p.laya = res ?? { status: 'failed', reason: 'error' }; settled(p) } } })
        if (r?.dropped) p.laya = { status: 'skipped', reason: r.dropped }
        else if (!r?.queued) p.laya = { status: 'failed', reason: 'error' }
      } catch (err) {
        p.laya = { status: 'failed', reason: err?.code ?? 'error' }
      }
      return function settle({ trace, error } = {}) {
        if (p.jev !== undefined || p.jevError) return
        if (trace) p.jev = trace
        else {
          p.jevError = errorOf(error)
          // A Jev call that failed is not compared: its job goes, or its remaining chunks do (5.2).
          if (p.laya === undefined) { try { laya.withdraw(callId, 'jev_failed') } catch { /* the row still says jev_failed */ } }
        }
        settled(p)
      }
    }
  }

  const sinceOf = (since) => (since == null ? null : typeof since === 'number' ? since : at(since))

  return {
    offerer,
    /** Rows of one run (or every row in memory), from the in-memory index, never the file. */
    read({ runId, since } = {}) {
      const floor = sinceOf(since)
      const list = runId !== undefined && runId !== null ? byRun.get(runId) ?? [] : memory
      return floor == null ? [...list] : list.filter((r) => at(r.ts) >= floor)
    },
    /** The calls of one run whose comparison has not landed yet: the inspector's `waiting for Laya`. */
    waiting({ runId } = {}) {
      return [...pending.values()].filter((p) => runId == null || p.runId === runId).map((p) => ({ callId: p.callId, phase: p.phase }))
    },
    /** One row's by its call id, from memory. */
    rowOf: (callId) => byCall.get(callId) ?? null,
    counters: () => ({ ...counts, skipped: { ...counts.skipped } }),
    /** Resolves once the rows read at start are in memory. */
    loaded: () => loaded,
    /** Resolves once every row settled so far is on disk. */
    async flush() {
      await new Promise((r) => setImmediate(r))
      await loaded
      await queue
    },
    /**
     * The comparison of 8.4, computed in a worker over the files and reused for 60 s or until 100
     * new rows have arrived. `identity: 'all'` reads every identity, thresholds pair and Jev host.
     */
    async compare({ days = 7, identity = 'current' } = {}) {
      const key = `${days}|${identity}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < COMPARE_TTL_MS && written - hit.written < COMPARE_STALE_ROWS) return hit.value
      await queue
      const value = await inWorker({
        job: 'compare',
        files: { ...files, shadow: file },
        options: { identity: safeIdentity(), thresholds, jevHost, days, scope: identity === 'all' ? 'all' : 'current', now: now() },
      })
      cache.set(key, { at: now(), written, value })
      return value
    },
    /** Laya's standing (6.7), computed in the worker and appended to laya-standing.jsonl; returns its rows. */
    async recordStanding() {
      if (!files.standing) throw new Error('shadow: no standing file')
      await queue
      return inWorker({ job: 'standing', files: { ...files, shadow: file }, options: { identity: safeIdentity(), thresholds, jevHost, now: now() } })
    },
  }
}
