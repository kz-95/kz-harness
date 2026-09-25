// The Laya client: the one way KzH asks Laya anything (docs/laya-auto.md 4.5).
//
// laya.serve runs one inference at a time behind one lock and never cancels a request it has
// started, so this client is a gate in front of it:
//   - one request on the wire at a time, because the server runs one anyway, and a second request
//     would only wait in a queue nobody can see (a 3-question intent took 22.7 s instead of 1.3 s
//     behind a 20-question call a client had abandoned);
//   - acting requests (a Laya Auto run's intent, route and review) before the shadow's chunks, first
//     in first out, so an acting request waits for at most one chunk and the acting calls ahead of it;
//   - a deadline per acting call from what this PC measured per token for that phase, and a call
//     predicted to overrun it fails at once rather than queueing work it cannot finish in time;
//   - the caller's signal and the deadline reject the caller's promise at once and never reach the
//     socket: the request in flight keeps its slot until its own response arrives, which is the only
//     exact sign that the server is free again. Past `hardMs` the socket goes and Laya restarts;
//   - no retries, since a retry only queues the same work again; the one exception is a 401, which
//     usually means the SDK client was built before a restart changed the key.
// Each call is rendered for Laya, merged and normalised here (laya-questions.js), so the acting
// path and the shadow path read the same answers, and relabelled with what really answered.
import { TypeSafeClient } from '@typesafe-ai/sdk'
import {
  ADAPTER_VERSION, DEFAULT_CORRECTIONS, DEFAULT_MIN_TOP_MARGIN, LAYA_MODEL,
  estimateRequestTokens, mergeLaya, normalizeLayaAnswers, renderForLaya,
} from './laya-questions.js'
import { checkAnswers } from './laya-selfcheck.js'

/** Every phase KzH asks in, each with its own measured cost per token (4.5). */
export const PHASES = Object.freeze(['intent', 'route', 'review'])
/** A device with no measurement at all: a cautious CPU figure, so the first call is not refused. */
export const DEFAULT_MS_PER_TOKEN = 4
/** Why a shadow call was not compared, as the shadow rows and the card count them (5.3, 8.2). */
export const SKIP_REASONS = Object.freeze(['not_running', 'starting', 'queue_full', 'too_old', 'jev_failed', 'yielded'])

const where = (device) => (device === 'cuda' ? 'GPU' : 'CPU')
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const seconds = (ms) => Math.round(ms / 1000)

/**
 * The error every failed Laya call rejects with: an Error named `Error`, whose message is the reason
 * as the person should read it (`timed out after 40 s`) and whose `code` classifies it, so
 * `describeError` and domains.js print the message as it is (3.5).
 */
export function layaError(code, message, extra = {}) {
  const err = new Error(message, extra.cause ? { cause: extra.cause } : undefined)
  err.code = code
  for (const [k, v] of Object.entries(extra)) if (k !== 'cause' && v !== undefined) err[k] = v
  return err
}

/** Whether the task is mostly in a script other than Latin, which the English checkpoint reads badly (4.4). */
export function langOf(state) {
  const text = typeof state === 'string' ? state : [state?.task, state?.message].filter((s) => typeof s === 'string').join(' ')
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (!letters) return 'latin'
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0
  return latin / letters < 0.5 ? 'non-latin' : 'latin'
}

/** The corrections part of the identity: `choice:11+=3.27`, or `none`. */
const correctionsOf = (c) => Object.entries(c ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',') || 'none'

/** What ended a request that timed out at the hard ceiling: the SDK's own timer, or Node's 300 s headers timeout. */
function hardTimeout(err) {
  if (err?.name === 'APITimeoutError') return true
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) if (e?.code === 'UND_ERR_HEADERS_TIMEOUT') return true
  return false
}

