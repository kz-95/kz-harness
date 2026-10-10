// colibri's C Laya beside laya.serve: a comparison, never a decider (docs/laya-auto.md 13).
//
// colibri, an open-source inference engine written in C, serves a native port of Laya on its own
// `POST /v1/systemone`, with the request and reply of TypeSafe's Jev API. The owner runs it
// themselves with its Laya engine; KzH installs nothing of colibri and knows only its address, the
// Laya setting `colibriUrl` (empty, the default, is off). While it is set, every request laya.serve
// answers for a Laya Auto run or for the shadow in Jev Auto is also asked of colibri, exactly as it
// was sent: the Laya client hands it over once laya.serve has answered (`offer`, synchronous), and
// nothing a run waits on waits for it. One request at a time, each with a short deadline, and a new
// one is dropped, and counted, while one is on its way or a local model is answering, or, with
// laya.serve on the CPU, while laya.serve has more to answer at once, whose cores colibri's engine
// would take.
//
// Both answers go side by side into colibri-laya.jsonl, under colibri's own provider record, and
// nowhere else: no training store, no standing, nothing that learns from it, and nothing colibri
// answers decides anything. colibri's three gaps against laya.serve are met here, and each is said
// in the record and on the Laya card:
//   - its /health lists no loaded model, so it counts as reachable once it has answered one tiny
//     test question;
//   - it ignores the `labels` KzH gives every noul (the workaround for Laya issue #156), so each noul
//     goes as KzH sends it and its row says colibri read it in its raw false/true form;
//   - its noul answers carry no confidence, so each is recorded with its confidence unknown and left
//     out of every figure that needs one.
//
// Requests go only to the loopback address set, over plain http, with no key at all: never
// laya.serve's per-start key, never the TypeSafe key. A row holds answers and numbers only, no
// state, task text or question text, the rule laya-shadow.jsonl keeps (shadow.js).
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { basename, dirname } from 'node:path'

/** colibri's own provider record (2.1): it answers beside Laya, and decides and teaches nothing. */
export const COLIBRI = Object.freeze({ id: 'colibri', name: 'colibri Laya', teacher: false, local: true, decides: false })
/** Rows colibri-laya.jsonl keeps, the newest; a 20-question route row is about 3 KB. */
export const COLIBRI_CAP = 2000
/** How far apart two scores may be, in levels of the scale, and still agree. */
export const SCORE_TOLERANCE = 0.5
/** Rows past the cap before the file is rewritten to it, at most the cap itself. */
const SLACK = 200
/** The most of an answer read: colibri's answer to 64 questions is well under it. */
const MAX_REPLY_BYTES = 1 << 20
/** The one tiny question that tells colibri is up and answering, since its /health lists no loaded model. */
const TEST_QUESTION = JSON.stringify({ model: 'english', state: 'KzH checks that colibri answers.', questions: { ready: { type: 'noul', instructions: 'Is this a test?' } } })
const HOW_READY = "one test question, since colibri's /health lists no loaded model"

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const r3 = (x) => (num(x) == null ? null : Math.round(x * 1000) / 1000)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const seconds = (ms) => Math.max(1, Math.round(ms / 1000))
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Text the server at the address sent, kept to one plain line: each run of line breaks, spaces or control codes is one space. */
const plain = (s, n) => clip(String(s).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(), n)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
/** A tool parameter's question (`<tool>.<param>`): its option keys are config the person wrote (shadow.js). */
const isToolParam = (name) => name.includes('.') && !name.startsWith('req.') && !name.endsWith('.fits')

/** The option keys of a question in the order it asked them, which is the order of `p`. */
function keysOf(q) {
  if (q?.type === 'choice') return Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q?.criteria ?? {})
  if (q?.type === 'score') return (Array.isArray(q.criteria) ? q.criteria : []).map((_, i) => String(i))
  return null
}

/**
 * Why `value` cannot be the colibri Laya address, or null when it can: empty (off), or plain http on
 * this PC (127.0.0.1 or another 127 address, localhost or [::1]) with its port, and nothing more.
 * @param {unknown} value
 * @returns {string|null}
 */
