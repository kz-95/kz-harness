// The reply ledger: what each start reply said, what the router then ran, and a small predictor of
// the pick that learns from the two (docs/live-agent-view.md Feature 3). It runs in shadow: every
// task queued from the chat gets a row, the predictor's guess is recorded as the task is queued and
// scored once the router picks, and nothing reads a guess yet. Slice 9 lets a reply use one, once
// the predictor's own measured record against `routed.primary` says it may (quickGate, likelyGate).
//
// The predictor is a classifier.js multiclass artifact over the message's intentFeatures and the
// pool it was picked from, labelled `<agent>|<level>` from what the router ran. It learns from the
// router, which has already taken in every correction a person made, and it writes to no routing
// training store, so it can never promote a routing domain on its own guesses.
//
// Rows are JSONL in `reply-ledger.jsonl` beside the other records, one task's whole row per line,
// the newest line of a task winning, and never any task text: ids, agents, models, efforts, times
// and hashed features only. The file is rewritten to one line per task, its newest `cap` tasks,
// once it has grown a slack past that, through a temporary file renamed over it, and never when it
// could not be read, since the copy would hold only what the ledger knows, nor by a ledger disposed
// of, since the plugin that replaced it appends its own rows there. Each rewrite reads the file
// again first, so it keeps what another ledger appended since this one read it: the one a plugin
// applied again replaced, which still notes the rows of the tasks the old plugin runs.
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { calibrate, loadArtifact, predict, saveArtifact, trainMulticlass } from './classifier.js'
import { intentFeatures, mergeFeatures } from './features.js'

/** The artifact's domain, which loadArtifact checks: the predictor is no routing domain. */
export const REPLY_DOMAIN = 'reply_predictor'
/**
 * The measured records a reply's prediction must keep before slice 9 lets a reply use it: right 45
 * of the last 50 for a reply that goes out before routing (quick), and 16 of the last 20 for a
 * `likely` clause in a reply that waits. `config.replies` may set either (replyGates).
 */
export const REPLY_GATES = Object.freeze({ quick: Object.freeze({ right: 45, of: 50 }), likely: Object.freeze({ right: 16, of: 20 }) })
/** A retrain after every this many new labelled rows. */
export const RETRAIN_EVERY = 25
/** The fewest labelled rows a predictor is trained on. */
export const MIN_ROWS = 60
// The newest labelled rows a retrain reads: what the router picks now, at a cost a worker thread
// pays in a few seconds (about 5 s for 500 rows on a laptop core).
const TRAIN_ROWS = 500
const WORKER_TASK = 'kzh-reply-train'
const r3 = (x) => Math.round(x * 1000) / 1000

/**
 * `fn` again, up to seven tries over about a tenth of a second, while it fails as a rename over a
 * file a reader holds does on Windows for a moment (tasks.js found it); then its failure. `signal`
 * ends the tries early.
 */
async function whileHeld(fn, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (err) {
      if (attempt >= 6 || signal?.aborted || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)))
    }
  }
}

/** The predictor's label for what ran: the agent and the level its effort was on the unified ladder, `none` for one that takes none. */
export const replyLabel = (ran) => `${ran.agent}|${ran.level ?? 'none'}`
const ofLabel = (label) => {
  const at = String(label).lastIndexOf('|')
  const level = String(label).slice(at + 1)
  return { agent: String(label).slice(0, at), level: level === 'none' ? null : level }
}

/**
 * The pool a pick is made from, as features: every agent the router could pick now (`avail:<id>`),
 * the row's mode, the effort picked in the model menu (`auto` when none was), who decides, and
 * whether a picture came with the message.
 */
export function replyPoolFeatures({ available = [], mode = 'auto', level = 'auto', decider = 'jev', modalities = ['text'] } = {}) {
  const numeric = { [`mode:${mode ?? 'auto'}`]: 1, [`level:${level ?? 'auto'}`]: 1, [`decider:${decider ?? 'jev'}`]: 1 }
  for (const id of available) numeric[`avail:${id}`] = 1
  if ((modalities ?? []).includes('image')) numeric['modal:image'] = 1
  return { numeric, categorical: {} }
}

/** What the predictor reads of one message: its words (intentFeatures), then the pool it was picked from. */
export const replyFeatures = ({ text, modalities = ['text'], ...pool }) => mergeFeatures(intentFeatures(text, { modalities }), replyPoolFeatures({ ...pool, modalities }))

/** A row the predictor can learn from: the router ran something for it, and nobody picked the agent by hand. */
const labelled = (r) => !!r?.ran?.agent && !r.forced && !!r.features