/** Why a caller cannot ask Laya, in words that fit a failed call rather than a refused run (3.5). */
function unavailableReason(err) {
  const detail = err?.detail
  switch (err?.reason) {
    case 'not_installed': return 'Laya is not installed on this PC'
    case 'disabled': return 'Laya is switched off in the configuration'
    case 'invalid': return `Laya's settings are invalid (${detail})`
    case 'failed': return `Laya stopped after an error (${detail ?? 'unknown'})`
    case 'start_failed': return `Laya could not start (${detail ?? 'unknown'})`
    default: return String(err?.message ?? err)
  }
}

/**
 * @param {object} p
 * @param {object} p.sidecar     createLayaSidecar(): ensureReady, connection, isReady, status, installed,
 *   readSettings (the measured figures), noteResult, setPriority, restart
 * @param {object} [p.settings]  the validated `laya` block (providers.js layaSettings): deadlines, shadow,
 *   temperatureCorrections, minTopMargin
 * @param {() => boolean|string} [p.isLocalBusy]  local.isBusy(): a local model request in flight, or its
 *   model's name; a shadow chunk waits while it is, and an acting CPU call says it shares the cores
 * @param {(m: string) => void} [p.log]
 * @param {() => number} [p.now]
 * @param {Function} [p.fetch]   the fetch the SDK uses, for tests
 * @param {object} [p.adapter]   { renderForLaya, mergeLaya, normalizeLayaAnswers }, for tests
 * @param {object} [p.timing]    { waitAfterMs, waitEveryMs, pollMs, exitSettleMs }, for tests
 */