export function colibriAddressProblem(value) {
  const say = (what) => `colibri Laya address: ${what}`
  if (typeof value !== 'string') return say('text such as http://127.0.0.1:8000, or empty for off')
  if (value === '') return null
  if (value !== value.trim()) return say('no spaces around it')
  let url = null
  try { url = new URL(value) } catch { /* refused below */ }
  if (!url) return say(`'${clip(value, 60)}' is not an address; give one such as http://127.0.0.1:8000`)
  if (url.protocol !== 'http:') return say(`plain http, as colibri serves it on this PC, not ${url.protocol.slice(0, -1)}`)
  if (url.username || url.password) return say('no user name or password in it')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== 'localhost' && host !== '::1' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return say(`this PC only (127.0.0.1, localhost or [::1]), not ${url.hostname}`)
  // Checked on the text: the URL drops a port 80 written out as the default.
  if (!/^http:\/\/(\[[^\]]+\]|[^/:]+):\d+\/?$/i.test(value)) {
    return url.pathname !== '/' || url.search || url.hash ? say('the server only, with no path, such as http://127.0.0.1:8000') : say('with its port, such as http://127.0.0.1:8000')
  }
  if (Number(url.port || 80) < 1) return say('a port from 1 to 65535')
  return null
}

/**
 * One served answer as a row keeps it, the way laya-shadow.jsonl keeps Laya's (shadow.js): the pick
 * (a choice's key, a tool parameter's index, a score's expected level, a noul's P(true)), the
 * probabilities in the question's option order, and the confidence as served, null where none came,
 * each to 3 decimals; `at` and `probs` are the unrounded pick and probabilities, for the comparison
 * and never written. Null when it is not an answer to the question.
 */
function side(q, a) {
  if (!q || !a || typeof a !== 'object') return null
  if (q.type === 'noul') {
    const p = num(a.noul)
    return p == null || p < 0 || p > 1 ? null : { answer: r3(p), p: r3(p), confidence: r3(a.confidence), at: p }
  }
  const listed = q.keys && a.probabilities && typeof a.probabilities === 'object' ? q.keys.map((k) => num(a.probabilities[k])) : null
  const probs = listed && listed.every((x) => x != null) ? listed : null
  if (q.type === 'score') {
    const s = num(a.score)
    return s == null ? null : { answer: r3(s), p: probs && probs.map(r3), confidence: r3(a.confidence), at: s, probs }
  }
  if (q.type !== 'choice' || typeof a.choice !== 'string' || !q.keys?.includes(a.choice)) return null
  return { answer: isToolParam(q.name) ? `#${q.keys.indexOf(a.choice)}` : a.choice, p: probs && probs.map(r3), confidence: r3(a.confidence), at: a.choice, probs }
}

/**
 * Both answers to one question as its row keeps them: whether they agree (the same choice, scores
 * within SCORE_TOLERANCE, nouls on the same side of 0.5) and how far apart they are (half the summed
 * difference of a choice's probabilities, the difference of two scores or of two P(true)), and
 * colibri's two gaps where they touch it.
 */
function pair(q, l, c) {
  const keep = (s) => (s ? { answer: s.answer, p: s.p, confidence: s.confidence } : null)
  const out = { type: q.type, laya: keep(l), colibri: keep(c) }
  // colibri ignores KzH's noul labels: it read this noul with its sides named false and true.
  if (q.labels) out.colibriSaw = 'raw'
  // colibri gives a noul no confidence: unknown, and left out of every figure that needs one.
  if (c && c.confidence == null) out.confidenceUnknown = true
  out.agree = null
  out.gap = null
  if (!l || !c) return out
  if (q.type === 'noul') {
    out.agree = (l.at >= 0.5) === (c.at >= 0.5)
    out.gap = r3(Math.abs(l.at - c.at))
  } else if (q.type === 'score') {
    const d = Math.abs(l.at - c.at)
    out.agree = d <= SCORE_TOLERANCE + 1e-9
    out.gap = r3(d)
  } else {
    out.agree = l.at === c.at
    out.gap = l.probs && c.probs ? r3(l.probs.reduce((s, x, i) => s + Math.abs(x - c.probs[i]), 0) / 2) : null
  }
  return out
}

/** A refusal in colibri's own words: its error envelope's message, or a `detail`. */
function refusalOf(r) {
  if (r.status === 401) return 'colibri asks for an API key (HTTP 401), and KzH sends it none: start colibri without COLI_API_KEY, which it allows on this PC'
  const said = r.json?.error?.message ?? r.json?.detail
  const text = typeof said === 'string' ? said : said != null ? JSON.stringify(said) : 'no reason given'
  return `colibri refused it (HTTP ${r.status}: ${plain(text, 200)})`
}