/**
 * Train the predictor on the newest labelled rows, the oldest four fifths fitted and the newest
 * fifth calibrated, never shuffled. Class weights are not balanced: the predictor is asked what the
 * router will most likely pick, which is the most frequent pick for a message like it, rare picks
 * included as rare. Throws with fewer than MIN_ROWS labelled rows.
 * @param {object[]} rows  ledger rows, oldest first
 */
export function trainPredictor(rows, { now = () => Date.now(), options = {}, minRows = MIN_ROWS } = {}) {
  const usable = rows.filter(labelled).slice(-TRAIN_ROWS)
  if (usable.length < minRows) throw new Error(`reply predictor: ${usable.length} labelled rows, ${minRows} needed`)
  const items = usable.map((r) => ({ features: r.features, label: replyLabel(r.ran) }))
  const cut = Math.max(1, Math.floor(items.length * 0.8))
  const fitted = trainMulticlass({
    samples: items.slice(0, cut), options: { ...options, balance: false }, domain: REPLY_DOMAIN, now,
    trainingDataVersion: String(items.length), extras: { rows: items.length, trainedThrough: usable.at(-1).key ?? null },
  })
  return calibrate(fitted, items.length > cut ? items.slice(cut) : items.slice(0, cut))
}

/**
 * The predictor's guess for one message, masked to the agents available now: the most probable
 * label whose agent is one of `available` (any, when no list is given), with its calibrated
 * probability. `trusted` only when that is also the top label unmasked: a predictor whose favourite
 * is out of reach is guessing at second best. Null with no artifact, or nothing available.
 * @returns {{ agent: string, level: string|null, confidence: number, trusted: boolean }|null}
 */
export function predictReply(artifact, features, { available = null } = {}) {
  if (!artifact) return null
  const p = predict(artifact, features)
  const open = (label) => !available || available.includes(ofLabel(label).agent)
  const top = Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).find(([label]) => open(label))
  if (!top) return null
  return { ...ofLabel(top[0]), confidence: r3(top[1]), trusted: top[0] === p.label }
}

/**
 * The predictor's record for one decider: of its last `n` scored rows (a guess, and what the router
 * then ran), how many it got right, agent and level both. Each decider has its own: Jev's picks and
 * Laya's are different things to predict.
 * @param {object[]} rows  ledger rows, oldest first
 */
export function trackRecord(rows, decider, n) {
  const scored = rows.filter((r) => (r?.decider ?? 'jev') === decider && typeof r.match === 'boolean').slice(-n)
  return { decider, of: n, n: scored.length, right: scored.filter((r) => r.match).length }
}
const keeps = (record, gate) => record.n >= gate.of && record.right >= gate.right
/** Whether a reply may go out before routing on the predictor's word: right `quick.right` of the last `quick.of`. */
export const quickGate = (rows, decider, gates = REPLY_GATES) => keeps(trackRecord(rows, decider, gates.quick.of), gates.quick)
/** Whether a reply that waits may name the likely pick: right `likely.right` of the last `likely.of`. */
export const likelyGate = (rows, decider, gates = REPLY_GATES) => keeps(trackRecord(rows, decider, gates.likely.of), gates.likely)