export function createLayaClient({ sidecar, settings, isLocalBusy = () => false, log = () => {}, now = Date.now, fetch, adapter = {}, timing = {} } = {}) {
  const cfg = settings ?? {}
  const D = { floorMs: 8000, ceilingMs: 120_000, hardMs: 270_000, ...cfg.deadlines }
  const S = { maxQueue: 8, maxAgeMs: 600_000, chunkRows: 4, ...cfg.shadow }
  const corrections = cfg.temperatureCorrections ?? DEFAULT_CORRECTIONS
  const minTopMargin = typeof cfg.minTopMargin === 'number' ? cfg.minTopMargin : DEFAULT_MIN_TOP_MARGIN
  const T = { waitAfterMs: 2000, waitEveryMs: 5000, pollMs: 250, exitSettleMs: 1000, ...timing }
  const A = { renderForLaya, mergeLaya, normalizeLayaAnswers, ...adapter }

  // --- the gate ---
  const actQueue = [] // acting calls waiting for the slot, in arrival order
  const shadowQueue = [] // shadow jobs, the one part-way through first
  const shadowById = new Map()
  let waitingShadow = 0 // shadow jobs not started yet: the ones maxQueue counts
  let slot = null // what holds the wire: { kind: 'act' | 'shadow', predictedEndAt }
  let onWire = 0
  let pollTimer = null
  let level = null
  let disposed = false
  const closing = new AbortController() // only dispose() aborts a socket, never a caller
  const counts = {
    answered: 0, partial: 0, failed: 0, skipped: Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])),
    act: { calls: 0, answered: 0, failed: 0 },
  }

  // --- the connection: one SDK client per running instance, rebuilt when the key or port changes ---
  let sdk = null
  function apiFor(conn, { rebuild = false } = {}) {
    // Without a key or an address the SDK would fill either from TYPESAFE_API_KEY and
    // TYPESAFE_BASE_URL, and send the person's TypeSafe secret to whatever answered: never.
    if (typeof conn?.key !== 'string' || !conn.key || typeof conn?.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(conn.url)) {
      throw layaError('LAYA_UNAVAILABLE', 'Laya gave no connection on 127.0.0.1')
    }
    if (rebuild || !sdk || sdk.url !== conn.url || sdk.key !== conn.key) {
      sdk = {
        url: conn.url,
        key: conn.key,
        api: new TypeSafeClient({ apiKey: conn.key, baseURL: conn.url, defaultModel: LAYA_MODEL, retry: { maxRetries: 0 }, timeout: D.hardMs, ...(fetch ? { fetch } : {}) }),
      }
    }
    return sdk.api
  }

  /** The measured ms per token for one phase on one device: its own, else the largest that device has, else 4 (4.5). */
  function msPerToken(device, phase) {
    let m = null
    try { m = sidecar.readSettings?.()?.measured?.[device]?.msPerToken ?? null } catch { m = null }
    if (typeof m?.[phase] === 'number' && m[phase] > 0) return m[phase]
    const known = Object.values(m ?? {}).filter((x) => typeof x === 'number' && x > 0)
    return known.length ? Math.max(...known) : DEFAULT_MS_PER_TOKEN
  }
  const predictMs = (request, device, phase) => estimateRequestTokens(request) * msPerToken(device, phase)
  /** What stands between a new acting call and the wire: the rest of the request in flight, and every acting call queued. */
  const aheadMs = () => Math.max(0, (slot?.predictedEndAt ?? 0) - now()) + sum(actQueue.filter((j) => !j.abandoned).map((j) => j.totalMs))

  function setLevel(next, { force = false } = {}) {
    if (!force && level === next) return
    level = next
    try { sidecar.setPriority?.(next) } catch (err) { log(`laya: priority: ${err.message}`) }
  }

  const note = async (result) => {
    try { return (await sidecar.noteResult?.(result)) ?? {} } catch (err) { log(`laya: ${err.message}`); return {} }
  }

  /** The instance's identity: what decides what Laya answers, never the device or the task (4.5). */
  function identity() {
    let s = null
    try { s = sidecar.status?.() ?? null } catch { s = null }
    const version = s?.installed?.laya ?? sidecar.installed?.()?.laya ?? '?'
    const commit = String(s?.installed?.weights?.commit ?? '?')
    return `laya-${version}|english|${commit.slice(0, 12)}|adapter-${ADAPTER_VERSION}|corr:${correctionsOf(corrections)}|margin:${minTopMargin}`
  }
  /** The model label a trace shows: laya.serve always says `laya-rl-agent`, which names neither checkpoint nor version. */
  function modelLabel(id) {
    const [version, , commit] = id.split('|')
    return `laya-english/${version.replace(/^laya-/, '')}@${commit.slice(0, 7)}`
  }

  /**
   * One HTTP request of a call, already rendered, on the connection given. A 401 rebuilds the client
   * from the sidecar's current connection and is sent once more; anything else fails the request,
   * classified, after the sidecar is told how it went (500 and 401 counting, the idle timer, the
   * measured cost, the GPU spill check).
   */
  async function send(request, conn, { phase, role }) {
    let api = apiFor(conn)
    for (let tries = 0; ; tries++) {
      const t0 = now()
      onWire++
      let data
      try {
        data = await api.systemOne({ model: request.model, state: request.state, questions: request.questions }, { signal: closing.signal })
      } catch (err) {
        const status = typeof err?.status === 'number' ? err.status : null
        // Not awaited: the second 500 or 401 in a row restarts Laya, a stop and a start, and the
        // gate would hold the slot for all of it, the failed call's rejection with it. The call
        // fails now, and the next acting request waits for the start in ensureReady, with its line.
        note({ status, ms: now() - t0, tokens: 0, phase, role })
        // A 401 that began a restart is not sent again to a server that is going away.
        if (status === 401 && tries === 0 && sidecar.isReady?.() !== false) {
          const fresh = sidecar.connection?.() ?? conn
          api = apiFor(fresh, { rebuild: true })
          conn = fresh
          continue
        }
        throw await classify(err, status)
      } finally { onWire-- }
      if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
        await note({ status: 200, ms: now() - t0, tokens: 0, phase, role })
        throw layaError('LAYA_BAD_ANSWER', 'Laya answered with something that is not an answer')
      }
      const noted = await note({ status: 200, ms: now() - t0, tokens: Number(data.usage?.input_tokens) || 0, phase, role })
      return { data, conn, spilling: noted?.line ?? null }
    }
  }

  /** A failed request as the Laya error the caller reads. */
  async function classify(err, status) {
    if (disposed) return layaError('LAYA_UNAVAILABLE', 'Laya was stopped with KzH', { cause: err })
    if (hardTimeout(err)) {
      // A server that has not answered for this long cannot be trusted to be free: restart it.
      log(`laya: a request passed ${seconds(D.hardMs)} s; restarting`)
      try {
        sidecar.restart?.({ reason: 'hung' })?.catch?.((e) => log(`laya: restart after a hung request: ${e.message}`))
      } catch (e) { log(`laya: restart after a hung request: ${e.message}`) }
      return layaError('LAYA_TIMEOUT', `Laya spent over ${seconds(D.hardMs)} s on one request and was restarted`, { cause: err, hard: true })
    }
    if (status === 500) return layaError('LAYA_HTTP_500', `Laya failed on this call (${err?.body?.detail ?? 'inference failed'})`, { cause: err, status })
    if (status != null) return layaError(`LAYA_HTTP_${status}`, `Laya refused this call (HTTP ${status}: ${err?.body?.detail ?? err?.message ?? 'no reason'})`, { cause: err, status })
    // Not the wire at all: the SDK refused the request before sending it.
    if (err?.name !== 'APIConnectionError') return layaError('LAYA_ERROR', `Laya could not be asked (${err?.message ?? err})`, { cause: err })
    // The connection closed under a request: the interpreter exited. Its exit code arrives with the
    // exit, a moment after the socket closes, and a stop on purpose (a yield to a local model, the
    // idle stop, the budget) is `stopping` from before the socket closes until it has ended.
    let s = null
    for (let waited = 0; waited <= T.exitSettleMs; waited += 50) {
      try { s = sidecar.status?.() ?? null } catch { s = null }
      if (s && s.state !== 'ready' && s.state !== 'stopping') break
      // Kept referenced: the caller is waiting for this answer, and it comes within exitSettleMs.
      await new Promise((r) => setTimeout(r, 50))
    }
    if (s?.state === 'stopped' || s?.state === 'stopping') {
      // Stopped on purpose: not a crash, and nothing restarts it. A shadow job skips as the stop
      // says (5.1, 5.2): a yield counts as `yielded`, any other stop as `not_running`.
      const because = s.state === 'stopped' ? s.stoppedBecause ?? null : null
      const why = because === 'yielded' ? `it gave its memory to ${s.why ?? 'a local model'}`
        : because === 'budget' ? `the resource budget${s.why ? `: ${s.why}` : ''}`
          : because === 'idle' ? 'it was idle' : null
      return layaError('LAYA_EXITED', `Laya was stopped while answering${why ? ` (${why})` : ''}`, { cause: err, skip: because === 'yielded' ? 'yielded' : 'not_running' })
    }
    const code = s?.restart?.code ?? s?.lastRestart?.code
    const what = code != null ? `exit code ${code}` : s?.state && s.state !== 'ready' ? 'the process ended' : `the connection closed: ${err?.cause?.message ?? err?.message ?? err}`
    return layaError('LAYA_EXITED', `Laya stopped while answering (${what}); it is restarting`, { cause: err })
  }

  /**
   * Readiness for an acting request (3.5): starts Laya when it is stopped and waits for it, with the
   * Starting Laya line, bounded by the sidecar's startWaitMs. Its refusal is reworded as the reason
   * a call failed, keeping the reply a refused run shows on `reply`.
   */
  async function ready(signal, line) {
    try {
      return await sidecar.ensureReady({ signal, onWait: line })
    } catch (err) {
      if (signal?.aborted && err === signal.reason) throw err
      if (err?.code !== 'LAYA_UNAVAILABLE') throw err
      if (err.reason === 'start_timeout') {
        const n = /still starting after (\d+) s/.exec(String(err.message))?.[1]
        throw layaError('LAYA_TIMEOUT', `timed out: Laya was still starting${n ? ` after ${n} s` : ''}`, { cause: err, reply: err.message, reason: err.reason })
      }
      throw layaError('LAYA_UNAVAILABLE', unavailableReason(err), { cause: err, reply: err.message, reason: err.reason })
    }
  }

  // --- acting calls ---

  function removeQueued(job) {
    const i = actQueue.indexOf(job)
    if (i >= 0) actQueue.splice(i, 1)
  }

  /**
   * One acting call (every request of it) through the gate. Resolves the Answer of 4.5; rejects at
   * the deadline or when the caller's signal fires, at once, while a request already on the wire
   * keeps the slot until its own response arrives.
   */
  async function act({ state, questions }, { signal, phase } = {}, { onWait } = {}) {
    const line = (text) => { try { onWait?.(text) } catch { /* the caller's line */ } }
    signal?.throwIfAborted()
    if (disposed) throw layaError('LAYA_UNAVAILABLE', 'Laya was stopped with KzH')
    counts.act.calls++
    let requests
    try {
      requests = A.renderForLaya({ phase, state, questions }, { role: 'act' })
    } catch (err) {
      counts.act.failed++
      throw layaError('LAYA_ADAPTER', `the Laya adapter could not render this call (${err?.message ?? err})`, { cause: err })
    }
    let conn
    try { conn = await ready(signal, line) } catch (err) { counts.act.failed++; throw err }
    const device = conn?.device ?? 'cpu'
    const predicted = requests.map((r) => predictMs(r, device, phase))
    const totalMs = sum(predicted)
    const deadlineMs = Math.round(clamp(totalMs * 2 + 2000, D.floorMs, D.ceilingMs))
    const rows = requests.reduce((n, r) => n + Object.keys(r.questions).length, 0)
    const ahead = aheadMs()
    if (ahead + totalMs > deadlineMs) {
      counts.act.failed++
      throw layaError('LAYA_PREDICTED_OVER', `Laya would need about ${Math.ceil((ahead + totalMs) / 1000)} s for this call on the ${where(device)}, over its ${seconds(deadlineMs)} s deadline`, { questions: rows, device })
    }
    let shares = false
    try { shares = device === 'cpu' ? isLocalBusy() : false } catch { shares = false }
    if (shares) line(`Laya is sharing the CPU with ${typeof shares === 'string' ? shares : 'the local model'}, so this call may take longer`)

    return new Promise((resolve, reject) => {
      const job = {
        kind: 'act', phase, state, questions, requests, predicted, totalMs, deadlineMs, rows, device, line,
        enqueuedAt: now(), startedAt: null, abandoned: false, settled: false, gone: new AbortController(), timers: {},
      }
      const cleanup = () => {
        clearTimeout(job.timers.deadline)
        clearTimeout(job.timers.wait)
        if (signal && job.onAbort) signal.removeEventListener('abort', job.onAbort)
      }
      job.resolve = (v) => { if (job.settled) return; job.settled = true; cleanup(); counts.act.answered++; resolve(v) }
      job.reject = (e) => { if (job.settled) return; job.settled = true; cleanup(); counts.act.failed++; reject(e) }
      // Abandoned: the caller has its answer (an error) and nothing more of this call is sent. A
      // request on the wire keeps the slot until its response arrives; one still queued never goes.
      job.abandon = (err) => {
        job.abandoned = true
        job.gone.abort(err)
        removeQueued(job)
        job.reject(err)
        if (!slot) pump()
      }
      job.deadlineAt = now() + deadlineMs
      job.arm = () => {
        clearTimeout(job.timers.deadline)
        job.timers.deadline = setTimeout(() => job.abandon(layaError('LAYA_TIMEOUT', `timed out after ${seconds(deadlineMs)} s`, { questions: rows, device })), Math.max(0, job.deadlineAt - now()))
      }
      job.arm()
      if (signal) {
        job.onAbort = () => job.abandon(signal.reason)
        // Stopped while Laya was found ready: nothing is queued.
        if (signal.aborted) { job.abandon(signal.reason); return }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      // The visible wait (3.3): after 2 s in the gate, then every 5 s until it goes out.
      const waitLine = () => {
        if (job.startedAt != null || job.settled) return
        line(`Waiting for Laya: it is answering an earlier call (${seconds(now() - job.enqueuedAt)} s)…`)
        job.timers.wait = setTimeout(waitLine, T.waitEveryMs)
      }
      job.timers.wait = setTimeout(waitLine, T.waitAfterMs)
      actQueue.push(job)
      // Behind a shadow chunk, the interpreter works at normal priority at once, so the chunk ends sooner.
      if (slot?.kind === 'shadow') setLevel('normal', { force: true })
      pump()
    })
  }

  async function runAct(job) {
    job.startedAt = now()
    clearTimeout(job.timers.wait)
    slot = { kind: 'act', predictedEndAt: now() + job.totalMs }
    const parts = []
    let failure = null
    let spillLine = null
    try {
      for (let i = 0; i < job.requests.length; i++) {
        if (job.abandoned) break
        // Readiness per request (3.5): a Laya that crashed or restarted since the last request is
        // started again and waited for, bounded by the sidecar's startWaitMs, and the wait is not
        // counted against the call's deadline, so the call's whole bound is its deadline plus that.
        const waiting = !sidecar.isReady?.()
        const left = job.deadlineAt - now()
        if (waiting) clearTimeout(job.timers.deadline)
        const conn = await ready(job.gone.signal, job.line)
        if (waiting && !job.abandoned) { job.deadlineAt = now() + left; job.arm() }
        if (job.abandoned) break
        setLevel('normal', { force: true })
        slot.predictedEndAt = now() + sum(job.predicted.slice(i))
        const r = job.requests[i]
        const out = await send(r, conn, { phase: job.phase, role: 'act' })
        parts.push({ key: r.key, response: out.data, device: out.conn.device ?? conn.device })
        spillLine ??= out.spilling
      }
    } catch (err) {
      failure = job.abandoned ? null : err
    } finally {
      slot = null
      if (!actQueue.some((j) => !j.abandoned)) setLevel('below_normal')
      schedulePump()
    }
    if (job.settled) return
    if (failure) { job.reject(failure); return }
    try {
      if (spillLine) job.line(spillLine)
      job.resolve(answerOf(job, parts, { waitedMs: job.startedAt - job.enqueuedAt, extra: { predictedMs: Math.round(job.totalMs), deadlineMs: job.deadlineMs } }))
    } catch (err) {
      job.reject(err)
    }
  }

  /**
   * The Answer of one call from the responses of its requests: merged, checked, normalised, and
   * relabelled (4.5). Throws LAYA_BAD_ANSWER on a response that is not a sound answer to what was asked.
   */
  function answerOf(job, parts, { waitedMs = 0, partial = false, extra = {} } = {}) {
    const merged = A.mergeLaya({ phase: job.phase, questions: job.questions }, parts)
    const asked = partial
      ? Object.fromEntries(parts.flatMap((p) => Object.keys(p.response?.answers ?? {})).filter((n) => job.questions[n]).map((n) => [n, job.questions[n]]))
      : job.questions
    const problems = checkAnswers(job.phase, asked, merged.answers)
    if (problems.length) throw layaError('LAYA_BAD_ANSWER', `Laya's answer did not fit the questions (${problems[0]})`)
    const norm = A.normalizeLayaAnswers(merged.answers, job.questions, { temperatureCorrections: corrections, minTopMargin })
    const id = identity()
    return {
      model: modelLabel(id),
      answers: norm.answers,
      usage: merged.usage,
      meta: {
        provider: 'laya',
        device: parts.at(-1)?.device ?? job.device ?? null,
        waitedMs,
        requests: merged.meta.requests,
        rows: merged.meta.rows,
        atContextLimit: merged.meta.atContextLimit,
        uninformative: norm.uninformative,
        corrected: norm.corrected,
        lang: langOf(job.state),
        identity: id,
        ...extra,
      },
    }
  }

  // --- the shadow's jobs ---

  /** Why a shadow call finds no Laya to ask: it never starts one (5.1). */
  function notReadyReason() {
    let s = null
    try { s = sidecar.status?.() ?? null } catch { s = null }
    if (s?.state === 'starting' || s?.state === 'restarting') return 'starting'
    if (s?.stoppedBecause === 'yielded') return 'yielded'
    return 'not_running'
  }

  function finishShadow(job, result) {
    if (job.finished) return
    job.finished = true
    if (!job.startedAt) waitingShadow--
    const i = shadowQueue.indexOf(job)
    if (i >= 0) shadowQueue.splice(i, 1)
    shadowById.delete(job.callId)
    if (result.status === 'skipped') counts.skipped[result.reason] = (counts.skipped[result.reason] ?? 0) + 1
    else counts[result.status]++
    const out = { queuedMs: (job.startedAt ?? now()) - job.queuedAt, ms: job.startedAt ? now() - job.startedAt : 0, ...result }
    try { job.onDone?.(out) } catch (err) { log(`laya shadow: ${err.message}`) }
  }

  /** A job that stops before its last chunk: `partial` with the answers it has, or skipped for `reason`. */
  function stopShadow(job, reason) {
    if (job.parts.length && reason === 'too_old') {
      try {
        return finishShadow(job, { status: 'partial', reason, answer: answerOf(job, job.parts, { waitedMs: job.startedAt - job.queuedAt, partial: true }) })
      } catch (err) {
        return finishShadow(job, { status: 'failed', reason: err.code ?? 'error', error: err })
      }
    }
    return finishShadow(job, { status: 'skipped', reason })
  }

  async function runShadowChunk(job, conn) {
    const request = job.requests[job.next++]
    slot = { kind: 'shadow', predictedEndAt: now() + predictMs(request, conn.device ?? 'cpu', job.phase) }
    if (!job.startedAt) { job.startedAt = now(); waitingShadow-- }
    setLevel('below_normal')
    let failure = null
    try {
      const out = await send(request, conn, { phase: job.phase, role: 'shadow' })
      job.parts.push({ key: request.key, response: out.data, device: out.conn.device ?? conn.device })
    } catch (err) {
      failure = err
    } finally {
      slot = null
      schedulePump()
    }
    if (job.finished) return
    if (job.withdrawn) { stopShadow(job, job.withdrawn); return }
    // Laya stopped on purpose under the chunk: a comparison skipped, never a failure of Laya's.
    if (failure?.skip) { stopShadow(job, failure.skip); return }
    if (failure) { finishShadow(job, { status: 'failed', reason: failure.code === 'LAYA_TIMEOUT' ? 'timeout' : failure.code ?? 'error', error: failure }); return }
    if (job.next < job.requests.length) return
    try {
      finishShadow(job, { status: 'answered', reason: null, answer: answerOf(job, job.parts, { waitedMs: job.startedAt - job.queuedAt }) })
    } catch (err) {
      finishShadow(job, { status: 'failed', reason: err.code ?? 'error', error: err })
    }
  }

  // --- the pump: acting calls first, then the shadow's oldest job, one request at a time ---

  let pumpScheduled = false
  function schedulePump() {
    if (pumpScheduled) return
    pumpScheduled = true
    setImmediate(() => { pumpScheduled = false; pump() })
  }

  function pump() {
    if (slot || disposed) return
    while (actQueue.length) {
      const job = actQueue.shift()
      if (job.abandoned || job.settled) continue
      runAct(job)
      return
    }
    while (shadowQueue.length) {
      const job = shadowQueue[0]
      if (job.withdrawn) { stopShadow(job, job.withdrawn); continue }
      if (now() - job.queuedAt > S.maxAgeMs) { stopShadow(job, 'too_old'); continue }
      const conn = sidecar.isReady?.() ? sidecar.connection?.() ?? null : null
      if (!conn) { stopShadow(job, notReadyReason()); continue }
      // Never beside a local model's request, whatever Laya's device: the chunk waits, and ages.
      let localBusy = false
      try { localBusy = !!isLocalBusy() } catch { localBusy = false }
      if (localBusy) { poll(); return }
      if (!job.requests) {
        try {
          job.requests = A.renderForLaya({ phase: job.phase, state: job.state, questions: job.questions }, { role: 'shadow', chunkRows: S.chunkRows })
        } catch (err) {
          finishShadow(job, { status: 'failed', reason: 'LAYA_ADAPTER', error: err })
          continue
        }
        if (!job.requests.length) { finishShadow(job, { status: 'failed', reason: 'LAYA_ADAPTER', error: new Error('nothing to ask') }); continue }
      }
      runShadowChunk(job, conn)
      return
    }
    if (!actQueue.length) setLevel('below_normal')
  }

  function poll() {
    if (pollTimer) return
    pollTimer = setTimeout(() => { pollTimer = null; pump() }, T.pollMs)
    pollTimer.unref?.()
  }

  /**
   * Offer one Jev call for Laya to answer in the background (5.2). Synchronous and O(1): it only
   * checks and queues the call as jev.js built it; rendering happens later, in the gate. Returns
   * `{ queued: true }`, and then `onDone` gets `{ status, reason, answer?, error?, queuedMs, ms }`
   * once, with status `answered`, `partial`, `skipped` or `failed`; or `{ dropped: reason }` at
   * once, and `onDone` is never called.
   */
  function offerShadow({ callId, runId = null, phase, state, questions, context = null, onDone } = {}) {
    const drop = (reason) => { counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1; return { dropped: reason } }
    if (disposed) return drop('not_running')
    if (!sidecar.isReady?.()) return drop(notReadyReason())
    if (waitingShadow >= S.maxQueue) return drop('queue_full')
    const job = {
      kind: 'shadow', callId, runId, phase, state, questions, context, onDone,
      queuedAt: now(), startedAt: null, requests: null, next: 0, parts: [], withdrawn: null, finished: false,
    }
    shadowQueue.push(job)
    if (callId != null) shadowById.set(callId, job)
    waitingShadow++
    schedulePump()
    return { queued: true }
  }

  /**
   * Drop a shadow job that has not finished: at once when it has not started; otherwise its chunk on
   * the wire finishes and nothing more of it is sent. Its `onDone` gets `skipped` with `reason`.
   */
  function withdraw(callId, reason = 'jev_failed') {
    const job = shadowById.get(callId)
    if (!job || job.finished) return false
    if (!job.startedAt) finishShadow(job, { status: 'skipped', reason })
    else job.withdrawn = reason
    return true
  }

  /** A role's client, in the shape createJev takes: `systemOne(body, { signal, phase })`. */
  function client(role = 'act', { runId = null, onWait } = {}) {
    if (role === 'shadow') {
      // A background caller: never starts Laya, and rides the shadow's queue at its priority.
      return {
        systemOne: ({ state, questions }, { phase } = {}) => new Promise((resolve, reject) => {
          const offered = offerShadow({
            callId: null, runId, phase, state, questions,
            onDone: (r) => (r.status === 'answered' ? resolve(r.answer) : reject(r.error ?? layaError('LAYA_UNAVAILABLE', `Laya did not answer (${r.reason})`))),
          })
          if (offered.dropped) reject(layaError('LAYA_UNAVAILABLE', `Laya did not answer (${offered.dropped})`))
        }),
      }
    }
    if (role !== 'act') throw new Error("laya client: role is 'act' or 'shadow'")
    return { systemOne: (body, options) => act(body, options, { onWait }) }
  }

  return {
    client,
    offerShadow,
    withdraw,
    /** What the gate has done: acting calls, and the shadow's jobs by how they ended. */
    counters: () => ({ ...counts, skipped: { ...counts.skipped }, act: { ...counts.act } }),
    /** A request on the wire: the sidecar reads it so a /health miss while Laya computes is not counted. */
    busy: () => onWire > 0,
    identity,
    /** Stop: every queued call fails, and a request on the wire is abandoned with its socket. */
    dispose() {
      disposed = true
      clearTimeout(pollTimer)
      for (const job of actQueue.splice(0)) job.reject(layaError('LAYA_UNAVAILABLE', 'Laya was stopped with KzH'))
      for (const job of [...shadowQueue]) stopShadow(job, 'not_running')
      closing.abort()
    },
  }
}