/** Why a request got no answer at all: `timeout` past its deadline, else `unreachable`. */
function failureOf(err, at, ms, what) {
  if (err?.code === 'DEADLINE') return { reason: 'timeout', why: `colibri did not answer ${what} within ${seconds(ms)} s` }
  if (err?.code === 'ECONNREFUSED') return { reason: 'unreachable', why: `nothing answers at ${at}: start colibri with its Laya engine, or empty the address` }
  return { reason: 'unreachable', why: `colibri could not be asked at ${at} (${err?.code ?? err?.message ?? err})` }
}

/**
 * The comparison with colibri's Laya (13). Nothing starts until the Laya client offers it a request
 * laya.serve answered, or `check()` asks the test question; `dispose()` ends it.
 * @param {object} p
 * @param {string} p.file                 colibri-laya.jsonl in the plugin's data folder
 * @param {() => string} p.address        the Laya setting `colibriUrl`; '' is off
 * @param {() => unknown} [p.isLocalBusy] local.isBusy(): a local model request is in flight
 * @param {(m: string) => void} [p.log]
 * @param {() => number} [p.now]
 * @param {object} [p.timing]             { checkMs, minMs, maxMs, recheckMs }, for tests
 * @param {number} [p.cap]                rows the file keeps
 */
export function createColibriLaya({ file, address = () => '', isLocalBusy = () => false, log = () => {}, now = Date.now, timing = {}, cap = COLIBRI_CAP } = {}) {
  // The test question's deadline; a comparison's, twice what laya.serve took for it within
  // [minMs, maxMs]; and how long colibri found unreachable is left alone.
  const T = { checkMs: 10_000, minMs: 10_000, maxMs: 60_000, recheckMs: 60_000, ...timing }
  const closing = new AbortController() // only dispose() aborts a request
  const iso = () => new Date(now()).toISOString()
  let disposed = false
  let slot = null // the one request to colibri on its way, a test question or a comparison
  let probing = false
  const fresh = (at) => ({ address: at, ok: null, why: null, at: null, ms: null, model: null })
  let ready = fresh(null)
  const dropped = { busy: 0, local_busy: 0, laya_busy: 0, not_reachable: 0 }
  let rows = [] // what the figures need of each comparison row, oldest first, at most `cap`
  let onDisk = 0
  let saving = load()

  /** The address now, or '' while it is off or is not one this may send to. */
  function current() {
    let at = ''
    try { at = String(address() ?? '') } catch { at = '' }
    return at && colibriAddressProblem(at) == null ? at : ''
  }

  /** What came back from `at` may still be kept: not closed, and `at` still the address set, not emptied or changed meanwhile. */
  const still = (at) => !disposed && current() === at

  // --- the record ---

  /** What the figures need of a comparison row; a row of another kind has none. */
  function brief(row) {
    if (row?.kind !== 'compare') return null
    return {
      ts: row.ts, status: row.status, reason: row.reason ?? null,
      layaMs: num(row.laya?.ms), colibriMs: row.status === 'failed' ? null : num(row.colibri?.ms),
      q: Object.values(row.questions ?? {}).map((x) => ({
        type: x?.type, agree: typeof x?.agree === 'boolean' ? x.agree : null, gap: num(x?.gap),
        raw: x?.colibriSaw === 'raw', unknown: x?.confidenceUnknown === true, lc: num(x?.laya?.confidence), cc: num(x?.colibri?.confidence),
      })),
    }
  }

  /** The newest rows on disk, read once at start, before anything is written. */
  async function load() {
    let text
    try { text = await readFile(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') log(`colibri: ${basename(file)} not read: ${err.message}`); return }
    const lines = text.split('\n').filter(Boolean)
    onDisk = lines.length
    const older = []
    for (const line of lines.slice(-cap)) {
      let row = null
      try { row = JSON.parse(line) } catch { continue } // a line a crash cut short
      const b = brief(row)
      if (b) older.push(b)
    }
    rows = [...older, ...rows].slice(-cap)
  }

  /** The file cut back to its newest rows: written whole to a temporary file and renamed over it. */
  async function trim() {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-cap)
    await writeFile(`${file}.tmp`, lines.map((l) => `${l}\n`).join(''))
    await rename(`${file}.tmp`, file)
    onDisk = lines.length
  }

  /** One row: into the figures at once, and onto the end of the file after every write before it. */
  function record(row) {
    if (disposed) return
    const b = brief(row)
    if (b) {
      rows.push(b)
      if (rows.length > cap) rows.splice(0, rows.length - cap)
    }
    const line = `${JSON.stringify(row)}\n`
    saving = saving.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line)
      onDisk++
      if (onDisk > cap + Math.min(SLACK, cap)) await trim()
    }).catch((err) => log(`colibri: a row was not saved: ${err.message}`))
  }

  // --- the wire ---

  /**
   * One POST /v1/systemone to colibri, with no key of any kind: settles with the status and the
   * parsed answer, or rejects with the connection's error, or with code DEADLINE past `ms`.
   */
  function post(at, body, ms) {
    return new Promise((resolve, reject) => {
      let timer = null
      let deadline = null
      const settle = (fn, v) => { clearTimeout(timer); fn(v) }
      const fail = (err) => settle(reject, deadline ?? err)
      let req
      try {
        req = httpRequest(new URL('/v1/systemone', at), {
          method: 'POST', agent: false, signal: closing.signal,
          // No authorization: colibri on this PC needs none, and no key KzH holds is colibri's.
          headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
          const chunks = []
          let size = 0
          res.on('data', (c) => {
            size += c.length
            if (size > MAX_REPLY_BYTES) req.destroy(new Error('its answer was over 1 MB'))
            else chunks.push(c)
          })
          res.on('end', () => {
            let json = null
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json = null }
            settle(resolve, { status: res.statusCode, json })
          })
          res.on('error', fail)
          res.on('close', () => { if (!res.complete) fail(Object.assign(new Error('the connection closed before the answer was complete'), { code: 'ECONNRESET' })) })
        })
      } catch (err) { reject(err); return }
      timer = setTimeout(() => {
        deadline = Object.assign(new Error(`no answer within ${seconds(ms)} s`), { code: 'DEADLINE' })
        req.destroy(deadline)
      }, ms)
      // A comparison keeps nothing alive: the socket does while it is open, and dispose() closes it.
      timer.unref?.()
      req.on('error', fail)
      req.end(body)
    })
  }

  /** The one request at a time: `work` holds the slot until it has settled, and never throws. */
  function occupy(work) {
    const p = (async () => { try { await work() } catch (err) { log(`colibri: ${err.message}`) } })()
    slot = p
    p.then(() => {
      if (slot === p) slot = null
      // An address saved while the slot was taken is checked as soon as it is free.
      const at = current()
      if (!disposed && !slot && at && (ready.address !== at || ready.ok == null)) occupy(() => probe(at))
    })
    return p
  }

  // --- readiness: the test question ---

  /** Readiness as last found, recorded when it changes, so the record says how it was decided without a row per check. */
  function settleReady(at, { ok, why, ms = null, model = null }) {
    const was = ready
    ready = { address: at, ok, why, at: now(), ms, model: ok ? model : null }
    if (was.address !== at || was.ok !== ok || was.why !== why || was.model !== ready.model) {
      record({ v: 1, id: randomUUID(), ts: iso(), provider: COLIBRI.id, kind: 'readiness', used: false, address: at, ok, why, ms, model: ready.model, how: HOW_READY })
    }
  }

  /** The test question: colibri counts as reachable once it has answered it, in its own shape. */
  async function probe(at) {
    probing = true
    const t0 = now()
    let why = null
    let model = null
    try {
      const r = await post(at, TEST_QUESTION, T.checkMs)
      const a = r.json?.answers?.ready
      if (r.status !== 200) why = refusalOf(r)
      else if (a?.type !== 'noul' || num(a.noul) == null) why = `the server at ${at} answered the test question with something that is not a System One answer`
      else if (r.json.provider !== COLIBRI.id) why = `the server at ${at} is not colibri: its answer names no colibri provider`
      else model = typeof r.json.model === 'string' ? plain(r.json.model, 80) : null
    } catch (err) {
      why = failureOf(err, at, T.checkMs, 'the test question').why
    } finally {
      probing = false
    }
    if (!still(at)) return false
    settleReady(at, { ok: why == null, why, ms: now() - t0, model })
    return why == null
  }

  // --- the comparison ---

  /** The row of one comparison: both answers to each question, or why colibri gave none. */
  function rowOf(job, { r, err, ms, deadlineMs }) {
    const row = {
      v: 1, id: randomUUID(), ts: iso(), provider: COLIBRI.id, kind: 'compare', used: false,
      runId: job.runId, role: job.role, phase: job.phase, address: job.at,
      laya: { ms: job.laya.ms, device: job.laya.device, model: job.laya.model, tokens: job.laya.tokens },
    }
    if (err || r.status !== 200) {
      const f = err ? failureOf(err, job.at, deadlineMs, 'this request') : { reason: 'refused', why: refusalOf(r) }
      // A colibri gone, or one that now wants a key, is left alone until recheckMs has passed.
      if (f.reason === 'unreachable' || r?.status === 401) settleReady(job.at, { ok: false, why: f.why })
      return { ...row, status: 'failed', reason: f.reason, why: f.why, colibri: { ms, deadlineMs, status: r?.status ?? null } }
    }
    const got = r.json?.answers
    if (!got || typeof got !== 'object') {
      return { ...row, status: 'failed', reason: 'bad_answer', why: 'colibri answered with something that is not a System One answer', colibri: { ms, deadlineMs, status: 200 } }
    }
    const questions = {}
    let missing = 0
    for (const q of job.asked) {
      const c = side(q, got[q.name])
      if (!c) missing++
      questions[q.name] = pair(q, job.laya.answers[q.name], c)
    }
    return {
      ...row,
      status: missing ? 'partial' : 'answered',
      reason: missing ? 'bad_answer' : null,
      why: missing ? `colibri gave no usable answer to ${missing} of ${job.asked.length} questions` : null,
      colibri: { ms, deadlineMs, status: 200, model: typeof r.json.model === 'string' ? plain(r.json.model, 80) : null, tokens: num(Number(r.json.usage?.input_tokens)) },
      questions,
    }
  }

  /** The server log's line for a row, as the shadow writes one per comparison (5.3). */
  function line(row) {
    if (row.status === 'failed') return `colibri Laya ${row.phase ?? 'call'}: not compared (${row.why})`
    const qs = Object.values(row.questions).filter((q) => q.agree != null)
    return `colibri Laya ${row.phase ?? 'call'}: ${qs.length} answered in ${row.colibri.ms} ms (laya.serve ${row.laya.ms ?? '?'} ms), ${qs.filter((q) => q.agree).length}/${qs.length} agree with laya.serve`
  }

  /** One comparison: the test question first while readiness is not known, then the request as laya.serve was sent it. */
  async function compare(job) {
    if (ready.address !== job.at || ready.ok !== true) {
      if (!(await probe(job.at))) {
        if (still(job.at)) dropped.not_reachable++
        return
      }
    }
    if (!still(job.at)) return
    const deadlineMs = Math.round(clamp((job.laya.ms ?? 0) * 2, T.minMs, T.maxMs))
    const t0 = now()
    let r = null
    let err = null
    try { r = await post(job.at, job.body, deadlineMs) } catch (e) { err = e }
    // Closed under it, or its address emptied or changed meanwhile: nothing of it is written.
    if (!still(job.at)) return
    const row = rowOf(job, { r, err, ms: now() - t0, deadlineMs })
    record(row)
    log(line(row))
  }

  const drop = (reason) => { dropped[reason]++; return { dropped: reason } }

  /**
   * A request laya.serve answered, as the Laya client's `onAnswered` hands it over: asked of
   * colibri too once nothing is in the way. Synchronous, never throws, and nothing waits for what
   * comes of it. `more` says laya.serve has more to answer at once: another request of the same call,
   * or another call waiting. Returns `{ queued: true }`, `{ dropped: reason }` (counted: `busy`,
   * `local_busy`, `laya_busy`, `not_reachable`) or `{ skipped: reason }` (no comparison was due: `off`,
   * `not_a_run`, `no_answer`).
   */
  function offer({ request, response, ms = null, phase = null, role = null, runId = null, device = null, more = false } = {}) {
    try {
      const at = current()
      if (disposed || !at) return { skipped: 'off' }
      // KzH's real questions only: a Laya Auto run's and the shadow's, never Test Laya's fixed calls.
      if (role !== 'shadow' && runId == null) return { skipped: 'not_a_run' }
      if (!request?.questions || typeof request.questions !== 'object' || !response?.answers || typeof response.answers !== 'object') return { skipped: 'no_answer' }
      if (slot) return drop('busy')
      let busy = false
      try { busy = !!isLocalBusy() } catch { busy = false }
      if (busy) return drop('local_busy')
      // On the CPU colibri's engine would take the cores laya.serve answers its next request on.
      if (device === 'cpu' && more) return drop('laya_busy')
      if (ready.address === at && ready.ok === false && now() - ready.at < T.recheckMs) return drop('not_reachable')
      const asked = Object.entries(request.questions).map(([name, q]) => ({ name, type: q?.type, keys: keysOf(q), labels: q?.type === 'noul' && !!q.labels }))
      const job = {
        at, phase, role, runId,
        // The request as laya.serve was sent it, noul labels and all: colibri ignores the labels.
        body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
        asked,
        laya: {
          ms: num(ms), device, model: typeof response.model === 'string' ? clip(response.model, 80) : null, tokens: num(Number(response.usage?.input_tokens)),
          answers: Object.fromEntries(asked.map((q) => [q.name, side(q, response.answers[q.name])])),
        },
      }
      occupy(() => compare(job))
      return { queued: true }
    } catch (err) {
      log(`colibri: ${err.message}`)
      return { skipped: 'error' }
    }
  }

  /**
   * Readiness asked again now, as when the address was saved: the test question goes as soon as
   * nothing else is on its way. Resolves with what it found, or null when it is still to come.
   */
  function check() {
    const at = current()
    if (disposed || !at) return Promise.resolve(null)
    ready = fresh(at)
    // Behind a request on its way, the slot's end starts the test question (occupy).
    return (slot ?? occupy(() => probe(at))).then(() => ready.ok)
  }

  /** The figures the Laya card and GET /jev-router/laya/colibri show, from the rows kept. */
  function summary() {
    const at = current()
    const tally = () => ({ compared: 0, agreed: 0, gaps: [], layaConfidence: [], colibriConfidence: [] })
    const types = { choice: tally(), score: tally(), noul: tally() }
    const failed = { timeout: 0, unreachable: 0, refused: 0, bad_answer: 0 }
    const layaMs = []
    const colibriMs = []
    let requests = 0
    let partial = 0
    let questions = 0
    let raw = 0
    let unknown = 0
    for (const r of rows) {
      if (r.status === 'failed') { failed[r.reason] = (failed[r.reason] ?? 0) + 1; continue }
      requests++
      if (r.status === 'partial') partial++
      if (r.layaMs != null) layaMs.push(r.layaMs)
      if (r.colibriMs != null) colibriMs.push(r.colibriMs)
      for (const q of r.q) {
        const t = types[q.type]
        if (!t) continue
        if (q.raw) raw++
        if (q.unknown) unknown++
        // Confidence as each served it, where it served one: colibri's nouls are left out. The two are
        // not one scale: laya.serve's is normalised entropy (4.3) and colibri's (n * peak - 1) / (n - 1),
        // so the same answer reads 0.531 from laya.serve and 0.8 from colibri at 0.9 and 0.1.
        if (q.lc != null) t.layaConfidence.push(q.lc)
        if (q.cc != null) t.colibriConfidence.push(q.cc)
        if (q.agree == null) continue
        questions++
        t.compared++
        if (q.agree) t.agreed++
        if (q.gap != null) t.gaps.push(q.gap)
      }
    }
    const each = (f) => Object.fromEntries(Object.entries(types).map(([k, t]) => [k, f(t, k)]))
    const mine = ready.address === at
    return {
      provider: COLIBRI,
      used: false,
      address: at,
      on: !!at,
      file: basename(file),
      reachable: {
        ok: mine ? ready.ok : null, why: mine ? ready.why : null, checkedAt: mine && ready.at != null ? new Date(ready.at).toISOString() : null,
        ms: mine ? ready.ms : null, model: mine ? ready.model : null, checking: probing, how: HOW_READY,
      },
      compared: { requests, partial, questions, since: rows[0]?.ts ?? null },
      failed,
      dropped: { ...dropped },
      agreement: each((t, k) => ({ compared: t.compared, agreed: t.agreed, ...(k === 'score' ? { tolerance: SCORE_TOLERANCE } : {}) })),
      gap: each((t) => mean(t.gaps)),
      medianMs: { laya: median(layaMs), colibri: median(colibriMs) },
      confidence: each((t) => ({ laya: median(t.layaConfidence), colibri: median(t.colibriConfidence) })),
      rawNouls: raw,
      confidenceUnknown: unknown,
    }
  }

  return {
    offer,
    check,
    summary,
    /** A request to colibri is on its way. */
    busy: () => !!slot,
    /** Nothing new starts, the request on its way is abandoned with its socket, and this resolves once nothing more is written. */
    dispose() {
      disposed = true
      closing.abort()
      return Promise.resolve(slot).then(() => saving)
    },
  }
}