/** The gates with `config.replies` laid over them. Throws on a gate that could not mean anything. */
export function replyGates(over = {}) {
  const gate = (name) => {
    const g = { ...REPLY_GATES[name], ...(over?.[name] ?? {}) }
    if (!Number.isInteger(g.of) || g.of < 1 || !Number.isInteger(g.right) || g.right < 1 || g.right > g.of) throw new Error(`replies.${name}: right and of are whole numbers from 1, right no more than of`)
    return Object.freeze({ right: g.right, of: g.of })
  }
  return Object.freeze({ quick: gate('quick'), likely: gate('likely') })
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * What the How Jev replies card shows of the ledger (index.js GET /jev-router/replies/summary): how
 * long the replies that waited for the pick took this week, until it came (`routed`) or the wait ran
 * out before it (`bound`, counted apart as `atBound`), the predictor's record per decider against
 * both gates, and the newest replies with what they said and what then ran, each with its task's
 * key, by which the plugin reads whether that task has ended (job ids start again after a restart).
 * @param {object[]} rows  ledger rows, oldest first
 */
export function ledgerSummary(rows, { now = Date.now(), gates = REPLY_GATES, recent = 10, weekMs = 7 * 86_400_000 } = {}) {
  const thisWeek = rows.filter((r) => Date.parse(r.ts) >= now - weekMs)
  const waited = thisWeek.filter((r) => (r.said?.how === 'routed' || r.said?.how === 'bound') && Number.isFinite(r.said.ms))
  const record = (decider) => ({ quick: trackRecord(rows, decider, gates.quick.of), likely: trackRecord(rows, decider, gates.likely.of) })
  return {
    startReplies: { medianMs: median(waited.map((r) => r.said.ms)), n: waited.length, atBound: waited.filter((r) => r.said.how === 'bound').length, days: Math.round(weekMs / 86_400_000) },
    prediction: { gates, labelled: rows.filter(labelled).length, minRows: MIN_ROWS, records: { jev: record('jev'), laya: record('laya') } },
    recent: rows.filter((r) => r.said).slice(-recent).reverse().map((r) => ({
      key: r.key, jobId: r.jobId, ts: r.ts, decider: r.decider, said: r.said, ran: r.ran, predicted: r.predicted, match: r.match,
    })),
  }
}

// --- the worker that trains, off the event loop --------------------------------------------------

if (!isMainThread && workerData?.task === WORKER_TASK) {
  try { parentPort.postMessage({ ok: true, artifact: trainPredictor(workerData.rows, { now: () => workerData.at, minRows: workerData.minRows }) }) } catch (err) { parentPort.postMessage({ ok: false, error: String(err?.message ?? err) }) }
}

/**
 * Train the predictor in a worker thread of this same file, so a retrain never holds up a reply, a
 * run or a page: it takes seconds on a few hundred rows. `signal` ends the worker.
 */
export function trainInWorker(rows, { now = () => Date.now(), signal, minRows = MIN_ROWS } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { task: WORKER_TASK, at: now(), minRows, rows: rows.map((r) => ({ key: r.key, features: r.features, ran: r.ran, forced: r.forced })) } })
    let done = false
    const stop = () => { w.terminate().catch(() => {}) }
    signal?.addEventListener('abort', stop, { once: true })
    const settle = (fn) => (v) => { if (done) return; done = true; signal?.removeEventListener('abort', stop); fn(v) }
    w.once('message', settle((m) => (m?.ok ? resolve(m.artifact) : reject(new Error(m?.error ?? 'the reply predictor\'s worker failed')))))
    w.once('error', settle(reject))
    w.once('exit', settle((code) => reject(new Error(`the reply predictor's worker exited with code ${code}`))))
  })
}

// --- the ledger --------------------------------------------------------------------------------

const FIELDS = ['ts', 'sessionId', 'key', 'jobId', 'decider', 'mode', 'forced', 'features', 'predicted', 'said', 'ran', 'match', 'verdict', 'ask']
const blank = (key) => ({ ts: null, sessionId: null, key, jobId: null, decider: 'jev', mode: 'auto', forced: false, features: null, predicted: null, said: null, ran: null, match: null, verdict: null, ask: null })
/** Whether the guess named what ran, agent and level both; null until there are both. */
const matchOf = (r) => (r.predicted && r.ran ? r.predicted.agent === r.ran.agent && (r.predicted.level ?? null) === (r.ran.level ?? null) : null)
/**
 * Lay the rows a file's lines hold over `into`, by task key in the order each task was first noted,
 * the newest line of a task winning; a line that is no row, as a truncated last line, is passed over.
 * Returns how many lines there were.
 */
function layOver(raw, into) {
  const all = raw.split('\n').filter(Boolean)
  for (const l of all) {
    let r
    try { r = JSON.parse(l) } catch { continue } // a truncated last line
    if (r && typeof r === 'object' && typeof r.key === 'string') into.set(r.key, { ...blank(r.key), ...r })
  }
  return all.length
}
// One line of work per file for every ledger on it in this process, appends and rewrites alike: the
// plugin applied again leaves its old ledger appending beside the new one, and a line appended while
// the other copies the file to rewrite it would land in the file the copy then replaces. Kept on
// globalThis because a reload may import this module afresh (accounts.js does the same).
const fileWork = (globalThis[Symbol.for('kz-harness.jev-router.replyLedgerFiles')] ??= new Map())
const onFile = (file, task) => {
  const run = (fileWork.get(file) ?? Promise.resolve()).then(task)
  const tail = run.catch(() => {})
  fileWork.set(file, tail)
  // A file nothing more waits on is let go of.
  tail.then(() => { if (fileWork.get(file) === tail) fileWork.delete(file) })
  return run
}

/**
 * @param {object} p
 * @param {string} p.file        reply-ledger.jsonl
 * @param {string} [p.modelFile] reply-model.json, where the predictor is kept
 * @param {object} [p.gates]     replyGates(config.replies)
 * @param {() => number} [p.now]
 * @param {(m: string) => void} [p.log]
 * @param {number} [p.cap]       tasks the file keeps once rewritten
 * @param {number} [p.slack]     lines past the cap before it is
 * @param {Function} [p.train]   how a retrain runs (trainInWorker by default)
 * @param {() => boolean} [p.learns] whether it may train now: false while learning is off, when
 *   nothing is noted and what the ledger holds is only read
 */
export function createReplyLedger({ file, modelFile = null, gates = REPLY_GATES, now = () => Date.now(), log = () => {}, cap = 1000, slack = cap, retrainEvery = RETRAIN_EVERY, minRows = MIN_ROWS, train = trainInWorker, learns = () => true }) {
  const rows = new Map() // task key -> row, in the order each task was first noted
  let lines = 0 // lines in the file, as far as this ledger knows
  let unread = false // the file exists and could not be read
  // `lines` when a rewrite last failed (a reader holding the file makes the rename fail on Windows):
  // the next waits for another slack of lines, rather than rewriting the file on every write.
  let failedAt = null
  let loading = null
  let queue = Promise.resolve()
  let artifact = null
  // The newest labelled row the last retrain was given, by key, whether it worked or not: the next
  // waits for retrainEvery rows after it, so one that fails is not run again on every row. Read from
  // the predictor in service as the ledger loads.
  let through = null
  let retraining = null
  let stopTraining = null
  // Once the plugin closes or is applied again (dispose), no retrain starts: a task of the old plugin
  // still running notes its rows here, and a retrain they started would have nobody left to end it.
  // Nor is the file rewritten: the plugin that replaced it appends its own rows there, which this
  // ledger does not hold, so its rows are only appended.
  let disposed = false

  const serial = (task) => { const run = queue.then(task); queue = run.catch(() => {}); return run }
  // Read once, on first use, before anything is written: every change after it is queued behind it.
  const ready = () => {
    if (!loading) {
      loading = serial(async () => {
        let raw = ''
        try { raw = await onFile(file, () => readFile(file, 'utf8')) } catch (err) {
          // Any other failure leaves a file this ledger knows nothing of, and it must never rewrite
          // one: the rewrite would keep only what it knows. Rows noted since are appended to it.
          if (err.code !== 'ENOENT') { unread = true; log(`reply ledger not read: ${err.message}`) }
        }
        lines = layOver(raw, rows)
        if (modelFile) {
          const got = loadArtifact(modelFile, { domain: REPLY_DOMAIN })
          artifact = got.artifact
          through = artifact?.extras?.trainedThrough ?? null
          if (!artifact && !/^missing/.test(got.reason ?? '')) log(`reply predictor not loaded: ${got.reason}`)
        }
        await fit()
        // Rows enough and no predictor trained through them, as after a start with reply-model.json
        // deleted or never saved: one is trained now, not once the next task is routed for, which
        // left the card saying it starts once 60 are on record beside more than 60.
        maybeRetrain()
      })
    }
    return loading
  }

  /** Let go of the oldest tasks this ledger holds past the newest `cap`. */
  const trim = () => {
    const drop = rows.size - cap
    if (drop > 0) for (const k of [...rows.keys()].slice(0, drop)) rows.delete(k)
  }
  /**
   * The newest `cap` tasks, one line each, once the file holds a slack more lines than that: never
   * over a file that could not be read, never by a ledger disposed of, and after a rewrite that
   * failed, once another slack of lines has been appended. The file is read again first, each task's
   * newest line there winning, so the copy keeps what another ledger appended since this one read it,
   * and this ledger holds it from then on, as a start reading the file would; a task it holds that
   * never reached the file, as one whose append failed, comes after.
   */
  const fit = async () => {
    trim()
    if (disposed || unread || lines - rows.size < slack || (failedAt !== null && lines - failedAt < slack)) return
    const tmp = `${file}.tmp`
    try {
      await onFile(file, async () => {
        let raw = ''
        try { raw = await readFile(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
        const merged = new Map()
        layOver(raw, merged)
        for (const [k, r] of rows) if (!merged.has(k)) merged.set(k, r)
        rows.clear()
        for (const [k, r] of merged) rows.set(k, r)
        trim()
        await mkdir(dirname(file), { recursive: true })
        const handle = await open(tmp, 'w')
        try {
          await handle.writeFile([...rows.values()].map((r) => `${JSON.stringify(r)}\n`).join(''))
          await handle.sync()
        } finally { await handle.close() }
        await whileHeld(() => rename(tmp, file))
      })
      lines = rows.size
      failedAt = null
    } catch (err) { failedAt = lines; log(`reply ledger not compacted: ${err.message}`) }
  }

  const labelledRows = () => [...rows.values()].filter(labelled)
  // One retrain at a time, in the background: nothing waits for it, and a row noted meanwhile is
  // taken by the next one. A row the last retrain was given that the cap has let go of counts every
  // labelled row as new, so a retrain follows soon rather than never. None while learning is off,
  // and none once the ledger is disposed of.
  const maybeRetrain = () => {
    if (disposed || retraining || !learns()) return
    const list = labelledRows()
    if (list.length < minRows) return
    const at = through ? list.findIndex((r) => r.key === through) : -1
    if (through && at >= 0 && list.length - at - 1 < retrainEvery) return
    through = list.at(-1).key
    const stop = new AbortController()
    stopTraining = stop
    retraining = (async () => {
      try {
        const fresh = await train(list.slice(-TRAIN_ROWS), { now, signal: stop.signal, minRows })
        if (stop.signal.aborted) return
        // A predictor the disk refuses is used all the same, as a routing domain's is (domains.js):
        // the file is only what the next start loads, and that start trains one again as it reads
        // the ledger, since the one it loads, if any, was trained through an older row.
        if (modelFile) {
          try { await whileHeld(() => saveArtifact(modelFile, fresh), stop.signal) } catch (err) {
            if (!stop.signal.aborted) log(`reply predictor not saved: ${err.message}`)
          }
        }
        artifact = fresh
      } catch (err) {
        if (!stop.signal.aborted) log(`reply predictor not trained: ${err.message}`)
      }
    })().finally(() => { retraining = null; stopTraining = null })
  }

  /** Lay `fields` over the task's row (made on first use) and append the whole row; inside the queue. */
  const write = async (key, fields) => {
    const row = { ...(rows.get(key) ?? blank(key)) }
    for (const f of FIELDS) if (f !== 'key' && f in fields) row[f] = fields[f]
    if (!row.ts) row.ts = new Date(now()).toISOString()
    // What ran is scored against the guess whichever of the two is noted first.
    row.match = matchOf(row)
    rows.set(key, row)
    await onFile(file, async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(row)}\n`)
    })
    lines++
    if (lines - rows.size >= slack || rows.size > cap) await fit()
    if (labelled(row)) maybeRetrain()
    return row
  }
  const keyed = (key) => (typeof key === 'string' && key ? null : Promise.reject(new Error('reply ledger: a task key is required')))

  const api = {
    /** Lay `fields` over the task's row, made on first use, and keep it. Resolves with the row. */
    note(key, fields = {}) {
      return keyed(key) ?? ready().then(() => serial(() => write(key, fields)))
    },
    /**
     * What the router ran for the task, from its first routing: a task a read pass hands back is
     * routed again, and its first pick is the one its reply was measured against.
     */
    routed(key, ran) {
      return keyed(key) ?? ready().then(() => serial(async () => (rows.get(key)?.ran ? rows.get(key) : write(key, { ran }))))
    },
    /** The predictor's guess for these features, masked to `available` (predictReply); null until one is trained. */
    async predict(features, available) {
      await ready()
      return predictReply(artifact, features, { available })
    },
    /** Every row, oldest first. */
    async rows() { await ready(); await queue; return [...rows.values()] },
    async trackRecord(decider, n) { return trackRecord(await api.rows(), decider, n) },
    /** Whether each gate holds for `decider` now. */
    async gates(decider) { const list = await api.rows(); return { quick: quickGate(list, decider, gates), likely: likelyGate(list, decider, gates) } },
    /**
     * What the card shows (ledgerSummary), with the predictor's own state: when it was trained and on
     * how many rows, whether a retrain is under way (`training`), and how many new rows the next waits for.
     */
    async summary({ at = now() } = {}) {
      const s = ledgerSummary(await api.rows(), { now: at, gates })
      return { ...s, prediction: { ...s.prediction, minRows, retrainEvery, training: !!retraining, trained: artifact ? { at: artifact.createdAt, rows: artifact.extras?.rows ?? artifact.sampleCount } : null } }
    },
    /** Resolves once every row noted so far is on disk, and any retrain under way has ended. */
    async flushed() { await ready(); await queue; await retraining },
    /**
     * Stop a retrain under way, and start none after: its worker is ended and nothing it trained is
     * kept. Rows noted after are still kept, as what ran, and appended: the file is rewritten no more,
     * since the plugin that replaced this one appends its own rows there. Resolves once every row
     * noted so far is on disk, one still waiting behind the first read included (its write joins the
     * queue as that read ends, before this looks at it); the retrain it ends saves nothing, so it is
     * not waited for.
     */
    dispose() {
      disposed = true
      stopTraining?.abort()
      return Promise.resolve(loading).catch(() => {}).then(() => queue)
    },
  }
  return api
}
